package main

// The relay's entry point. It speaks the protocol on stdin/stdout, so the app
// can launch it identically three ways: in-process is main's own code, root is
// `pkexec <relay> --stdio`, remote is `ssh host <relay> --stdio`. One protocol,
// one binary, three launches. See docs/design.md, "One protocol, three
// transports".

import (
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

const relayVersion = 2

type HelloInfo struct {
	Version      int    `json:"version"`
	UID          int    `json:"uid"`
	Home         string `json:"home"`
	Platform     string `json:"platform"`
	CanTranscode bool   `json:"canTranscode"`
	CanArchive   bool   `json:"canArchive"`
}

type PtyState struct {
	Cwd  *string `json:"cwd"`
	Idle bool    `json:"idle"`
}

func main() {
	// The bootstrap check: `--version` answers without opening the protocol, so a
	// remote can tell a current relay from a stale or missing one before the app
	// commits to talking to it.
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Printf("monda-relay version %d\n", relayVersion)
		return
	}

	conn := NewConn(os.Stdin, os.Stdout)

	// A signal that ends the relay should take its shells with it, so a closed
	// connection cannot leave a root or remote shell running with no one
	// attached.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-signals
		killAllPtys()
		stopAllWatches()
		os.Exit(0)
	}()

	serve(conn)
	killAllPtys()
	stopAllWatches()
}

func serve(conn *Conn) {
	for {
		kind, id, payload, err := conn.ReadFrame()
		if err != nil {
			return
		}
		if kind != frameRequest {
			// The client sends requests; a blob only ever follows one that
			// asked for it. Anything else is a protocol error we cannot route.
			continue
		}
		var req Request
		if err := json.Unmarshal(payload, &req); err != nil {
			_ = conn.SendResponse(id, Response{Ok: false, Error: fsError("EINVAL", "invalid request")})
			continue
		}

		// A write carries its bytes as the next frame. Reading it here keeps the
		// stream in order: the client sends the JSON and the BLOB back to back.
		if req.Op == "fs:write" {
			blobKind, blobID, blob, blobErr := conn.ReadFrame()
			if blobErr != nil {
				_ = conn.SendResponse(id, Response{Ok: false, Error: fsError("EINVAL", "missing file content")})
				continue
			}
			if blobKind != frameBlob || blobID != id {
				_ = conn.SendResponse(id, Response{Ok: false, Error: fsError("EINVAL", "file content does not match the request")})
				continue
			}
			req.Blob = blob
		}

		go handle(conn, req, id)
	}
}

func handle(conn *Conn, req Request, id uint32) {
	respond := func(data any, err error) {
		if err != nil {
			var fsErr *FsError
			if !asFsError(err, &fsErr) {
				fsErr = toFsError(err)
			}
			_ = conn.SendResponse(id, Response{Ok: false, Error: fsErr})
			return
		}
		_ = conn.SendResponse(id, Response{Ok: true, Data: data})
	}

	switch req.Op {
	case "hello":
		home, _ := os.UserHomeDir()
		respond(HelloInfo{
			Version:      relayVersion,
			UID:          os.Getuid(),
			Home:         home,
			Platform:     "linux",
			CanTranscode: canExec("ffmpeg"),
			CanArchive:   canExec("7z") || canExec("7za"),
		}, nil)

	case "fs:home":
		home, err := os.UserHomeDir()
		respond(home, err)

	case "fs:list":
		listing, err := listDirectory(req.Path)
		respond(listing, err)

	case "fs:read":
		meta, bytes, err := readFileForViewer(req.Path)
		if err != nil {
			var fsErr *FsError
			if !asFsError(err, &fsErr) {
				fsErr = toFsError(err)
			}
			_ = conn.SendResponse(id, Response{Ok: false, Error: fsErr})
			return
		}
		_ = conn.SendResponseWithBlob(id, Response{Ok: true, Data: meta}, bytes)

	case "fs:readImage":
		meta, bytes, err := readImageForPreview(req.Path)
		if err != nil {
			var fsErr *FsError
			if !asFsError(err, &fsErr) {
				fsErr = toFsError(err)
			}
			_ = conn.SendResponse(id, Response{Ok: false, Error: fsErr})
			return
		}
		_ = conn.SendResponseWithBlob(id, Response{Ok: true, Data: meta}, bytes)

	case "fs:write":
		resolved, err := writeFile(req.Path, req.Blob)
		respond(resolved, err)

	case "fs:rename":
		resolved, err := renameEntry(req.Source, req.Target)
		respond(resolved, err)

	case "fs:mkdir":
		resolved, err := makeDir(req.Dir, req.Name)
		respond(resolved, err)

	case "fs:copy":
		outcome, err := copyEntries(req.Sources, req.Destination, req.BaseDir)
		respond(outcome, err)

	case "fs:move":
		outcome, err := moveEntries(req.Sources, req.Destination, req.BaseDir)
		respond(outcome, err)

	case "fs:delete":
		outcome, err := deleteEntries(req.Targets)
		respond(outcome, err)

	case "fs:hideAdd":
		file, err := addHiddenName(req.Dir, req.Name)
		respond(file, err)

	case "fs:dirSize":
		bytes, err := directorySize(req.Path)
		respond(map[string]int64{"bytes": bytes}, err)

	case "fs:imageSize":
		respond(nil, nil)

	case "fs:canTranscode":
		respond(canExec("ffmpeg"), nil)

	case "fs:canArchive":
		respond(canExec("7z") || canExec("7za"), nil)

	case "fs:videoCodec", "fs:videoDuration":
		respond(nil, nil)

	case "fs:open":
		// A remote file cannot be handed to the target's desktop from here; the
		// renderer offers "extract" only locally. A non-empty message is the
		// app's way of saying a failure came back.
		respond("Opening files on a remote target is not supported yet", nil)

	case "fs:reveal":
		respond(nil, fsError("ENOTSUP", "Revealing files on a remote target is not supported yet"))

	case "fs:watch":
		respond(nil, startWatch(conn, req.Path, "fs:changed"))

	case "fs:unwatch":
		stopWatch(req.Path, "fs:changed")
		respond(nil, nil)

	case "git:status":
		status, err := gitStatus(req.Dir)
		respond(status, err)

	case "git:watch":
		respond(nil, startWatch(conn, req.Path, "git:changed"))

	case "git:unwatch":
		stopWatch(req.Path, "git:changed")
		respond(nil, nil)

	case "pty:create":
		_, err := spawnPty(conn, req)
		respond(nil, err)

	case "pty:write":
		respond(nil, writePty(req.ID, req.Data))

	case "pty:resize":
		respond(nil, resizePty(req.ID, req.Cols, req.Rows))

	case "pty:kill":
		killPty(req.ID)
		respond(nil, nil)

	case "pty:state":
		cwd, idle := ptyState(req.ID)
		var cwdPtr *string
		if cwd != "" {
			value := cwd
			cwdPtr = &value
		}
		respond(PtyState{Cwd: cwdPtr, Idle: idle}, nil)

	default:
		respond(nil, fsError("ENOTSUP", fmt.Sprintf("unknown operation %q", req.Op)))
	}
}

// asFsError unwraps an *FsError without importing errors into every call site's
// mental load; the type assertion is the whole implementation.
func asFsError(err error, target **FsError) bool {
	if value, ok := err.(*FsError); ok {
		*target = value
		return true
	}
	return false
}
