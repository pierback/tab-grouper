package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const planSchemaJSON = `{"type":"object","properties":{"groups":{"type":"array","maxItems":40,"items":{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":32},"color":{"type":"string","enum":["grey","blue","red","yellow","green","pink","purple","cyan","orange"]},"tabIds":{"type":"array","minItems":1,"maxItems":300,"items":{"type":"integer"}}},"required":["name","color","tabIds"],"additionalProperties":false}},"assignments":{"type":"array","maxItems":100,"items":{"type":"object","properties":{"groupId":{"type":"integer"},"tabIds":{"type":"array","minItems":1,"maxItems":300,"items":{"type":"integer"}}},"required":["groupId","tabIds"],"additionalProperties":false}}},"required":["groups","assignments"],"additionalProperties":false}`
const CLIStatusTimeout = 3 * time.Second
const CLIModelsTimeout = 5 * time.Second

var ansiEscapePattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]`)

type CLIRunner struct {
	Commands         CommandRunner
	CodexExecutable  string
	ClaudeExecutable string
	LockExecutables  bool
}

func NewCLIRunner() CLIRunner {
	return CLIRunner{
		Commands:         ExecCommandRunner{},
		CodexExecutable:  "codex",
		ClaudeExecutable: "claude",
	}
}

func (runner CLIRunner) Status(ctx context.Context, request Request) (Status, error) {
	runner = runner.withDefaults()
	executable := runner.executableForProvider(request.Provider)
	status := Status{
		Provider:            "local-" + request.Provider + "-cli",
		Configured:          executable != "",
		ExecutableAvailable: executable != "" && executableIsAvailable(executable),
		LockExecutables:     runner.LockExecutables,
	}
	if !status.ExecutableAvailable {
		return status, nil
	}

	spec, err := runner.buildStatusCommandSpec(request.Provider, executable)
	if err != nil {
		return Status{}, err
	}
	statusCtx, cancel := context.WithTimeout(ctx, CLIStatusTimeout)
	defer cancel()
	result, err := runner.Commands.Run(statusCtx, spec)
	status.AuthChecked = true
	status.Authenticated = parseAuthStatus(request.Provider, result, err)
	if errors.Is(statusCtx.Err(), context.DeadlineExceeded) {
		return Status{}, BridgeError{
			Kind: "cli-timeout",
			Err:  fmt.Errorf("%s auth status timed out", request.Provider),
		}
	}
	return status, nil
}

func (runner CLIRunner) ListModels(ctx context.Context, request Request) ([]ModelInfo, error) {
	runner = runner.withDefaults()
	if request.Provider != "codex" {
		return nil, BridgeError{
			Kind: "cli-not-implemented",
			Err:  fmt.Errorf("%s model listing is not implemented", request.Provider),
		}
	}
	if runner.CodexExecutable == "" {
		return nil, BridgeError{
			Kind: "cli-not-found",
			Err:  errors.New("codex executable was not configured"),
		}
	}

	modelsCtx, cancel := context.WithTimeout(ctx, CLIModelsTimeout)
	defer cancel()
	result, err := runner.Commands.Run(modelsCtx, CommandSpec{
		Executable: runner.CodexExecutable,
		Args:       []string{"debug", "models"},
	})
	if errors.Is(modelsCtx.Err(), context.DeadlineExceeded) {
		return nil, BridgeError{
			Kind: "cli-timeout",
			Err:  fmt.Errorf("%s model listing timed out", request.Provider),
		}
	}
	if err != nil {
		return nil, classifyCLIError(request.Provider, result, err)
	}
	return parseCodexModels(result.Stdout)
}

func (runner CLIRunner) Run(ctx context.Context, request Request, prompt string) (Plan, error) {
	runner = runner.withDefaults()

	tempDir, err := os.MkdirTemp("", "tab-grouper-native-*")
	if err != nil {
		return Plan{}, BridgeError{Kind: "native-host-protocol-error", Err: err}
	}
	defer os.RemoveAll(tempDir)

	schemaPath := filepath.Join(tempDir, "tab-group-plan.schema.json")
	if err := os.WriteFile(schemaPath, []byte(planSchemaJSON), 0600); err != nil {
		return Plan{}, BridgeError{Kind: "native-host-protocol-error", Err: err}
	}

	spec, outputPath, err := runner.buildCommandSpec(request, prompt, tempDir, schemaPath)
	if err != nil {
		return Plan{}, err
	}

	result, err := runner.Commands.Run(ctx, spec)
	var codexUsage *Usage
	if request.Provider == "codex" {
		attemptedToolUse, usage := scanCodexJSONL(result.Stdout)
		if attemptedToolUse {
			return Plan{}, BridgeError{
				Kind: "cli-blocked-tool-use",
				Err:  errors.New("codex CLI attempted a disallowed action; its response was rejected"),
			}
		}
		codexUsage = usage
	}
	if request.Provider == "claude" {
		return ParseClaudeResultEnvelope(result, err, request)
	}

	if err != nil {
		return Plan{}, classifyCLIError(request.Provider, result, err)
	}

	outputText := result.Stdout
	if request.Provider == "codex" {
		outputText = ""
	}
	if outputPath != "" {
		bytes, readErr := readSmallFile(outputPath, MaxCLIOutputBytes)
		if readErr != nil {
			return Plan{}, readErr
		}
		if strings.TrimSpace(string(bytes)) != "" {
			outputText = string(bytes)
		}
	}

	plan, err := ParsePlanText(outputText, request)
	if err != nil {
		return Plan{}, err
	}
	if codexUsage != nil {
		plan.Usage = codexUsage
	}
	return plan, nil
}

func parseCodexModels(output string) ([]ModelInfo, error) {
	var payload struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Visibility  string `json:"visibility"`
		} `json:"models"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &payload); err != nil {
		return nil, BridgeError{
			Kind: "malformed-output",
			Err:  fmt.Errorf("codex CLI returned invalid models JSON: %w", err),
		}
	}

	models := []ModelInfo{}
	for _, model := range payload.Models {
		if model.Visibility != "list" || model.Slug == "" {
			continue
		}
		displayName := model.DisplayName
		if displayName == "" {
			displayName = model.Slug
		}
		models = append(models, ModelInfo{
			Slug:        model.Slug,
			DisplayName: displayName,
		})
	}
	return models, nil
}

