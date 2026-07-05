package main

import (
	"encoding/json"
	"errors"
	"os"
)

const NativeHostConfigVersion = 1

type NativeHostConfig struct {
	Version          int    `json:"version"`
	LockExecutables  bool   `json:"lockExecutables"`
	CodexExecutable  string `json:"codexExecutable"`
	ClaudeExecutable string `json:"claudeExecutable"`
}

func DefaultConfigPath() (string, error) {
	executablePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	return executablePath + ".config.json", nil
}

func LoadNativeHostConfig(path string) (NativeHostConfig, bool, error) {
	bytes, err := readSmallFile(path, MaxCLIOutputBytes)
	if errors.Is(err, os.ErrNotExist) {
		return NativeHostConfig{}, false, nil
	}
	if err != nil {
		return NativeHostConfig{}, false, err
	}
	if len(bytes) == 0 {
		return NativeHostConfig{}, false, nil
	}

	var config NativeHostConfig
	if err := json.Unmarshal(bytes, &config); err != nil {
		return NativeHostConfig{}, true, err
	}
	if config.Version != NativeHostConfigVersion {
		return NativeHostConfig{}, true, errors.New("unsupported native host config version")
	}
	return config, true, nil
}

func NewCLIRunnerFromConfig(config NativeHostConfig) CLIRunner {
	return CLIRunner{
		Commands:         ExecCommandRunner{},
		CodexExecutable:  config.CodexExecutable,
		ClaudeExecutable: config.ClaudeExecutable,
		LockExecutables:  config.LockExecutables,
	}
}
