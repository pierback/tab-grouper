package main

import (
	"context"
	"log"
	"os"
)

func main() {
	log.SetOutput(os.Stderr)

	executablePath, err := os.Executable()
	if err != nil {
		log.Printf("failed to resolve executable path: %v", err)
		return
	}
	paths := nativeHostRuntimePaths(executablePath)

	if hasDaemonArg(os.Args[1:]) {
		if err := runDaemon(context.Background(), defaultDaemonConfig(paths.SocketPath)); err != nil {
			log.Printf("daemon exited with error: %v", err)
		}
		return
	}

	if err := runProxyOrStartDaemon(context.Background(), os.Stdin, os.Stdout, defaultProxyConfig(executablePath, paths)); err != nil {
		log.Printf("native host proxy failed: %v", err)
	}
}
