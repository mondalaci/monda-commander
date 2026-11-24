//go:build windows

package main

// How the relay daemon is detached from the ssh channel that started it, and
// how it is asked to stop. Unix answers both in process_unix.go.

import (
	"os"
	"os/exec"
	"syscall"
)

// Windows' equivalents of a new session: the child gets its own process group
// and no console of its own, so closing the ssh channel's console cannot reach
// it.
const (
	createNewProcessGroup = 0x00000200
	detachedProcess       = 0x00000008
)

func detachProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: createNewProcessGroup | detachedProcess,
	}
}

// A Windows process has no SIGTERM to ask with, so the daemon is killed
// outright; `stopServer` removes the socket and the pid file either way.
func terminateProcess(process *os.Process) error {
	return process.Kill()
}
