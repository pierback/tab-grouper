package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestLoadNativeHostConfigMissingFile(t *testing.T) {
	config, ok, err := LoadNativeHostConfig(filepath.Join(t.TempDir(), "missing.config.json"))
	if err != nil {
		t.Fatalf("LoadNativeHostConfig failed: %v", err)
	}
	if ok {
		t.Fatalf("expected missing config to report ok=false, got %#v", config)
	}
}

func TestLoadNativeHostConfig(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "host.config.json")
	if err := os.WriteFile(configPath, []byte(`{
		"version": 1,
		"lockExecutables": true,
		"codexExecutable": "/usr/local/bin/codex",
		"claudeExecutable": "/usr/local/bin/claude"
	}`), 0600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	config, ok, err := LoadNativeHostConfig(configPath)
	if err != nil {
		t.Fatalf("LoadNativeHostConfig failed: %v", err)
	}
	if !ok {
		t.Fatal("expected config to load")
	}
	if !config.LockExecutables || config.CodexExecutable != "/usr/local/bin/codex" || config.ClaudeExecutable != "/usr/local/bin/claude" {
		t.Fatalf("unexpected config: %#v", config)
	}
}

func TestLoadNativeHostConfigRejectsUnsupportedVersion(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "host.config.json")
	if err := os.WriteFile(configPath, []byte(`{"version":99}`), 0600); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}

	_, ok, err := LoadNativeHostConfig(configPath)
	if err == nil {
		t.Fatal("expected unsupported version error")
	}
	if !ok {
		t.Fatal("expected invalid existing config to report ok=true")
	}
}

func TestNewCLIRunnerFromConfigUsesPinnedPaths(t *testing.T) {
	commands := &recordingCommandRunner{
		writeCodexOutput: `{"groups":[{"name":"Pinned","color":"blue","tabIds":[1,2]}]}`,
	}
	runner := NewCLIRunnerFromConfig(NativeHostConfig{
		Version:          NativeHostConfigVersion,
		LockExecutables:  true,
		CodexExecutable:  "/opt/tab-grouper/codex",
		ClaudeExecutable: "/opt/tab-grouper/claude",
	})
	runner.Commands = commands

	_, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	spec := commands.lastSpec(t)
	if spec.Executable != "/opt/tab-grouper/codex" {
		t.Fatalf("expected pinned codex path, got %s", spec.Executable)
	}
}

func TestLockedCLIRunnerRejectsMissingPinnedProvider(t *testing.T) {
	runner := NewCLIRunnerFromConfig(NativeHostConfig{
		Version:          NativeHostConfigVersion,
		LockExecutables:  true,
		ClaudeExecutable: "/opt/tab-grouper/claude",
	})

	_, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	var bridgeError BridgeError
	if !errors.As(err, &bridgeError) {
		t.Fatalf("expected BridgeError, got %T: %v", err, err)
	}
	if bridgeError.Kind != "cli-not-found" {
		t.Fatalf("expected cli-not-found, got %s", bridgeError.Kind)
	}
}

func TestCLIRunnerStatusChecksPinnedExecutable(t *testing.T) {
	runner := NewCLIRunnerFromConfig(NativeHostConfig{
		Version:          NativeHostConfigVersion,
		LockExecutables:  true,
		CodexExecutable:  "/bin/sh",
		ClaudeExecutable: "/does/not/exist",
	})

	codexStatus, err := runner.Status(context.Background(), Request{Provider: "codex"})
	if err != nil {
		t.Fatalf("Status failed: %v", err)
	}
	if !codexStatus.Configured || !codexStatus.ExecutableAvailable || !codexStatus.LockExecutables {
		t.Fatalf("unexpected codex status: %#v", codexStatus)
	}

	claudeStatus, err := runner.Status(context.Background(), Request{Provider: "claude"})
	if err != nil {
		t.Fatalf("Status failed: %v", err)
	}
	if !claudeStatus.Configured || claudeStatus.ExecutableAvailable {
		t.Fatalf("unexpected claude status: %#v", claudeStatus)
	}
}

func TestCLIRunnerStatusChecksCodexAuth(t *testing.T) {
	commands := &recordingCommandRunner{
		result: CommandResult{Stdout: "Logged in using ChatGPT"},
	}
	runner := NewCLIRunnerFromConfig(NativeHostConfig{
		Version:         NativeHostConfigVersion,
		LockExecutables: true,
		CodexExecutable: "/bin/sh",
	})
	runner.Commands = commands

	status, err := runner.Status(context.Background(), Request{Provider: "codex"})
	if err != nil {
		t.Fatalf("Status failed: %v", err)
	}
	if !status.AuthChecked || !status.Authenticated {
		t.Fatalf("expected authenticated codex status, got %#v", status)
	}
	spec := commands.lastSpec(t)
	if spec.Executable != "/bin/sh" || !slices.Equal(spec.Args, []string{"login", "status"}) {
		t.Fatalf("unexpected status command: %#v", spec)
	}
}

func TestCLIRunnerStatusChecksClaudeAuth(t *testing.T) {
	commands := &recordingCommandRunner{
		result: CommandResult{Stdout: `{"loggedIn":false,"email":"private@example.com"}`},
	}
	runner := NewCLIRunnerFromConfig(NativeHostConfig{
		Version:          NativeHostConfigVersion,
		LockExecutables:  true,
		ClaudeExecutable: "/bin/sh",
	})
	runner.Commands = commands

	status, err := runner.Status(context.Background(), Request{Provider: "claude"})
	if err != nil {
		t.Fatalf("Status failed: %v", err)
	}
	if !status.AuthChecked || status.Authenticated {
		t.Fatalf("expected unauthenticated claude status, got %#v", status)
	}
	spec := commands.lastSpec(t)
	if spec.Executable != "/bin/sh" || !slices.Equal(spec.Args, []string{"auth", "status", "--json"}) {
		t.Fatalf("unexpected status command: %#v", spec)
	}
}