func (runner CLIRunner) buildCommandSpec(request Request, prompt string, tempDir string, schemaPath string) (CommandSpec, string, error) {
	switch request.Provider {
	case "codex":
		if runner.CodexExecutable == "" {
			return CommandSpec{}, "", BridgeError{
				Kind: "cli-not-found",
				Err:  errors.New("codex executable was not configured"),
			}
		}
		outputPath := filepath.Join(tempDir, "codex-last-message.json")
		args := []string{
			"--ask-for-approval", "never",
			"exec",
			"--sandbox", "read-only",
			"--skip-git-repo-check",
			"--ephemeral",
			"--ignore-rules",
			"--color", "never",
			"--json",
			"-c", "model_reasoning_effort=\"low\"",
			"--cd", tempDir,
			"--output-schema", schemaPath,
			"--output-last-message", outputPath,
		}
		if request.Model != "" {
			args = append(args, "-m", request.Model)
		}
		args = append(args, "-")
		return CommandSpec{
			Executable: runner.CodexExecutable,
			Args:       args,
			Stdin:      prompt,
			Dir:        tempDir,
		}, outputPath, nil
	case "claude":
		if runner.ClaudeExecutable == "" {
			return CommandSpec{}, "", BridgeError{
				Kind: "cli-not-found",
				Err:  errors.New("claude executable was not configured"),
			}
		}
		args := []string{
			"--print",
			"--input-format", "text",
			"--output-format", "json",
			"--permission-mode", "dontAsk",
			"--tools", "",
			"--effort", "low",
			"--safe-mode",
			"--no-session-persistence",
			"--no-chrome",
			"--json-schema", planSchemaJSON,
		}
		if request.Model != "" {
			args = append(args, "--model", request.Model)
		}
		return CommandSpec{
			Executable: runner.ClaudeExecutable,
			Args:       args,
			Stdin:      prompt,
			Dir:        tempDir,
		}, "", nil
	default:
		return CommandSpec{}, "", BridgeError{
			Kind: "native-host-protocol-error",
			Err:  fmt.Errorf("unsupported provider: %s", request.Provider),
		}
	}
}

