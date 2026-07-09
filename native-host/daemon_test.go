package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestProxyStartsOneDaemonForSequentialConnections(t *testing.T) {
	tempDir := shortTempDir(t)
	socketPath := freeTCPAddr(t)
	lockPath := filepath.Join(tempDir, "tab-grouper-native-host.lock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	host := Host{Runner: fakeStatusRunner{status: Status{
		Provider:            "local-codex-cli",
		Configured:          true,
		ExecutableAvailable: true,
		AuthChecked:         true,
		Authenticated:       true,
		LockExecutables:     true,
	}}}
	var spawnCount atomic.Int64
	errCh := make(chan error, 1)
	config := proxyConfig{
		ExecutablePath: filepath.Join(tempDir, "tab-grouper-native-host"),
		Network:        "tcp",
		SocketPath:     socketPath,
		LockPath:       lockPath,
		LogPath:        filepath.Join(tempDir, "tab-grouper-native-host-daemon.log"),
		DialTimeout:    2 * time.Second,
		DialInterval:   10 * time.Millisecond,
		SpawnDaemon: func(executablePath string, logPath string) error {
			spawnCount.Add(1)
			go func() {
				errCh <- runDaemon(ctx, daemonConfig{
					Network:           "tcp",
					SocketPath:        socketPath,
					Host:              host,
					IdleTimeout:       time.Hour,
					IdleCheckInterval: 10 * time.Millisecond,
				})
			}()
			return nil
		},
	}

	for _, requestID := range []string{"status-1", "status-2"} {
		request := statusRequest(requestID)
		var output bytes.Buffer
		if err := runProxyOrStartDaemon(ctx, encodeRequestFrame(t, request), &output, config); err != nil {
			t.Fatalf("runProxyOrStartDaemon failed: %v", err)
		}
		response := decodeResponseFrame(t, output.Bytes())
		if !response.OK || response.RequestID != requestID {
			t.Fatalf("unexpected response: %#v", response)
		}
	}

	if got := spawnCount.Load(); got != 1 {
		t.Fatalf("expected one daemon spawn, got %d", got)
	}
	cancel()
	waitForDaemonExit(t, errCh)
}

func TestProxyResponseMatchesDirectHostHandle(t *testing.T) {
	tempDir := shortTempDir(t)
	socketPath := freeTCPAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	host := Host{Runner: fakeStatusRunner{status: Status{
		Provider:            "local-codex-cli",
		Configured:          true,
		ExecutableAvailable: true,
		AuthChecked:         true,
		Authenticated:       true,
		LockExecutables:     true,
	}}}
	errCh := make(chan error, 1)
	ready := make(chan struct{})
	go func() {
		errCh <- runDaemon(ctx, daemonConfig{
			Network:           "tcp",
			SocketPath:        socketPath,
			Host:              host,
			IdleTimeout:       time.Hour,
			IdleCheckInterval: 10 * time.Millisecond,
			Ready:             ready,
		})
	}()
	waitForDaemonReady(t, ready, errCh)

	request := statusRequest("status-direct")
	var output bytes.Buffer
	if err := runProxyOrStartDaemon(ctx, encodeRequestFrame(t, request), &output, proxyConfig{
		Network:      "tcp",
		SocketPath:   socketPath,
		LockPath:     filepath.Join(tempDir, "tab-grouper-native-host.lock"),
		DialTimeout:  200 * time.Millisecond,
		DialInterval: 10 * time.Millisecond,
	}); err != nil {
		t.Fatalf("runProxyOrStartDaemon failed: %v", err)
	}

	actual := decodeResponseFrame(t, output.Bytes())
	expected := host.Handle(ctx, request)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("proxy response did not match direct response:\nactual:   %#v\nexpected: %#v", actual, expected)
	}

	cancel()
	waitForDaemonExit(t, errCh)
}

func TestSpawnLockElectionAllowsOnlyOneConcurrentWinner(t *testing.T) {
	lockPath := filepath.Join(shortTempDir(t), "tab-grouper-native-host.lock")
	start := make(chan struct{})
	release := make(chan struct{})
	results := make(chan bool, 2)
	var winners atomic.Int64
	var attempts sync.WaitGroup
	attempts.Add(2)

	for i := 0; i < 2; i++ {
		go func() {
			defer attempts.Done()
			<-start
			file, acquired, err := tryAcquireSpawnLock(lockPath)
			if err != nil {
				t.Errorf("tryAcquireSpawnLock failed: %v", err)
				results <- false
				return
			}
			if acquired {
				winners.Add(1)
				results <- true
				<-release
				closeSpawnLock(file)
				return
			}
			results <- false
		}()
	}

	close(start)
	<-results
	<-results
	close(release)
	attempts.Wait()

	if got := winners.Load(); got != 1 {
		t.Fatalf("expected one lock winner, got %d", got)
	}
}

