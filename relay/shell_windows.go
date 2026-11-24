//go:build windows

package main

// The shell a pty is started with when the client names none. Unix answers the
// same question in shell_unix.go.

import "os"

// defaultShell is the command processor, `%COMSPEC%` (cmd.exe), with PowerShell
// as the fallback — the same pair the app's own local shell uses (ipc/pty.ts),
// so a remote Windows shell behaves like a local one. Windows has no `$SHELL`.
func defaultShell() string {
	if shell := os.Getenv("COMSPEC"); shell != "" {
		return shell
	}
	return "powershell.exe"
}
