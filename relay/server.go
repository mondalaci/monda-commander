package main

// The persistent relay: a daemon that outlives any one connection.
//
// `--server` listens on a unix socket in the user's own home and holds every
// session there. `--connect` is what ssh actually launches: it reaches that
// daemon (starting one if none is up, or replacing a stale-version one) and then
// is nothing but a byte pipe between the ssh channel and the socket. So a
// dropped ssh kills the pipe and nothing else — the shells keep running and a
// later connection reattaches to them. See docs/design.md, "The connection is
// long-lived; the protocol is its guest".

import (
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Where the daemon listens and how it is found. Under the user's home rather
// than $XDG_RUNTIME_DIR because a later ssh login may have a different runtime
// directory than the one that started the daemon, and reattaching must not
// depend on that. MONDA_RELAY_SOCK overrides it, which is what a test uses.
func socketPath() string {
	if path := os.Getenv("MONDA_RELAY_SOCK"); path != "" {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.TempDir()
	}
	return filepath.Join(home, ".monda", "relay.sock")
}

func pidPath() string     { return socketPath() + ".pid" }
func versionPath() string { return socketPath() + ".version" }

func runServer() {
	sock := socketPath()
	if err := os.MkdirAll(filepath.Dir(sock), 0700); err != nil {
		fmt.Fprintln(os.Stderr, "monda-relay: cannot create the state directory:", err)
		os.Exit(1)
	}

	// An existing listener is not our business to replace: `--connect` decides
	// when a daemon is stale and stops it before starting this one. Binding over
	// a live socket would fail anyway, but saying so quietly beats a spurious
	// error for the common race of two connects starting a server at once.
	if c, err := net.Dial("unix", sock); err == nil {
		_ = c.Close()
		return
	}
	_ = os.Remove(sock) // a socket left by a dead daemon

	listener, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, "monda-relay: cannot listen:", err)
		os.Exit(1)
	}
	_ = os.Chmod(sock, 0600)
	_ = os.WriteFile(pidPath(), []byte(strconv.Itoa(os.Getpid())+"\n"), 0600)
	_ = os.WriteFile(versionPath(), []byte(strconv.Itoa(relayVersion)+"\n"), 0600)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		killAllPtys()
		stopAllWatches()
		_ = os.Remove(sock)
		_ = os.Remove(pidPath())
		_ = os.Remove(versionPath())
		os.Exit(0)
	}()

	for {
		nc, err := listener.Accept()
		if err != nil {
			return
		}
		go serveConnection(nc)
	}
}

// serveConnection runs the protocol for one accepted socket. When it ends — the
// ssh channel closed, or a new one replaced it — the sessions it was attached to
// are detached, not killed, and its watchers are dropped.
func serveConnection(nc net.Conn) {
	conn := NewConn(nc, nc)
	serve(conn)
	detachConn(conn)
	stopWatchesFor(conn)
	_ = nc.Close()
}

func runConnect() {
	sock := socketPath()
	ensureServer(sock)

	nc, err := dialRetry(sock, 10*time.Second)
	if err != nil {
		fmt.Fprintln(os.Stderr, "monda-relay: cannot reach the relay daemon:", err)
		os.Exit(1)
	}
	proxy(nc)
}

// ensureServer leaves a current daemon listening. A daemon of another version is
// stopped first: a long-lived server would otherwise survive an app upgrade and
// answer the new protocol with the old rules.
func ensureServer(sock string) {
	if c, err := net.Dial("unix", sock); err == nil {
		_ = c.Close()
		if readIntFile(versionPath()) == relayVersion {
			return
		}
		stopServer()
	}
	startServerDetached()
}

// stopServer asks the running daemon to end and waits for its socket to go. It
// is only reached for a version change, so a brief wait is acceptable; the
// socket is removed either way, and the pid file too.
func stopServer() {
	if pid := readIntFile(pidPath()); pid > 0 {
		if process, err := os.FindProcess(pid); err == nil {
			_ = terminateProcess(process)
			deadline := time.Now().Add(3 * time.Second)
			for time.Now().Before(deadline) {
				if _, err := net.Dial("unix", socketPath()); err != nil {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}
		}
	}
	_ = os.Remove(socketPath())
	_ = os.Remove(pidPath())
	_ = os.Remove(versionPath())
}

// startServerDetached launches `--server` in a new session, so it is not in the
// ssh channel's process group and a hangup on that channel cannot reach it.
func startServerDetached() {
	cmd := exec.Command(os.Args[0], "--server")
	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil
	detachProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "monda-relay: cannot start the relay daemon:", err)
		os.Exit(1)
	}
	// Reap it if it happens to exit while we are still here; the proxy that
	// matters is the socket, not this child.
	go func() { _ = cmd.Wait() }()
}

func dialRetry(sock string, timeout time.Duration) (net.Conn, error) {
	deadline := time.Now().Add(timeout)
	for {
		nc, err := net.Dial("unix", sock)
		if err == nil {
			return nc, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func readIntFile(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	value, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		return 0
	}
	return value
}

// proxy shovels bytes both ways until either side is done. A half-close on stdin
// (ssh's channel closing) becomes a CloseWrite on the socket, so the daemon sees
// the end of the request stream while any last output still flows back.
func proxy(nc net.Conn) {
	done := make(chan struct{}, 2)
	go func() {
		_, _ = io.Copy(nc, os.Stdin)
		if unixConn, ok := nc.(*net.UnixConn); ok {
			_ = unixConn.CloseWrite()
		} else {
			_ = nc.Close()
		}
		done <- struct{}{}
	}()
	go func() {
		_, _ = io.Copy(os.Stdout, nc)
		done <- struct{}{}
	}()
	<-done
}
