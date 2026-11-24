//go:build !windows

package main

// The shell a pty is started with when the client names none. Windows answers
// the same question in shell_windows.go.

import "os"

// defaultShell is the user's own login shell, or bash when `$SHELL` is unset.
func defaultShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/bash"
}
