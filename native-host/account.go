package main

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Account describes the signed-in CLI account. It never carries credentials.
type Account struct {
	AuthMethod string `json:"authMethod,omitempty"`
	Plan       string `json:"plan,omitempty"`
	Email      string `json:"email,omitempty"`
}

const maxAuthFileBytes = 256 * 1024

func codexHomeDir() string {
	if home := os.Getenv("CODEX_HOME"); home != "" {
		return home
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(userHome, ".codex")
}

// readCodexAccount reads the plan from the id_token claims in Codex's auth.json.
// The token is only decoded, not verified: the result is display-only.
func readCodexAccount(codexHome string) *Account {
	if codexHome == "" {
		return nil
	}
	file, err := os.Open(filepath.Join(codexHome, "auth.json"))
	if err != nil {
		return nil
	}
	defer file.Close()
	var auth struct {
		AuthMode     string `json:"auth_mode"`
		OpenAIAPIKey string `json:"OPENAI_API_KEY"`
		Tokens       struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if err := json.NewDecoder(io.LimitReader(file, maxAuthFileBytes)).Decode(&auth); err != nil {
		return nil
	}

	account := &Account{AuthMethod: normalizeCodexAuthMode(auth.AuthMode, auth.OpenAIAPIKey != "")}
	var claims struct {
		Email string `json:"email"`
		Auth  struct {
			PlanType string `json:"chatgpt_plan_type"`
		} `json:"https://api.openai.com/auth"`
	}
	if decodeJWTPayload(auth.Tokens.IDToken, &claims) {
		account.Plan = claims.Auth.PlanType
		account.Email = claims.Email
	}
	if *account == (Account{}) {
		return nil
	}
	return account
}

func normalizeCodexAuthMode(mode string, hasAPIKey bool) string {
	switch strings.ToLower(mode) {
	case "chatgpt":
		return "chatgpt"
	case "apikey", "api_key":
		return "api-key"
	}
	if hasAPIKey {
		return "api-key"
	}
	return ""
}

func decodeJWTPayload(token string, target any) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return false
	}
	return json.Unmarshal(payload, target) == nil
}

func parseClaudeAccount(stdout string) *Account {
	var payload struct {
		LoggedIn         bool   `json:"loggedIn"`
		AuthMethod       string `json:"authMethod"`
		SubscriptionType string `json:"subscriptionType"`
		Email            string `json:"email"`
	}
	if json.Unmarshal([]byte(stdout), &payload) != nil || !payload.LoggedIn {
		return nil
	}
	return &Account{
		AuthMethod: payload.AuthMethod,
		Plan:       payload.SubscriptionType,
		Email:      payload.Email,
	}
}
