//go:build !windows

package main

// How the relay daemon is detached from the ssh channel that started it, and
// how it is asked to stop. Windows answers both in process_windows.go.

import (
	"os"
	"os/exec"
	"syscall"
)

// detachProcessGroup puts the daemon in its own session, so it is not in the ssh
// channel's process group and a hangup on that channel cannot reach it.
func detachProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// terminateProcess asks the daemon to end, so it can take its socket and pid
// file with it.
func terminateProcess(process *os.Process) error {
	return process.Signal(syscall.SIGTERM)
}