func TestNativeHostRuntimePathsUseShortHashedTempPaths(t *testing.T) {
	shortExecutablePath := filepath.Join("/tmp", "tab-grouper-native-host")
	longExecutablePath := filepath.Join(
		"/tmp",
		"tab-grouper-native-e2e-"+string(bytes.Repeat([]byte("x"), 80)),
		"nested",
		"tab-grouper-native-host",
	)

	shortPaths := nativeHostRuntimePaths(shortExecutablePath)
	longPaths := nativeHostRuntimePaths(longExecutablePath)

	for name, paths := range map[string]runtimePaths{
		"short": shortPaths,
		"long":  longPaths,
	} {
		if filepath.Dir(paths.SocketPath) != daemonRuntimeBaseDir {
			t.Fatalf("%s socket path is not under %s: %s", name, daemonRuntimeBaseDir, paths.SocketPath)
		}
		if filepath.Dir(paths.LockPath) != daemonRuntimeBaseDir {
			t.Fatalf("%s lock path is not under %s: %s", name, daemonRuntimeBaseDir, paths.LockPath)
		}
		if filepath.Dir(paths.LogPath) != daemonRuntimeBaseDir {
			t.Fatalf("%s log path is not under %s: %s", name, daemonRuntimeBaseDir, paths.LogPath)
		}
		if len(paths.SocketPath) >= 100 {
			t.Fatalf("%s socket path should stay safely below Unix socket limits, got %d: %s", name, len(paths.SocketPath), paths.SocketPath)
		}
	}
	if shortPaths == longPaths {
		t.Fatalf("different executable paths should produce independent runtime paths: %#v", shortPaths)
	}
	if repeat := nativeHostRuntimePaths(longExecutablePath); repeat != longPaths {
		t.Fatalf("runtime paths should be deterministic:\nfirst:  %#v\nrepeat: %#v", longPaths, repeat)
	}
}

func statusRequest(requestID string) Request {
	return Request{
		Version:   ProtocolVersion,
		Type:      RequestStatusType,
		RequestID: requestID,
		Provider:  "codex",
	}
}

func encodeRequestFrame(t *testing.T, request Request) *bytes.Reader {
	t.Helper()
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}
	frame := make([]byte, 4+len(payload))
	binary.LittleEndian.PutUint32(frame[:4], uint32(len(payload)))
	copy(frame[4:], payload)
	return bytes.NewReader(frame)
}

func decodeResponseFrame(t *testing.T, frame []byte) Response {
	t.Helper()
	if len(frame) < 4 {
		t.Fatalf("missing native response frame: %q", string(frame))
	}
	size := binary.LittleEndian.Uint32(frame[:4])
	if int(size) != len(frame)-4 {
		t.Fatalf("unexpected native response size: got %d bytes, frame has %d", size, len(frame)-4)
	}
	var response Response
	if err := json.Unmarshal(frame[4:], &response); err != nil {
		t.Fatalf("Unmarshal failed: %v", err)
	}
	return response
}

func waitForDaemonReady(t *testing.T, ready <-chan struct{}, errCh <-chan error) {
	t.Helper()
	select {
	case <-ready:
	case err := <-errCh:
		t.Fatalf("daemon exited before ready: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for daemon readiness")
	}
}

func waitForDaemonExit(t *testing.T, errCh <-chan error) {
	t.Helper()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("daemon exited with error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for daemon exit")
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/private/tmp", "tg-native-test-")
	if err != nil {
		t.Fatalf("MkdirTemp failed: %v", err)
	}
	t.Cleanup(func() {
		_ = os.RemoveAll(dir)
	})
	return dir
}

func freeTCPAddr(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			t.Skipf("local listener creation is not permitted in this sandbox: %v", err)
		}
		t.Fatalf("Listen failed: %v", err)
	}
	addr := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatalf("Close failed: %v", err)
	}
	return addr
}
