package main

// One pty-backed shell per id. The relay owns the pty and streams its bytes as
// events; the app's xterm writes back into the same pty. A shell here is as
// real as one in a terminal — job control, signals, TUIs — because it is one.
//
// In a persistent relay the session outlives the connection that started it: on
// disconnect the sink is cleared but the pty keeps running and its output keeps
// filling the ring, so a later connection can attach and be replayed what it
// missed. That is the whole of tmux-style persistence here; see docs/design.md,
// "The connection is long-lived; the protocol is its guest".

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/creack/pty"
)

// How much of a session's output is kept for a reconnecting client. Bounded so a
// chatty shell cannot grow the daemon without limit; a client that is away
// longer than this much output misses the middle and is told so.
const ptyScrollbackBytes = 256 * 1024

// How long a session that has exited is kept after its end, so a client that
// reconnects can still learn the exit and read the last of its output.
const exitedSessionTTL = 10 * time.Minute

type PtySession struct {
	id   string
	cmd  *exec.Cmd
	ptmx *os.File

	// mu guards the session's output ring, its current sink, and its exit state.
	// It is held while output is appended *and* sent, so a reattach's snapshot
	// and any output that follows it cannot be delivered out of order.
	mu       sync.Mutex
	out      ringBuffer
	sink     *Conn
	exited   bool
	exitCode int
	signal   *int
}

var (
	ptyMu   sync.Mutex
	ptyByID = map[string]*PtySession{}
)

// spawnPty starts a shell at cwd with the given size. It is left unattached
// (sink nil) so the caller can attach it: output the shell produces before the
// client's create is answered — its prompt — is then replayed exactly once,
// rather than racing a live event. The reader and waiter goroutines own the pty
// after this returns.
func spawnPty(req Request) (*PtySession, error) {
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

	session := &PtySession{
		id:   req.ID,
		cmd:  cmd,
		ptmx: ptmx,
		out:  newRingBuffer(ptyScrollbackBytes),
	}
	ptyMu.Lock()
	ptyByID[req.ID] = session
	ptyMu.Unlock()

	go readPtyOutput(session)
	go waitPty(session)
	return session, nil
}

func readPtyOutput(session *PtySession) {
	buf := make([]byte, 32*1024)
	for {
		n, err := session.ptmx.Read(buf)
		if n > 0 {
			// Append and send under the lock so an attach that is taking its
			// snapshot cannot have a live chunk jump ahead of the replay.
			session.mu.Lock()
			offset := session.out.write(buf[:n])
			if session.sink != nil {
				_ = session.sink.SendEvent(Event{Type: "pty:data", ID: session.id, Data: string(buf[:n]), Offset: offset})
			}
			session.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

// exitStatus reads a shell's end the way the local pty does: a normal code, or -1
// and the signal that killed it.
func exitStatus(err error) (int, *int) {
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
			if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
				sig := int(status.Signal())
				return -1, &sig
			}
		}
	}
	return code, nil
}

// waitPty records the session's end rather than forgetting it: a client may be
// away when it happens, and on reattach it should still be told. The session is
// kept for a while, then reaped.
func waitPty(session *PtySession) {
	code, signal := exitStatus(session.cmd.Wait())

	session.mu.Lock()
	session.exited = true
	session.exitCode = code
	session.signal = signal
	if session.sink != nil {
		_ = session.sink.SendEvent(Event{Type: "pty:exit", ID: session.id, ExitCode: &code, Signal: signal})
	}
	session.mu.Unlock()

	_ = session.ptmx.Close()
	time.AfterFunc(exitedSessionTTL, func() { removeSessionIfExited(session) })
}

func findPty(id string) *PtySession {
	ptyMu.Lock()
	defer ptyMu.Unlock()
	return ptyByID[id]
}

// attachPty points a session's output at conn and replays what the client missed
// since offset, as one response-and-blob pair so nothing interleaves between the
// snapshot and the stream that follows. The session need not be live: an exited
// one still replays its final output and reports how it ended.
func attachPty(conn *Conn, id uint32, ptyID string, offset int64) {
	session := findPty(ptyID)
	if session == nil {
		_ = conn.SendResponse(id, Response{Ok: false, Error: fsError("ENOENT", "No such pty")})
		return
	}

	session.mu.Lock()
	data, from, lost := session.out.since(offset)
	session.sink = conn
	next := session.out.next
	exited := session.exited
	code := session.exitCode
	signal := session.signal
	_ = conn.SendResponseWithBlob(id, Response{Ok: true, Data: map[string]any{
		"offset":   next,
		"from":     from,
		"lost":     lost,
		"exited":   exited,
		"exitCode": code,
		"signal":   signal,
	}}, data)
	session.mu.Unlock()
}

// detachConn releases every session a connection was attached to. The ptys keep
// running and their output keeps buffering in the ring, so a later connection —
// a re-dial, a new tab, or the app opened again — can attach and be told what it
// missed. A shell lives until it exits, exactly as it would under tmux; nothing
// reaps it just because nobody is watching.
func detachConn(conn *Conn) {
	ptyMu.Lock()
	sessions := make([]*PtySession, 0, len(ptyByID))
	for _, session := range ptyByID {
		sessions = append(sessions, session)
	}
	ptyMu.Unlock()

	for _, session := range sessions {
		session.mu.Lock()
		if session.sink == conn {
			session.sink = nil
		}
		session.mu.Unlock()
	}
}

func removeSessionIfExited(session *PtySession) {
	session.mu.Lock()
	exited := session.exited
	session.mu.Unlock()
	if !exited {
		return
	}
	ptyMu.Lock()
	if ptyByID[session.id] == session {
		delete(ptyByID, session.id)
	}
	ptyMu.Unlock()
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

// killPty ends a session and forgets it at once, so its id can be spawned fresh
// rather than resolving to a corpse on the next create.
func killPty(id string) {
	ptyMu.Lock()
	session := ptyByID[id]
	delete(ptyByID, id)
	ptyMu.Unlock()
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
	ptyByID = map[string]*PtySession{}
	ptyMu.Unlock()
	for _, session := range sessions {
		_ = session.cmd.Process.Kill()
		_ = session.ptmx.Close()
	}
}
