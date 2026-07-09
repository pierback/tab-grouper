package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestCLIRunnerBuildsCodexExecCommand(t *testing.T) {
	commands := &recordingCommandRunner{
		writeCodexOutput: `{"groups":[{"name":"Codex GitHub","color":"blue","tabIds":[1,2]}]}`,
	}
	runner := CLIRunner{
		Commands:         commands,
		CodexExecutable:  "codex-test",
		ClaudeExecutable: "claude-test",
	}

	plan, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(plan.Groups) != 1 || plan.Groups[0].Name != "Codex GitHub" {
		t.Fatalf("unexpected plan: %#v", plan)
	}

	spec := commands.lastSpec(t)
	if spec.Executable != "codex-test" {
		t.Fatalf("unexpected executable: %s", spec.Executable)
	}
	if !slices.Equal(spec.Args[:3], []string{"--ask-for-approval", "never", "exec"}) {
		t.Fatalf("codex approval args must precede exec subcommand: %#v", spec.Args)
	}
	for _, expected := range []string{"exec", "--sandbox", "read-only", "--ask-for-approval", "never", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "--json", "-c", `model_reasoning_effort="low"`, "--output-schema", "--output-last-message", "-"} {
		if !slices.Contains(spec.Args, expected) {
			t.Fatalf("codex args missing %q: %#v", expected, spec.Args)
		}
	}
	if spec.Args[len(spec.Args)-1] != "-" {
		t.Fatalf("codex prompt should be read from stdin: %#v", spec.Args)
	}
	if spec.Stdin != "group these tabs" {
		t.Fatalf("prompt was not sent on stdin")
	}
}

func TestCLIRunnerRejectsCodexToolUseEvent(t *testing.T) {
	commands := &recordingCommandRunner{
		result:           CommandResult{Stdout: `{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}`},
		writeCodexOutput: `{"groups":[{"name":"Should Reject","color":"blue","tabIds":[1,2]}]}`,
	}
	runner := CLIRunner{
		Commands:         commands,
		CodexExecutable:  "codex-test",
		ClaudeExecutable: "claude-test",
	}

	_, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	assertBridgeErrorKind(t, err, "cli-blocked-tool-use")
}

func TestCLIRunnerRejectsCodexToolUseEventEvenOnNonzeroExit(t *testing.T) {
	commands := &recordingCommandRunner{
		result: CommandResult{Stdout: `{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}`},
		err:    errors.New("exit status 1"),
	}
	runner := CLIRunner{
		Commands:         commands,
		CodexExecutable:  "codex-test",
		ClaudeExecutable: "claude-test",
	}

	_, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	assertBridgeErrorKind(t, err, "cli-blocked-tool-use")
}

func TestCLIRunnerParsesCodexPlanWithBenignJSONLEvents(t *testing.T) {
	commands := &recordingCommandRunner{
		result: CommandResult{Stdout: strings.Join([]string{
			`{"type":"thread.started","thread_id":"thread-1"}`,
			`{"type":"turn.started"}`,
			`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\"groups\":[{\"name\":\"Docs\",\"color\":\"green\",\"tabIds\":[1,2]}]}"}}`,
			`{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}`,
		}, "\n")},
		writeCodexOutput: `{"groups":[{"name":"Docs","color":"green","tabIds":[1,2]}]}`,
	}
	runner := CLIRunner{
		Commands:         commands,
		CodexExecutable:  "codex-test",
		ClaudeExecutable: "claude-test",
	}

	plan, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(plan.Groups) != 1 || plan.Groups[0].Name != "Docs" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
}

func TestCLIRunnerBuildsClaudePrintCommand(t *testing.T) {
	request := validRequest()
	request.Provider = "claude"
	commands := &recordingCommandRunner{
		result: CommandResult{Stdout: "```json\n{\"groups\":[{\"name\":\"Docs\",\"color\":\"green\",\"tabIds\":[1,2]}]}\n```"},
	}
	runner := CLIRunner{
		Commands:         commands,
		CodexExecutable:  "codex-test",
		ClaudeExecutable: "claude-test",
	}

	plan, err := runner.Run(context.Background(), request, "group these tabs")
	if err != nil {
		t.Fatalf("Run failed: %v", err)
	}
	if len(plan.Groups) != 1 || plan.Groups[0].Name != "Docs" {
		t.Fatalf("unexpected plan: %#v", plan)
	}

	spec := commands.lastSpec(t)
	if spec.Executable != "claude-test" {
		t.Fatalf("unexpected executable: %s", spec.Executable)
	}
	for _, expected := range []string{"--print", "--input-format", "text", "--output-format", "--permission-mode", "dontAsk", "--tools", "", "--effort", "low", "--safe-mode", "--no-session-persistence", "--no-chrome", "--json-schema"} {
		if !slices.Contains(spec.Args, expected) {
			t.Fatalf("claude args missing %q: %#v", expected, spec.Args)
		}
	}
}

