package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const MaxCLIOutputBytes = 1024 * 1024
const CommandWaitDelay = 3 * time.Second

type Runner interface {
	Run(ctx context.Context, request Request, prompt string) (Plan, error)
}

type NotImplementedRunner struct{}

func (NotImplementedRunner) Run(ctx context.Context, request Request, prompt string) (Plan, error) {
	return Plan{}, BridgeError{Kind: "cli-not-implemented", Err: errors.New("local CLI runner is not implemented yet")}
}

type BridgeError struct {
	Kind string
	Err  error
}

func (error BridgeError) Error() string {
	return error.Err.Error()
}

func (error BridgeError) Unwrap() error {
	return error.Err
}

type CommandRunner interface {
	Run(ctx context.Context, spec CommandSpec) (CommandResult, error)
}

type CommandSpec struct {
	Executable string
	Args       []string
	Stdin      string
	Dir        string
}

type CommandResult struct {
	Stdout string
	Stderr string
}

type ExecCommandRunner struct{}

func (ExecCommandRunner) Run(ctx context.Context, spec CommandSpec) (CommandResult, error) {
	if _, err := exec.LookPath(spec.Executable); err != nil {
		return CommandResult{}, BridgeError{
			Kind: "cli-not-found",
			Err:  fmt.Errorf("%s executable was not found", spec.Executable),
		}
	}

	command := exec.CommandContext(ctx, spec.Executable, spec.Args...)
	command.Dir = spec.Dir
	command.Stdin = strings.NewReader(spec.Stdin)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return nil
		}
		return err
	}
	command.WaitDelay = CommandWaitDelay
	stdout := newCappedBuffer(MaxCLIOutputBytes)
	stderr := newCappedBuffer(MaxCLIOutputBytes)
	command.Stdout = &stdout
	command.Stderr = &stderr

	err := command.Run()
	result := CommandResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return result, BridgeError{
			Kind: "cli-timeout",
			Err:  fmt.Errorf("%s timed out", spec.Executable),
		}
	}
	if stdout.Exceeded() || stderr.Exceeded() {
		return result, BridgeError{
			Kind: "cli-error",
			Err:  fmt.Errorf("%s output exceeded %d bytes", spec.Executable, MaxCLIOutputBytes),
		}
	}
	return result, err
}

type cappedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

func newCappedBuffer(limit int) cappedBuffer {
	return cappedBuffer{limit: limit}
}

func (buffer *cappedBuffer) Write(chunk []byte) (int, error) {
	remaining := buffer.limit - buffer.buffer.Len()
	if remaining > 0 {
		if len(chunk) <= remaining {
			_, _ = buffer.buffer.Write(chunk)
		} else {
			_, _ = buffer.buffer.Write(chunk[:remaining])
			buffer.exceeded = true
		}
	} else if len(chunk) > 0 {
		buffer.exceeded = true
	}
	return len(chunk), nil
}

func (buffer *cappedBuffer) String() string {
	return buffer.buffer.String()
}

func (buffer *cappedBuffer) Exceeded() bool {
	return buffer.exceeded
}

func withTimeout(parent context.Context, timeoutMS int) (context.Context, context.CancelFunc) {
	timeout := time.Duration(timeoutMS) * time.Millisecond
	return context.WithTimeout(parent, timeout)
}
