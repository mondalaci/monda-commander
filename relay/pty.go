package main

// One pty-backed shell per id. The relay owns the pty and streams its bytes as
// events; the app's xterm writes back into the same pty. A shell here is as
// real as one in a terminal — job control, signals, TUIs — because it is one.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/creack/pty"
)

type PtySession struct {
	id   string
	cmd  *exec.Cmd
	ptmx *os.File
	mu   sync.Mutex
}

var (
	ptyMu   sync.Mutex
	ptyByID = map[string]*PtySession{}
)

func defaultShell() string {
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	return "/bin/bash"
}

// spawnPty starts a shell at cwd with the given size. The reader and waiter
// goroutines forward output and the exit to the connection; they own the pty
// after this returns.
func spawnPty(conn *Conn, req Request) (*PtySession, error) {
	if req.ID == "" {
		return nil, fsError("EINVAL", "No pty id")
	}
	shell := req.Shell
	if shell == "" {
		shell = defaultShell()
	}
	cols := req.Cols
	if cols < 2 {
		cols = 2
	}
	rows := req.Rows
	if rows < 1 {
		rows = 1
	}

	cmd := exec.Command(shell)
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor")
	if req.Path != "" {
		cmd.Dir = req.Path
	} else if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}

	ptmx, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})

	session := &PtySession{id: req.ID, cmd: cmd, ptmx: ptmx}
	ptyMu.Lock()
	ptyByID[req.ID] = session
	ptyMu.Unlock()

	go readPtyOutput(conn, session)
	go waitPty(conn, session)
	return session, nil
}

func readPtyOutput(conn *Conn, session *PtySession) {
	buf := make([]byte, 32*1024)
	for {
		n, err := session.ptmx.Read(buf)
		if n > 0 {
			_ = conn.SendEvent(Event{Type: "pty:data", ID: session.id, Data: string(buf[:n])})
		}
		if err != nil {
			return
		}
	}
}

func waitPty(conn *Conn, session *PtySession) {
	err := session.cmd.Wait()
	code := 0
	var signal *int
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				sig := int(status.Signal())
				signal = &sig
				code = -1
			}
		}
	}
	ptyMu.Lock()
	delete(ptyByID, session.id)
	ptyMu.Unlock()
	_ = session.ptmx.Close()
	_ = conn.SendEvent(Event{Type: "pty:exit", ID: session.id, ExitCode: &code, Signal: signal})
}

func findPty(id string) *PtySession {
	ptyMu.Lock()
	defer ptyMu.Unlock()
	return ptyByID[id]
}

func writePty(id, data string) error {
	session := findPty(id)
	if session == nil {
		return fsError("ENOENT", "No such pty")
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	_, err := session.ptmx.WriteString(data)
	return err
}

func resizePty(id string, cols, rows int) error {
	session := findPty(id)
	if session == nil {
		return fsError("ENOENT", "No such pty")
	}
	if cols < 2 {
		cols = 2
	}
	if rows < 1 {
		rows = 1
	}
	return pty.Setsize(session.ptmx, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

func killPty(id string) {
	session := findPty(id)
	if session == nil {
		return
	}
	_ = session.cmd.Process.Kill()
	_ = session.ptmx.Close()
}

// ptyState reads the same /proc facts the local app reads: the shell's cwd and
// whether it owns the terminal's foreground process group. The pty belongs to
// the relay, so the pid is the relay's child, not a local ssh process.
func ptyState(id string) (string, bool) {
	session := findPty(id)
	if session == nil || session.cmd.Process == nil {
		return "", false
	}
	pid := session.cmd.Process.Pid

	cwd, err := os.Readlink(fmt.Sprintf("/proc/%d/cwd", pid))
	if err != nil {
		cwd = ""
	}

	idle := false
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err == nil {
		text := string(stat)
		if closing := strings.LastIndex(text, ")"); closing >= 0 {
			fields := strings.Fields(text[closing+2:])
			// Everything after "comm) " starts at field 3; tpgid is field 8.
			if len(fields) > 5 {
				if tpgid, convErr := strconv.Atoi(fields[5]); convErr == nil {
					idle = tpgid == pid
				}
			}
		}
	}
	return cwd, idle
}

func killAllPtys() {
	ptyMu.Lock()
	sessions := make([]*PtySession, 0, len(ptyByID))
	for _, session := range ptyByID {
		sessions = append(sessions, session)
	}
	ptyMu.Unlock()
	for _, session := range sessions {
		_ = session.cmd.Process.Kill()
		_ = session.ptmx.Close()
	}
}
