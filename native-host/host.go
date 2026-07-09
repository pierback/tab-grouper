package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type Host struct {
	Runner Runner
}

type StatusRunner interface {
	Status(ctx context.Context, request Request) (Status, error)
}

type ModelsRunner interface {
	ListModels(ctx context.Context, request Request) ([]ModelInfo, error)
}

func NewHost() Host {
	configPath, err := DefaultConfigPath()
	if err != nil {
		return Host{Runner: StaticErrorRunner{Err: BridgeError{Kind: "native-host-config-error", Err: err}}}
	}
	config, ok, err := LoadNativeHostConfig(configPath)
	if err != nil {
		return Host{Runner: StaticErrorRunner{Err: BridgeError{Kind: "native-host-config-error", Err: err}}}
	}
	if ok {
		return Host{Runner: NewCLIRunnerFromConfig(config)}
	}
	return Host{Runner: NewCLIRunner()}
}

type StaticErrorRunner struct {
	Err error
}

func (runner StaticErrorRunner) Run(ctx context.Context, request Request, prompt string) (Plan, error) {
	if runner.Err != nil {
		return Plan{}, runner.Err
	}
	return Plan{}, BridgeError{Kind: "native-host-config-error", Err: fmt.Errorf("native host is not configured")}
}

func (runner StaticErrorRunner) Status(ctx context.Context, request Request) (Status, error) {
	if runner.Err != nil {
		return Status{}, runner.Err
	}
	return Status{}, BridgeError{Kind: "native-host-config-error", Err: fmt.Errorf("native host is not configured")}
}

func (runner StaticErrorRunner) ListModels(ctx context.Context, request Request) ([]ModelInfo, error) {
	if runner.Err != nil {
		return nil, runner.Err
	}
	return nil, BridgeError{Kind: "native-host-config-error", Err: fmt.Errorf("native host is not configured")}
}

func (host Host) Handle(ctx context.Context, request Request) Response {
	if err := ValidateRequest(request); err != nil {
		return ErrorResponse(request, "native-host-protocol-error", err)
	}
	if request.Type == RequestPingType {
		plan := Plan{Groups: []PlanGroup{}}
		return SuccessResponse(request, plan, 0)
	}
	if request.Type == RequestStatusType {
		statusRunner, ok := host.Runner.(StatusRunner)
		if !ok {
			return ErrorResponse(request, "native-host-config-error", fmt.Errorf("native host status is unavailable"))
		}
		status, err := statusRunner.Status(ctx, request)
		if err != nil {
			kind := "native-host-config-error"
			var bridgeError BridgeError
			if errors.As(err, &bridgeError) {
				kind = bridgeError.Kind
			}
			return ErrorResponse(request, kind, err)
		}
		return StatusResponse(request, status)
	}
	if request.Type == RequestListModelsType {
		modelsRunner, ok := host.Runner.(ModelsRunner)
		if !ok {
			return ErrorResponse(request, "native-host-config-error", fmt.Errorf("native host model listing is unavailable"))
		}
		models, err := modelsRunner.ListModels(ctx, request)
		if err != nil {
			kind := "native-host-config-error"
			var bridgeError BridgeError
			if errors.As(err, &bridgeError) {
				kind = bridgeError.Kind
			}
			return ErrorResponse(request, kind, err)
		}
		return ModelsResponse(request, models)
	}

	prompt, err := BuildGroupingPrompt(request)
	if err != nil {
		return ErrorResponse(request, "native-host-protocol-error", err)
	}

	start := time.Now()
	runCtx, cancel := withTimeout(ctx, request.TimeoutMS)
	defer cancel()
	plan, err := host.Runner.Run(runCtx, request, prompt)
	if err != nil {
		kind := "native-host-protocol-error"
		var bridgeError BridgeError
		if errors.As(err, &bridgeError) {
			kind = bridgeError.Kind
		}
		return ErrorResponse(request, kind, err)
	}
	return SuccessResponse(request, plan, time.Since(start).Milliseconds())
}