func TestParsePlanTextNormalizesUnsafeGroups(t *testing.T) {
	request := validRequest()
	request.Tabs = append(request.Tabs, Tab{ID: 3, Title: "Docs", Domain: "developer.chrome.com"})

	plan, err := ParsePlanText(`Here is the plan:
{"groups":[
  {"name":"  Very   Long   Group   Name   That   Gets   Truncated  ","color":"chartreuse","tabIds":[1,2,2,999]},
  {"name":"Singleton","color":"red","tabIds":[3]},
  {"name":"Duplicates","color":"blue","tabIds":[1,3]}
]}`, request)
	if err != nil {
		t.Fatalf("ParsePlanText failed: %v", err)
	}
	if len(plan.Groups) != 1 {
		t.Fatalf("expected one normalized group, got %#v", plan.Groups)
	}
	group := plan.Groups[0]
	if group.Name != "Very Long Group Name That Gets T" {
		t.Fatalf("unexpected normalized name: %q", group.Name)
	}
	if group.Color != "blue" {
		t.Fatalf("unexpected fallback color: %s", group.Color)
	}
	if !slices.Equal(group.TabIDs, []int{1, 2}) {
		t.Fatalf("unexpected tab ids: %#v", group.TabIDs)
	}
}

func TestParsePlanTextKeepsMoreThanOldGroupLimit(t *testing.T) {
	request := validRequest()
	request.Tabs = []Tab{}
	groups := make([]PlanGroup, 20)
	for index := range groups {
		tabID := index + 1
		request.Tabs = append(request.Tabs, Tab{ID: tabID, Title: "Tab", Domain: "example.com"})
		groups[index] = PlanGroup{
			Name:   "Group",
			Color:  "blue",
			TabIDs: []int{tabID},
		}
	}
	request.MinimumGroupSize = 1
	payload, err := json.Marshal(Plan{Groups: groups})
	if err != nil {
		t.Fatalf("Marshal failed: %v", err)
	}

	plan, err := ParsePlanText(string(payload), request)
	if err != nil {
		t.Fatalf("ParsePlanText failed: %v", err)
	}
	if len(plan.Groups) != 20 {
		t.Fatalf("expected 20 groups, got %d", len(plan.Groups))
	}
}

func TestParsePlanTextNormalizesAssignments(t *testing.T) {
	request := validRequest()
	request.Tabs = append(request.Tabs,
		Tab{ID: 3, Title: "Docs", Domain: "developer.chrome.com"},
		Tab{ID: 4, Title: "More Docs", Domain: "developer.chrome.com"},
	)
	request.ExistingGroups = []ExistingGroup{
		{ID: 7, Title: "Docs", Color: "blue", TabIDs: []int{9}},
		{ID: 8, Title: "Planning", Color: "green", TabIDs: []int{10}},
	}

	plan, err := ParsePlanText(`{"groups":[{"name":"Docs","color":"blue","tabIds":[1,2]}],"assignments":[{"groupId":7,"tabIds":[3,3,999]},{"groupId":404,"tabIds":[4]},{"groupId":8,"tabIds":[2,4]}]}`, request)
	if err != nil {
		t.Fatalf("ParsePlanText failed: %v", err)
	}
	if len(plan.Groups) != 1 || len(plan.Assignments) != 2 {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if !slices.Equal(plan.Assignments[0].TabIDs, []int{3}) || plan.Assignments[0].GroupID != 7 {
		t.Fatalf("unexpected first assignment: %#v", plan.Assignments[0])
	}
	if !slices.Equal(plan.Assignments[1].TabIDs, []int{4}) || plan.Assignments[1].GroupID != 8 {
		t.Fatalf("unexpected second assignment: %#v", plan.Assignments[1])
	}
}

func TestParsePlanTextRejectsNonJSON(t *testing.T) {
	_, err := ParsePlanText("not json", validRequest())
	assertBridgeErrorKind(t, err, "malformed-output")
}

func TestCLIRunnerMapsAuthErrors(t *testing.T) {
	commands := &recordingCommandRunner{
		result: CommandResult{Stderr: "login required before using this command"},
		err:    errors.New("exit status 1"),
	}
	runner := CLIRunner{Commands: commands}

	_, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	assertBridgeErrorKind(t, err, "cli-auth-missing")
}

func TestCLIRunnerDoesNotReturnRawCommandOutput(t *testing.T) {
	commands := &recordingCommandRunner{
		result: CommandResult{
			Stderr: "failed while reading https://secret.example/private",
			Stdout: "tab title with private customer name",
		},
		err: errors.New("exit status 1"),
	}
	runner := CLIRunner{Commands: commands}

	_, err := runner.Run(context.Background(), validRequest(), "group these tabs")
	var bridgeError BridgeError
	if !errors.As(err, &bridgeError) {
		t.Fatalf("expected BridgeError, got %T", err)
	}
	if bridgeError.Kind != "cli-error" {
		t.Fatalf("unexpected kind: %s", bridgeError.Kind)
	}
	message := bridgeError.Error()
	for _, forbidden := range []string{"secret.example", "private customer name"} {
		if strings.Contains(message, forbidden) {
			t.Fatalf("raw command output leaked into error: %q", message)
		}
	}
}

func TestCappedBufferLimitsCapturedOutput(t *testing.T) {
	buffer := newCappedBuffer(5)
	written, err := buffer.Write([]byte("abcdef"))
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if written != 6 {
		t.Fatalf("unexpected written count: %d", written)
	}
	if buffer.String() != "abcde" {
		t.Fatalf("unexpected buffer contents: %q", buffer.String())
	}
	if !buffer.Exceeded() {
		t.Fatal("expected buffer to record exceeded limit")
	}
}

func TestExecCommandRunnerTimeoutKillsDescendantHoldingStdout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()

	_, err := (ExecCommandRunner{}).Run(ctx, CommandSpec{
		Executable: "sh",
		Args:       []string{"-c", "(sleep 3; echo late) & echo parent; sleep 10"},
	})
	elapsed := time.Since(start)

	assertBridgeErrorKind(t, err, "cli-timeout")
	if elapsed > time.Second {
		t.Fatalf("Run took too long after timeout: %s", elapsed)
	}
}