func (runner CLIRunner) buildStatusCommandSpec(provider string, executable string) (CommandSpec, error) {
	switch provider {
	case "codex":
		return CommandSpec{
			Executable: executable,
			Args:       []string{"login", "status"},
		}, nil
	case "claude":
		return CommandSpec{
			Executable: executable,
			Args:       []string{"auth", "status", "--json"},
		}, nil
	default:
		return CommandSpec{}, BridgeError{
			Kind: "native-host-protocol-error",
			Err:  fmt.Errorf("unsupported provider: %s", provider),
		}
	}
}

func classifyCLIError(provider string, result CommandResult, err error) error {
	var bridgeError BridgeError
	if errors.As(err, &bridgeError) {
		return err
	}

	detail := strings.TrimSpace(strings.Join([]string{err.Error(), result.Stderr, result.Stdout}, "\n"))
	if looksLikeAuthError(detail) {
		return BridgeError{
			Kind: "cli-auth-missing",
			Err:  fmt.Errorf("%s CLI is not signed in", provider),
		}
	}
	return BridgeError{
		Kind: "cli-error",
		Err:  fmt.Errorf("%s CLI failed", provider),
	}
}

func parseAuthStatus(provider string, result CommandResult, err error) bool {
	text := strings.TrimSpace(strings.Join([]string{result.Stdout, result.Stderr}, "\n"))
	if err != nil {
		return false
	}
	switch provider {
	case "codex":
		lower := strings.ToLower(text)
		return strings.Contains(lower, "logged in") && !strings.Contains(lower, "not logged in")
	case "claude":
		var payload struct {
			LoggedIn bool `json:"loggedIn"`
		}
		return json.Unmarshal([]byte(result.Stdout), &payload) == nil && payload.LoggedIn
	default:
		return false
	}
}

