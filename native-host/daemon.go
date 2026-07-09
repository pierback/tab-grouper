package main

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	daemonArg                      = "--daemon"
	daemonRuntimeBaseDir           = "/tmp"
	daemonRuntimeFilePrefix        = "tab-grouper-native-host"
	backendUnavailableErrorKind    = "native-host-backend-unavailable"
	backendUnavailableErrorMessage = "Local backend did not become available in time."
	defaultDaemonDialTimeout       = 5 * time.Second
	defaultDaemonDialInterval      = 50 * time.Millisecond
	defaultDaemonIdleTimeout       = 30 * time.Minute
	defaultDaemonIdleCheckInterval = time.Minute
)

type runtimePaths struct {
	SocketPath string
	LockPath   string
	LogPath    string
}

type proxyConfig struct {
	ExecutablePath string
	Network        string
	SocketPath     string
	LockPath       string
	LogPath        string
	DialTimeout    time.Duration
	DialInterval   time.Duration
	SpawnDaemon    func(executablePath string, logPath string) error
}

type daemonConfig struct {
	Network           string
	SocketPath        string
	Host              Host
	IdleTimeout       time.Duration
	IdleCheckInterval time.Duration
	Ready             chan<- struct{}
}

func nativeHostRuntimePaths(executablePath string) runtimePaths {
	runtimeID := nativeHostRuntimeID(executablePath)
	baseName := daemonRuntimeFilePrefix + "-" + runtimeID
	return runtimePaths{
		SocketPath: filepath.Join(daemonRuntimeBaseDir, baseName+".sock"),
		LockPath:   filepath.Join(daemonRuntimeBaseDir, baseName+".lock"),
		LogPath:    filepath.Join(daemonRuntimeBaseDir, baseName+"-daemon.log"),
	}
}

func nativeHostRuntimeID(executablePath string) string {
	resolvedPath := executablePath
	if absolutePath, err := filepath.Abs(executablePath); err == nil {
		resolvedPath = absolutePath
		if evaluatedPath, err := filepath.EvalSymlinks(absolutePath); err == nil {
			resolvedPath = evaluatedPath
		}
	}
	digest := sha256.Sum256([]byte(resolvedPath))
	return hex.EncodeToString(digest[:])[:16]
}

func defaultProxyConfig(executablePath string, paths runtimePaths) proxyConfig {
	return proxyConfig{
		ExecutablePath: executablePath,
		Network:        "unix",
		SocketPath:     paths.SocketPath,
		LockPath:       paths.LockPath,
		LogPath:        paths.LogPath,
		DialTimeout:    defaultDaemonDialTimeout,
		DialInterval:   defaultDaemonDialInterval,
		SpawnDaemon:    spawnDetachedDaemon,
	}
}

func defaultDaemonConfig(socketPath string) daemonConfig {
	return daemonConfig{
		Network:           "unix",
		SocketPath:        socketPath,
		Host:              NewHost(),
		IdleTimeout:       durationFromEnv("TAB_GROUPER_NATIVE_HOST_IDLE_TIMEOUT_MS", defaultDaemonIdleTimeout),
		IdleCheckInterval: durationFromEnv("TAB_GROUPER_NATIVE_HOST_IDLE_CHECK_INTERVAL_MS", defaultDaemonIdleCheckInterval),
	}
}

func hasDaemonArg(args []string) bool {
	for _, arg := range args {
		if arg == daemonArg {
			return true
		}
	}
	return false
}

func runProxyOrStartDaemon(ctx context.Context, input io.Reader, output io.Writer, config proxyConfig) error {
	frame, request, err := readNativeRequestFrame(input)
	if err != nil {
		return fmt.Errorf("failed to read native request frame: %w", err)
	}

	network := networkOrUnix(config.Network)

	if conn, err := dialDaemon(ctx, network, config.SocketPath); err == nil {
		return proxyNativeFrame(conn, frame, output)
	}

	lockFile, acquired, err := tryAcquireSpawnLock(config.LockPath)
	if err != nil {
		return writeBackendUnavailable(output, request)
	}
	if acquired {
		defer closeSpawnLock(lockFile)

		if conn, err := dialDaemon(ctx, network, config.SocketPath); err == nil {
			closeSpawnLock(lockFile)
			lockFile = nil
			return proxyNativeFrame(conn, frame, output)
		}

		if network == "unix" {
			if err := os.Remove(config.SocketPath); err != nil && !errors.Is(err, os.ErrNotExist) {
				return writeBackendUnavailable(output, request)
			}
		}
		spawn := config.SpawnDaemon
		if spawn == nil {
			spawn = spawnDetachedDaemon
		}
		if err := spawn(config.ExecutablePath, config.LogPath); err != nil {
			return writeBackendUnavailable(output, request)
		}
	}

	conn, err := waitForDaemon(ctx, network, config.SocketPath, config.DialTimeout, config.DialInterval)
	if acquired {
		closeSpawnLock(lockFile)
		lockFile = nil
	}
	if err != nil {
		return writeBackendUnavailable(output, request)
	}
	return proxyNativeFrame(conn, frame, output)
}

func readNativeRequestFrame(reader io.Reader) ([]byte, Request, error) {
	frame, payload, err := readNativeFrame(reader, MaxRequestBytes)
	if err != nil {
		return nil, Request{}, err
	}
	var request Request
	_ = json.Unmarshal(payload, &request)
	return frame, request, nil
}