type recordingCommandRunner struct {
	specs            []CommandSpec
	result           CommandResult
	err              error
	writeCodexOutput string
}

func (runner *recordingCommandRunner) Run(ctx context.Context, spec CommandSpec) (CommandResult, error) {
	runner.specs = append(runner.specs, spec)
	if runner.writeCodexOutput != "" {
		for index, arg := range spec.Args {
			if arg == "--output-last-message" && index+1 < len(spec.Args) {
				if err := os.WriteFile(spec.Args[index+1], []byte(runner.writeCodexOutput), 0600); err != nil {
					return CommandResult{}, err
				}
			}
		}
	}
	return runner.result, runner.err
}

func (runner *recordingCommandRunner) lastSpec(t *testing.T) CommandSpec {
	t.Helper()
	if len(runner.specs) == 0 {
		t.Fatal("command was not called")
	}
	return runner.specs[len(runner.specs)-1]
}

func TestPlanSchemaJSONRequiresEveryProperty(t *testing.T) {
	// OpenAI's strict structured-output mode (used via codex --output-schema
	// and claude --json-schema) rejects any schema where an object's
	// "required" array does not list every key in "properties". This test
	// exists because that mismatch shipped silently once already: nothing
	// exercises the real CLI against the real API, so a missing field in
	// "required" only surfaces as a live invalid_json_schema error.
	var root map[string]any
	if err := json.Unmarshal([]byte(planSchemaJSON), &root); err != nil {
		t.Fatalf("planSchemaJSON is not valid JSON: %v", err)
	}
	assertStrictObjectSchema(t, "$", root)
}

func assertStrictObjectSchema(t *testing.T, path string, node map[string]any) {
	t.Helper()
	if node["type"] != "object" {
		return
	}
	properties, _ := node["properties"].(map[string]any)
	requiredRaw, _ := node["required"].([]any)
	required := map[string]bool{}
	for _, entry := range requiredRaw {
		if name, ok := entry.(string); ok {
			required[name] = true
		}
	}
	for name := range properties {
		if !required[name] {
			t.Fatalf("%s.properties.%s is not listed in required (strict schema mode requires every property to be required)", path, name)
		}
	}
	for name, value := range properties {
		if child, ok := value.(map[string]any); ok {
			assertStrictObjectSchema(t, path+"."+name, child)
			if items, ok := child["items"].(map[string]any); ok {
				assertStrictObjectSchema(t, path+"."+name+"[]", items)
			}
		}
	}
}

func assertBridgeErrorKind(t *testing.T, err error, expected string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s error", expected)
	}
	var bridgeError BridgeError
	if !errors.As(err, &bridgeError) {
		t.Fatalf("expected BridgeError, got %T: %v", err, err)
	}
	if bridgeError.Kind != expected {
		t.Fatalf("expected %s, got %s", expected, bridgeError.Kind)
	}
}
