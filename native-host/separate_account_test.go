package main

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestValidateRequestAccounts(t *testing.T) {
	separate := validRequest()
	separate.Account = AccountSeparate
	if err := ValidateRequest(separate); err != nil {
		t.Fatalf("separate codex account should be valid: %v", err)
	}

	claude := validRequest()
	claude.Provider = "claude"
	claude.Account = AccountSeparate
	if ValidateRequest(claude) == nil {
		t.Fatal("separate account must be rejected for claude")
	}

	unknown := validRequest()
	unknown.Account = "../../etc"
	if ValidateRequest(unknown) == nil {
		t.Fatal("unknown account must be rejected")
	}

	defaultLogin := Request{Version: ProtocolVersion, Type: RequestLoginType, RequestID: "login-1", Provider: "codex"}
	if ValidateRequest(defaultLogin) == nil {
		t.Fatal("login must never target the default ~/.codex account")
	}
	defaultLogin.Account = AccountSeparate
	if err := ValidateRequest(defaultLogin); err != nil {
		t.Fatalf("separate account login should be valid: %v", err)
	}
}

func newSeparateAccountRunner(t *testing.T, commands *recordingCommandRunner) (CLIRunner, string) {
	t.Helper()
	executable := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	separateHome := filepath.Join(t.TempDir(), "codex-tab-grouper")
	return CLIRunner{
		Commands:          commands,
		CodexExecutable:   executable,
		LockExecutables:   true,
		CodexHome:         t.TempDir(),
		SeparateCodexHome: separateHome,
	}, separateHome
}

func TestCLIRunnerUsesSeparateCodexHome(t *testing.T) {
	commands := &recordingCommandRunner{writeCodexOutput: `{"groups":[{"name":"Code","color":"blue","tabIds":[1,2]}],"assignments":[]}`}
	runner, separateHome := newSeparateAccountRunner(t, commands)
	request := validRequest()
	request.Account = AccountSeparate

	if _, err := runner.Run(context.Background(), request, "group these tabs"); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(commands.specs[0].Env, "CODEX_HOME="+separateHome) {
		t.Fatalf("exec should run with the separate CODEX_HOME, got %v", commands.specs[0].Env)
	}
	if info, err := os.Stat(separateHome); err != nil || info.Mode().Perm() != 0o700 {
		t.Fatalf("separate home should be created owner-only: %v %v", info, err)
	}

	defaultRequest := validRequest()
	if _, err := runner.Run(context.Background(), defaultRequest, "group these tabs"); err != nil {
		t.Fatal(err)
	}
	if len(commands.specs[1].Env) != 0 {
		t.Fatalf("default account should inherit the environment, got %v", commands.specs[1].Env)
	}
}

func TestCLIRunnerLoginAndLogoutUseSeparateHome(t *testing.T) {
	commands := &recordingCommandRunner{result: CommandResult{Stdout: "Logged in using ChatGPT"}}
	runner, separateHome := newSeparateAccountRunner(t, commands)
	request := Request{Version: ProtocolVersion, Type: RequestLoginType, RequestID: "login-1", Provider: "codex", Account: AccountSeparate}

	status, err := runner.Login(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Authenticated {
		t.Fatalf("expected signed-in status after login: %#v", status)
	}
	if !slices.Equal(commands.specs[0].Args, []string{"login"}) || !slices.Contains(commands.specs[0].Env, "CODEX_HOME="+separateHome) {
		t.Fatalf("unexpected login command: %#v", commands.specs[0])
	}

	if _, err := runner.Logout(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	logout := commands.specs[len(commands.specs)-2]
	if !slices.Equal(logout.Args, []string{"logout"}) || !slices.Contains(logout.Env, "CODEX_HOME="+separateHome) {
		t.Fatalf("unexpected logout command: %#v", logout)
	}

	request.Account = AccountDefault
	if _, err := runner.Login(context.Background(), request); err == nil {
		t.Fatal("login must refuse the default account")
	}
}