func looksLikeAuthError(text string) bool {
	lower := strings.ToLower(text)
	for _, needle := range []string{
		"not logged in",
		"not signed in",
		"login required",
		"authentication required",
		"authenticate",
		"unauthorized",
		"api key",
		"anthropic_api_key",
	} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

func scanCodexJSONL(output string) (bool, *Usage) {
	scanner := bufio.NewScanner(strings.NewReader(output))
	scanner.Buffer(make([]byte, 0, 64*1024), MaxCLIOutputBytes)
	var usage *Usage
	for scanner.Scan() {
		var event struct {
			Type string `json:"type"`
			Item struct {
				Type string `json:"type"`
			} `json:"item"`
			Usage struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}
		switch event.Type {
		case "item.started", "item.updated", "item.completed":
			if event.Item.Type == "command_execution" || event.Item.Type == "file_change" {
				return true, usage
			}
		case "turn.completed":
			if event.Usage.InputTokens > 0 || event.Usage.OutputTokens > 0 {
				usage = &Usage{
					InputTokens:  event.Usage.InputTokens,
					OutputTokens: event.Usage.OutputTokens,
				}
			}
		}
	}
	return false, usage
}

func readSmallFile(filePath string, limit int) ([]byte, error) {
	file, err := os.Open(filePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, BridgeError{Kind: "cli-error", Err: fmt.Errorf("failed to read local CLI output")}
	}
	defer file.Close()

	reader := io.LimitReader(file, int64(limit)+1)
	bytes, err := io.ReadAll(reader)
	if err != nil {
		return nil, BridgeError{Kind: "cli-error", Err: fmt.Errorf("failed to read local CLI output")}
	}
	if len(bytes) > limit {
		return nil, BridgeError{Kind: "malformed-output", Err: fmt.Errorf("local CLI output exceeded %d bytes", limit)}
	}
	return bytes, nil
}

func ParsePlanText(text string, request Request) (Plan, error) {
	objectText, err := extractJSONObject(text)
	if err != nil {
		return Plan{}, BridgeError{Kind: "malformed-output", Err: err}
	}

	var plan Plan
	if err := json.Unmarshal([]byte(objectText), &plan); err != nil {
		return Plan{}, BridgeError{
			Kind: "malformed-output",
			Err:  fmt.Errorf("local CLI returned invalid tab group JSON: %w", err),
		}
	}

	return normalizePlan(plan, request), nil
}

func ParseClaudeResultEnvelope(result CommandResult, runErr error, request Request) (Plan, error) {
	var bridgeError BridgeError
	if errors.As(runErr, &bridgeError) {
		// The command runner already made a confident, specific classification
		// (e.g. cli-timeout) - trust it rather than attempt to parse whatever
		// partial stdout exists.
		return Plan{}, runErr
	}

	var envelope struct {
		Type             string          `json:"type"`
		Subtype          string          `json:"subtype"`
		IsError          bool            `json:"is_error"`
		Result           string          `json:"result"`
		TotalCostUSD     *float64        `json:"total_cost_usd"`
		StructuredOutput json.RawMessage `json:"structured_output"`
		Usage            struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(result.Stdout)), &envelope); err != nil {
		// stdout was not a parseable envelope at all - e.g. the process crashed
		// or was killed before printing anything. Fall back to the generic
		// process-error classifier rather than a bare parse-failure message.
		if runErr != nil {
			return Plan{}, classifyCLIError(request.Provider, result, runErr)
		}
		return Plan{}, BridgeError{
			Kind: "malformed-output",
			Err:  fmt.Errorf("claude CLI returned invalid result JSON: %w", err),
		}
	}
	if envelope.IsError || envelope.Subtype != "success" {
		detail := strings.TrimSpace(strings.Join([]string{envelope.Result, result.Stderr}, "\n"))
		if looksLikeAuthError(detail) {
			return Plan{}, BridgeError{
				Kind: "cli-auth-missing",
				Err:  fmt.Errorf("%s CLI is not signed in", request.Provider),
			}
		}
		message := strings.TrimSpace(envelope.Result)
		if message == "" {
			message = fmt.Sprintf("%s CLI failed", request.Provider)
		}
		return Plan{}, BridgeError{
			Kind: "cli-error",
			Err:  errors.New(message),
		}
	}

	usage := usageFromClaudeEnvelope(envelope.Usage.InputTokens, envelope.Usage.OutputTokens, envelope.TotalCostUSD)
	if len(envelope.StructuredOutput) > 0 && string(envelope.StructuredOutput) != "null" {
		var plan Plan
		if err := json.Unmarshal(envelope.StructuredOutput, &plan); err != nil {
			return Plan{}, BridgeError{
				Kind: "malformed-output",
				Err:  fmt.Errorf("claude CLI returned invalid structured output: %w", err),
			}
		}
		plan = normalizePlan(plan, request)
		plan.Usage = usage
		return plan, nil
	}

	plan, err := ParsePlanText(envelope.Result, request)
	if err != nil {
		return Plan{}, err
	}
	plan.Usage = usage
	return plan, nil
}

func usageFromClaudeEnvelope(inputTokens int, outputTokens int, totalCostUSD *float64) *Usage {
	if inputTokens == 0 && outputTokens == 0 && totalCostUSD == nil {
		return nil
	}
	return &Usage{
		InputTokens:  inputTokens,
		OutputTokens: outputTokens,
		CostUsd:      totalCostUSD,
	}
}

func (runner CLIRunner) withDefaults() CLIRunner {
	if runner.Commands == nil {
		runner.Commands = ExecCommandRunner{}
	}
	if !runner.LockExecutables && runner.CodexExecutable == "" {
		runner.CodexExecutable = "codex"
	}
	if !runner.LockExecutables && runner.ClaudeExecutable == "" {
		runner.ClaudeExecutable = "claude"
	}
	return runner
}

func (runner CLIRunner) executableForProvider(provider string) string {
	if provider == "codex" {
		return runner.CodexExecutable
	}
	if provider == "claude" {
		return runner.ClaudeExecutable
	}
	return ""
}

func executableIsAvailable(executable string) bool {
	_, err := exec.LookPath(executable)
	return err == nil
}

