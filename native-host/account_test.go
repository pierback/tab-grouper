package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return "e30." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func writeCodexAuth(t *testing.T, auth map[string]any) string {
	t.Helper()
	dir := t.TempDir()
	contents, err := json.Marshal(auth)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), contents, 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestReadCodexAccountExtractsPlanWithoutTokens(t *testing.T) {
	dir := writeCodexAuth(t, map[string]any{
		"auth_mode": "chatgpt",
		"tokens": map[string]any{
			"id_token":      fakeJWT(t, map[string]any{"email": "me@example.com", "https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "plus"}}),
			"access_token":  "secret-access",
			"refresh_token": "secret-refresh",
		},
	})

	account := readCodexAccount(dir)
	if account == nil || *account != (Account{AuthMethod: "chatgpt", Plan: "plus", Email: "me@example.com"}) {
		t.Fatalf("unexpected account: %#v", account)
	}
	encoded, _ := json.Marshal(account)
	if strings.Contains(string(encoded), "secret") {
		t.Fatalf("account leaks credentials: %s", encoded)
	}
}

func TestReadCodexAccountHandlesAPIKeyAndMissingFile(t *testing.T) {
	dir := writeCodexAuth(t, map[string]any{"OPENAI_API_KEY": "sk-test"})
	if account := readCodexAccount(dir); account == nil || *account != (Account{AuthMethod: "api-key"}) {
		t.Fatalf("unexpected api key account: %#v", account)
	}
	if account := readCodexAccount(t.TempDir()); account != nil {
		t.Fatalf("expected nil account without auth.json, got %#v", account)
	}
}

func TestParseClaudeAccount(t *testing.T) {
	account := parseClaudeAccount(`{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","email":"me@example.com","orgId":"x"}`)
	if account == nil || *account != (Account{AuthMethod: "claude.ai", Plan: "max", Email: "me@example.com"}) {
		t.Fatalf("unexpected account: %#v", account)
	}
	if parseClaudeAccount(`{"loggedIn":false}`) != nil {
		t.Fatal("expected nil account when logged out")
	}
}

func TestCLIRunnerStatusIncludesCodexAccount(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "codex")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	dir := writeCodexAuth(t, map[string]any{
		"auth_mode": "chatgpt",
		"tokens":    map[string]any{"id_token": fakeJWT(t, map[string]any{"https://api.openai.com/auth": map[string]any{"chatgpt_plan_type": "pro"}})},
	})
	runner := CLIRunner{
		Commands:        &recordingCommandRunner{result: CommandResult{Stdout: "Logged in using ChatGPT"}},
		CodexExecutable: executable,
		LockExecutables: true,
		CodexHome:       dir,
	}

	status, err := runner.Status(context.Background(), Request{Provider: "codex"})
	if err != nil {
		t.Fatal(err)
	}
	if !status.Authenticated || status.Account == nil || status.Account.Plan != "pro" {
		t.Fatalf("unexpected status: %#v", status)
	}
}