func readNativeFrame(reader io.Reader, maxBytes uint32) ([]byte, []byte, error) {
	var sizeBytes [4]byte
	if _, err := io.ReadFull(reader, sizeBytes[:]); err != nil {
		return nil, nil, err
	}
	size := binary.LittleEndian.Uint32(sizeBytes[:])
	if size == 0 || size > maxBytes {
		return nil, nil, fmt.Errorf("invalid native message size: %d", size)
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return nil, nil, err
	}
	frame := make([]byte, 4+len(payload))
	copy(frame[:4], sizeBytes[:])
	copy(frame[4:], payload)
	return frame, payload, nil
}

func proxyNativeFrame(conn net.Conn, requestFrame []byte, output io.Writer) error {
	defer conn.Close()
	if err := writeAll(conn, requestFrame); err != nil {
		return err
	}
	responseFrame, _, err := readNativeFrame(conn, MaxResponseBytes)
	if err != nil {
		return err
	}
	return writeAll(output, responseFrame)
}

func writeAll(writer io.Writer, bytes []byte) error {
	for len(bytes) > 0 {
		written, err := writer.Write(bytes)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		bytes = bytes[written:]
	}
	return nil
}

func dialDaemon(ctx context.Context, network string, socketPath string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, networkOrUnix(network), socketPath)
}

func waitForDaemon(ctx context.Context, network string, socketPath string, timeout time.Duration, interval time.Duration) (net.Conn, error) {
	if timeout <= 0 {
		timeout = defaultDaemonDialTimeout
	}
	if interval <= 0 {
		interval = defaultDaemonDialInterval
	}

	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		conn, err := dialDaemon(waitCtx, network, socketPath)
		if err == nil {
			return conn, nil
		}

		timer := time.NewTimer(interval)
		select {
		case <-waitCtx.Done():
			timer.Stop()
			return nil, waitCtx.Err()
		case <-timer.C:
		}
	}
}

func tryAcquireSpawnLock(lockPath string) (*os.File, bool, error) {
	file, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, false, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return file, true, nil
}

func closeSpawnLock(file *os.File) {
	if file == nil {
		return
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	_ = file.Close()
}

func spawnDetachedDaemon(executablePath string, logPath string) error {
	logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer logFile.Close()

	command := exec.Command(executablePath, daemonArg)
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return command.Start()
}

func writeBackendUnavailable(writer io.Writer, request Request) error {
	return WriteNativeMessage(writer, ErrorResponse(request, backendUnavailableErrorKind, errors.New(backendUnavailableErrorMessage)))
}

func runDaemon(ctx context.Context, config daemonConfig) error {
	if config.IdleTimeout <= 0 {
		config.IdleTimeout = defaultDaemonIdleTimeout
	}
	if config.IdleCheckInterval <= 0 {
		config.IdleCheckInterval = defaultDaemonIdleCheckInterval
	}

	network := networkOrUnix(config.Network)
	listener, err := net.Listen(network, config.SocketPath)
	if err != nil {
		return err
	}
	if network == "unix" {
		if err := os.Chmod(config.SocketPath, 0600); err != nil {
			_ = listener.Close()
			_ = os.Remove(config.SocketPath)
			return err
		}
	}
	if network == "unix" {
		defer os.Remove(config.SocketPath)
	}
	if config.Ready != nil {
		close(config.Ready)
	}

	host := config.Host
	if host.Runner == nil {
		host = NewHost()
	}
	var activeConnections atomic.Int64
	var lastActivity atomic.Int64
	lastActivity.Store(time.Now().UnixNano())

	log.Printf("native host daemon started on %s", config.SocketPath)
	go closeDaemonWhenIdle(ctx, listener, &activeConnections, &lastActivity, config.IdleTimeout, config.IdleCheckInterval)

	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) || ctx.Err() != nil {
				log.Printf("native host daemon stopped")
				return nil
			}
			return err
		}
		log.Printf("accepted native host backend connection")
		activeConnections.Add(1)
		lastActivity.Store(time.Now().UnixNano())
		go handleDaemonConnection(ctx, host, conn, &activeConnections, &lastActivity)
	}
}

func handleDaemonConnection(ctx context.Context, host Host, conn net.Conn, activeConnections *atomic.Int64, lastActivity *atomic.Int64) {
	defer conn.Close()
	defer func() {
		activeConnections.Add(-1)
		lastActivity.Store(time.Now().UnixNano())
	}()

	request, err := ReadNativeMessage(conn)
	if err != nil {
		log.Printf("failed to read daemon request: %v", err)
		return
	}
	response := host.Handle(ctx, request)
	if err := WriteNativeMessage(conn, response); err != nil {
		log.Printf("failed to write daemon response: %v", err)
	}
}

func closeDaemonWhenIdle(ctx context.Context, listener net.Listener, activeConnections *atomic.Int64, lastActivity *atomic.Int64, idleTimeout time.Duration, checkInterval time.Duration) {
	ticker := time.NewTicker(checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			_ = listener.Close()
			return
		case <-ticker.C:
			if activeConnections.Load() == 0 && time.Since(time.Unix(0, lastActivity.Load())) > idleTimeout {
				log.Printf("native host daemon idle for %s; shutting down", idleTimeout)
				_ = listener.Close()
				return
			}
		}
	}
}

func durationFromEnv(name string, fallback time.Duration) time.Duration {
	value := os.Getenv(name)
	if value == "" {
		return fallback
	}
	milliseconds, err := strconv.Atoi(value)
	if err != nil || milliseconds <= 0 {
		return fallback
	}
	return time.Duration(milliseconds) * time.Millisecond
}

func networkOrUnix(network string) string {
	if network == "" {
		return "unix"
	}
	return network
}
