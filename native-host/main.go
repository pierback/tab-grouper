package main

import (
	"context"
	"log"
	"os"
)

func main() {
	log.SetOutput(os.Stderr)
	request, err := ReadNativeMessage(os.Stdin)
	if err != nil {
		log.Printf("failed to read native message: %v", err)
		return
	}
	response := NewHost().Handle(context.Background(), request)
	if err := WriteNativeMessage(os.Stdout, response); err != nil {
		log.Printf("failed to write native message: %v", err)
	}
}