func extractJSONObject(text string) (string, error) {
	cleaned := strings.TrimSpace(ansiEscapePattern.ReplaceAllString(text, ""))
	if cleaned == "" {
		return "", errors.New("local CLI returned no output")
	}

	if strings.HasPrefix(cleaned, "```") {
		if newline := strings.Index(cleaned, "\n"); newline >= 0 {
			cleaned = strings.TrimSpace(cleaned[newline+1:])
		}
		if fence := strings.LastIndex(cleaned, "```"); fence >= 0 {
			cleaned = strings.TrimSpace(cleaned[:fence])
		}
	}

	if json.Valid([]byte(cleaned)) {
		return cleaned, nil
	}

	start := strings.Index(cleaned, "{")
	if start < 0 {
		return "", errors.New("local CLI output did not contain JSON")
	}

	depth := 0
	inString := false
	escaped := false
	for index := start; index < len(cleaned); index++ {
		char := cleaned[index]
		if inString {
			if escaped {
				escaped = false
				continue
			}
			if char == '\\' {
				escaped = true
				continue
			}
			if char == '"' {
				inString = false
			}
			continue
		}

		switch char {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				candidate := cleaned[start : index+1]
				if json.Valid([]byte(candidate)) {
					return candidate, nil
				}
				return "", errors.New("local CLI output contained malformed JSON")
			}
		}
	}

	return "", errors.New("local CLI output contained incomplete JSON")
}

func normalizePlan(plan Plan, request Request) Plan {
	availableIDs := map[int]bool{}
	for _, tab := range request.Tabs {
		availableIDs[tab.ID] = true
	}
	existingGroupIDs := map[int]bool{}
	for _, group := range request.ExistingGroups {
		existingGroupIDs[group.ID] = true
	}

	usedIDs := map[int]bool{}
	groups := []PlanGroup{}
	for _, group := range plan.Groups {
		if len(groups) >= 40 {
			break
		}

		groupSeen := map[int]bool{}
		tabIDs := []int{}
		for _, tabID := range group.TabIDs {
			if !availableIDs[tabID] || usedIDs[tabID] || groupSeen[tabID] {
				continue
			}
			groupSeen[tabID] = true
			tabIDs = append(tabIDs, tabID)
		}

		if len(tabIDs) < request.MinimumGroupSize {
			continue
		}

		for _, tabID := range tabIDs {
			usedIDs[tabID] = true
		}

		groups = append(groups, PlanGroup{
			Name:   normalizePlanName(group.Name, fmt.Sprintf("Group %d", len(groups)+1)),
			Color:  normalizePlanColor(group.Color, len(groups)),
			TabIDs: tabIDs,
		})
	}

	assignments := []PlanAssignment{}
	for _, assignment := range plan.Assignments {
		if len(assignments) >= 100 {
			break
		}
		if !existingGroupIDs[assignment.GroupID] {
			continue
		}

		assignmentSeen := map[int]bool{}
		tabIDs := []int{}
		for _, tabID := range assignment.TabIDs {
			if !availableIDs[tabID] || usedIDs[tabID] || assignmentSeen[tabID] {
				continue
			}
			assignmentSeen[tabID] = true
			tabIDs = append(tabIDs, tabID)
		}

		if len(tabIDs) == 0 {
			continue
		}

		for _, tabID := range tabIDs {
			usedIDs[tabID] = true
		}

		assignments = append(assignments, PlanAssignment{
			GroupID: assignment.GroupID,
			TabIDs:  tabIDs,
		})
	}

	return Plan{Groups: groups, Assignments: assignments, Usage: plan.Usage}
}

func normalizePlanName(value string, fallback string) string {
	parts := strings.Fields(value)
	if len(parts) == 0 {
		return fallback
	}
	text := strings.Join(parts, " ")
	if len(text) > 32 {
		return text[:32]
	}
	return text
}

func normalizePlanColor(value string, index int) string {
	for _, color := range []string{"grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"} {
		if value == color {
			return value
		}
	}
	usable := []string{"blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"}
	return usable[index%len(usable)]
}
