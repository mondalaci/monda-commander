package main

// The file operations the app performs, implemented against the local
// filesystem of whoever the relay runs as. The semantics mirror
// src/main/ipc/fs.ts: no silent clobbering, a trailing separator means "a
// directory", and a move across filesystems falls back to copy-then-remove.
// The relay is the remote/root half of the same contract, so a pane cannot tell
// which side answered except by where the files are.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

type DirEntry struct {
	Name          string  `json:"name"`
	Path          string  `json:"path"`
	Kind          string  `json:"kind"`
	IsSymlink     bool    `json:"isSymlink"`
	SymlinkTarget *string `json:"symlinkTarget"`
	Size          int64   `json:"size"`
	MtimeMs       float64 `json:"mtimeMs"`
	Mode          uint32  `json:"mode"`
}

type DirListing struct {
	Path        string     `json:"path"`
	Parent      *string    `json:"parent"`
	Entries     []DirEntry `json:"entries"`
	HiddenNames []string   `json:"hiddenNames"`
}

type FileContent struct {
	Path      string `json:"path"`
	Truncated bool   `json:"truncated"`
}

type ImagePreview struct {
	Mime string `json:"mime"`
}

type CopyFailure struct {
	Path  string   `json:"path"`
	Error *FsError `json:"error"`
}

type CopyOutcome struct {
	Copied      []string      `json:"copied"`
	Failed      []CopyFailure `json:"failed"`
	Destination string        `json:"destination"`
}

type MoveFailure struct {
	Path  string   `json:"path"`
	Error *FsError `json:"error"`
}

type MoveOutcome struct {
	Moved       []string      `json:"moved"`
	Failed      []MoveFailure `json:"failed"`
	Destination string        `json:"destination"`
}

type DeleteFailure struct {
	Path  string   `json:"path"`
	Error *FsError `json:"error"`
}

type DeleteOutcome struct {
	Deleted []string        `json:"deleted"`
	Failed  []DeleteFailure `json:"failed"`
}

type PixelSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

const (
	maxViewBytes  = 8 * 1024 * 1024
	maxRawPreview = 16 * 1024 * 1024
	hideMarker    = ".mchide"
)

func fsError(code, message string) *FsError {
	return &FsError{Code: code, Message: message}
}

// toFsError maps a Go error onto the Node-style codes the renderer already
// understands, so a remote failure reads the same as a local one.
func toFsError(err error) *FsError {
	if err == nil {
		return nil
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		err = pathErr.Err
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return fsError("ENOENT", err.Error())
	case errors.Is(err, fs.ErrExist):
		return fsError("EEXIST", err.Error())
	case errors.Is(err, fs.ErrPermission):
		return fsError("EACCES", err.Error())
	case errors.Is(err, syscall.ENOTDIR):
		return fsError("ENOTDIR", err.Error())
	case errors.Is(err, syscall.EISDIR):
		return fsError("EISDIR", err.Error())
	case errors.Is(err, syscall.ENOTEMPTY):
		return fsError("ENOTEMPTY", err.Error())
	case errors.Is(err, syscall.EINVAL):
		return fsError("EINVAL", err.Error())
	case errors.Is(err, syscall.ENOSPC):
		return fsError("ENOSPC", err.Error())
	default:
		return fsError("EUNKNOWN", err.Error())
	}
}

func kindFromMode(mode os.FileMode) string {
	switch {
	case mode.IsDir():
		return "directory"
	case mode.IsRegular():
		return "file"
	case mode&os.ModeSymlink != 0:
		return "symlink"
	case mode&os.ModeSocket != 0:
		return "socket"
	case mode&os.ModeNamedPipe != 0:
		return "fifo"
	case mode&os.ModeDevice != 0 || mode&os.ModeCharDevice != 0:
		return "device"
	default:
		return "unknown"
	}
}

// rawMode returns the Unix mode bits the way Node's `stats.mode` does, type
// bits included. Go's FileMode is a portable representation, so the raw value
// is read from the syscall stat when it is available.
func rawMode(info os.FileInfo) uint32 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return stat.Mode
	}
	return uint32(info.Mode())
}

func readEntry(dir, name string) (DirEntry, error) {
	full := filepath.Join(dir, name)
	info, err := os.Lstat(full)
	if err != nil {
		return DirEntry{}, err
	}
	isSymlink := info.Mode()&os.ModeSymlink != 0
	targetInfo := info
	if isSymlink {
		if resolved, statErr := os.Stat(full); statErr == nil {
			targetInfo = resolved
		}
	}
	var symlinkTarget *string
	if isSymlink {
		if link, linkErr := os.Readlink(full); linkErr == nil {
			symlinkTarget = &link
		}
	}
	return DirEntry{
		Name:          name,
		Path:          full,
		Kind:          kindFromMode(targetInfo.Mode()),
		IsSymlink:     isSymlink,
		SymlinkTarget: symlinkTarget,
		Size:          targetInfo.Size(),
		MtimeMs:       float64(targetInfo.ModTime().UnixNano()) / 1e6,
		Mode:          rawMode(targetInfo),
	}, nil
}

func parseHiddenNames(text string) []string {
	names := make([]string, 0)
	for _, line := range strings.Split(text, "\n") {
		name := strings.TrimSpace(line)
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

func readHiddenNames(file string) []string {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	return parseHiddenNames(string(data))
}

func listDirectory(input string) (*DirListing, error) {
	dir, err := filepath.Abs(input)
	if err != nil {
		return nil, err
	}
	dirents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	entries := make([]DirEntry, 0, len(dirents))
	for _, d := range dirents {
		entry, entryErr := readEntry(dir, d.Name())
		if entryErr == nil {
			entries = append(entries, entry)
		}
	}
	// The hide file is looked up in the listing just read rather than by a
	// separate stat, exactly as the local listing does.
	var hidden []string
	for _, entry := range entries {
		if entry.Name == hideMarker && entry.Kind != "directory" {
			hidden = readHiddenNames(entry.Path)
			break
		}
	}
	parent := filepath.Dir(dir)
	var parentPtr *string
	if parent != dir {
		parentPtr = &parent
	}
	return &DirListing{
		Path:        dir,
		Parent:      parentPtr,
		Entries:     entries,
		HiddenNames: hidden,
	}, nil
}

func looksBinary(data []byte) bool {
	limit := len(data)
	if limit > 8000 {
		limit = 8000
	}
	for i := 0; i < limit; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

// readFileForViewer returns the metadata and the bytes. The bytes travel as a
// BLOB frame; the metadata carries the truncation flag so the renderer knows
// the tail was dropped rather than the file being that size.
func readFileForViewer(input string) (*FileContent, []byte, error) {
	target, err := filepath.Abs(input)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fsError("EINVAL", fmt.Sprintf("%q is not a regular file", filepath.Base(target)))
	}
	length := info.Size()
	if length > maxViewBytes {
		length = maxViewBytes
	}
	buf := make([]byte, length)
	n, readErr := io.ReadFull(f, buf)
	if readErr != nil && readErr != io.ErrUnexpectedEOF {
		return nil, nil, readErr
	}
	content := buf[:n]
	if looksBinary(content) {
		return nil, nil, fsError("EBINARY", fmt.Sprintf("%q looks binary", filepath.Base(target)))
	}
	return &FileContent{Path: target, Truncated: info.Size() > length}, content, nil
}

func readImageForPreview(input string) (*ImagePreview, []byte, error) {
	target, err := filepath.Abs(input)
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fsError("EINVAL", fmt.Sprintf("%q is not a regular file", filepath.Base(target)))
	}
	if info.Size() > maxRawPreview {
		return nil, nil, fsError("ELARGE", fmt.Sprintf("%q is too large for a remote preview", filepath.Base(target)))
	}
	data, err := io.ReadAll(io.LimitReader(f, maxRawPreview))
	if err != nil {
		return nil, nil, err
	}
	mimeType := mime.TypeByExtension(filepath.Ext(target))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return &ImagePreview{Mime: mimeType}, data, nil
}

func writeFile(target string, data []byte) (string, error) {
	resolved, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if info, statErr := os.Lstat(resolved); statErr == nil {
		if info.IsDir() || !info.Mode().IsRegular() {
			return "", fsError("EINVAL", fmt.Sprintf("%q is not a regular file", filepath.Base(resolved)))
		}
	}
	if err := os.WriteFile(resolved, data, 0o644); err != nil {
		return "", err
	}
	return resolved, nil
}

func renameEntry(source, target string) (string, error) {
	from, err := filepath.Abs(source)
	if err != nil {
		return "", err
	}
	to, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	if from == to {
		return to, nil
	}
	if from == "/" {
		return "", fsError("EPERM", "Refusing to rename a filesystem root")
	}
	// rename would silently clobber on POSIX, so a collision is an error the
	// pane can surface instead of data loss.
	if _, statErr := os.Lstat(to); statErr == nil {
		return "", fsError("EEXIST", fmt.Sprintf("%q already exists", filepath.Base(to)))
	}
	if err := os.Rename(from, to); err != nil {
		return "", err
	}
	return to, nil
}

func makeDir(dir, name string) (string, error) {
	if name == "" || strings.ContainsRune(name, 0) {
		return "", fsError("EINVAL", "No directory name")
	}
	base := dir
	if base == "" {
		base, _ = os.Getwd()
	}
	base, err := filepath.Abs(base)
	if err != nil {
		return "", err
	}
	target := name
	if !filepath.IsAbs(name) {
		target = filepath.Join(base, name)
	}
	target, err = filepath.Abs(target)
	if err != nil {
		return "", err
	}
	// Creation is deliberately not recursive: a name already there or one whose
	// parent is not is the honest answer rather than a chain of folders.
	if err := os.Mkdir(target, 0o755); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return "", fsError("EEXIST", fmt.Sprintf("%q already exists", filepath.Base(target)))
		}
		return "", err
	}
	return target, nil
}

// copyTree copies a file, a directory recursively, or a symlink as a symlink.
// The destination must not exist; the callers enforce that and this keeps the
// final write exclusive.
func copyTree(from, to string) error {
	info, err := os.Lstat(from)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		link, linkErr := os.Readlink(from)
		if linkErr != nil {
			return linkErr
		}
		return os.Symlink(link, to)
	}
	if info.IsDir() {
		if mkErr := os.Mkdir(to, info.Mode().Perm()); mkErr != nil {
			return mkErr
		}
		entries, readErr := os.ReadDir(from)
		if readErr != nil {
			return readErr
		}
		for _, entry := range entries {
			if cpErr := copyTree(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())); cpErr != nil {
				return cpErr
			}
		}
		return os.Chtimes(to, time.Now(), info.ModTime())
	}
	if !info.Mode().IsRegular() {
		return fsError("ENOTSUP", fmt.Sprintf("cannot copy %q", filepath.Base(from)))
	}
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Chtimes(to, time.Now(), info.ModTime())
}

// resolveDestination mirrors the local copy/move destination rules: a relative
// path resolves against the pane that made the gesture, and a trailing
// separator asks for a directory.
func resolveDestination(destination, baseDir string) (dest string, forceDirectory bool, err error) {
	base := baseDir
	if base == "" {
		base, _ = os.Getwd()
	}
	base, err = filepath.Abs(base)
	if err != nil {
		return "", false, err
	}
	dest = destination
	if !filepath.IsAbs(dest) {
		dest = filepath.Join(base, dest)
	}
	dest, err = filepath.Abs(dest)
	if err != nil {
		return "", false, err
	}
	forceDirectory = strings.HasSuffix(destination, "/") || strings.HasSuffix(destination, "\\")
	return dest, forceDirectory, nil
}

func validSources(sources []string) []string {
	valid := make([]string, 0, len(sources))
	for _, source := range sources {
		if source != "" {
			valid = append(valid, source)
		}
	}
	return valid
}

func copyEntries(sources []string, destination, baseDir string) (*CopyOutcome, error) {
	dest, forceDirectory, err := resolveDestination(destination, baseDir)
	if err != nil {
		return nil, err
	}
	valid := validSources(sources)

	var destStats os.FileInfo
	if info, statErr := os.Lstat(dest); statErr == nil {
		destStats = info
	}
	intoDirectory := (destStats != nil && destStats.IsDir()) ||
		(destStats == nil && (forceDirectory || len(valid) > 1))

	if intoDirectory && destStats != nil && !destStats.IsDir() {
		return nil, fsError("ENOTDIR", fmt.Sprintf("%q is not a directory", filepath.Base(dest)))
	}
	if !intoDirectory && len(valid) > 1 {
		return nil, fsError("ENOTDIR", "Copying several entries needs an existing destination directory")
	}
	if intoDirectory && destStats == nil {
		if mkErr := os.MkdirAll(dest, 0o755); mkErr != nil {
			return nil, mkErr
		}
	}

	destDir := dest
	if !intoDirectory {
		destDir = filepath.Dir(dest)
	}
	copied := make([]string, 0, len(valid))
	failed := make([]CopyFailure, 0)

	for _, source := range valid {
		from, absErr := filepath.Abs(source)
		if absErr != nil {
			failed = append(failed, CopyFailure{Path: source, Error: toFsError(absErr)})
			continue
		}
		to := dest
		if intoDirectory {
			to = filepath.Join(dest, filepath.Base(from))
		}
		if _, statErr := os.Lstat(to); statErr == nil {
			message := fmt.Sprintf("%q already exists", filepath.Base(to))
			if intoDirectory {
				message = fmt.Sprintf("%q already exists in %q", filepath.Base(to), destDir)
			}
			failed = append(failed, CopyFailure{Path: from, Error: fsError("EEXIST", message)})
			continue
		}
		if strings.HasPrefix(to, from+string(os.PathSeparator)) {
			failed = append(failed, CopyFailure{Path: from, Error: fsError("EINVAL", "Cannot copy a directory into itself")})
			continue
		}
		if cpErr := copyTree(from, to); cpErr != nil {
			failed = append(failed, CopyFailure{Path: from, Error: toFsError(cpErr)})
			continue
		}
		copied = append(copied, to)
	}
	return &CopyOutcome{Copied: copied, Failed: failed, Destination: destDir}, nil
}

func moveEntries(sources []string, destination, baseDir string) (*MoveOutcome, error) {
	dest, forceDirectory, err := resolveDestination(destination, baseDir)
	if err != nil {
		return nil, err
	}
	valid := validSources(sources)

	var destStats os.FileInfo
	if info, statErr := os.Lstat(dest); statErr == nil {
		destStats = info
	}
	intoDirectory := (destStats != nil && destStats.IsDir()) ||
		(destStats == nil && (forceDirectory || len(valid) > 1))

	if intoDirectory && destStats != nil && !destStats.IsDir() {
		return nil, fsError("ENOTDIR", fmt.Sprintf("%q is not a directory", filepath.Base(dest)))
	}
	if !intoDirectory && len(valid) > 1 {
		return nil, fsError("ENOTDIR", "Moving several entries needs an existing destination directory")
	}
	if intoDirectory && destStats == nil {
		if mkErr := os.MkdirAll(dest, 0o755); mkErr != nil {
			return nil, mkErr
		}
	}

	destDir := dest
	if !intoDirectory {
		destDir = filepath.Dir(dest)
	}
	moved := make([]string, 0, len(valid))
	failed := make([]MoveFailure, 0)

	for _, source := range valid {
		from, absErr := filepath.Abs(source)
		if absErr != nil {
			failed = append(failed, MoveFailure{Path: source, Error: toFsError(absErr)})
			continue
		}
		to := dest
		if intoDirectory {
			to = filepath.Join(dest, filepath.Base(from))
		}
		if from == to {
			continue
		}
		if from == "/" {
			failed = append(failed, MoveFailure{Path: from, Error: fsError("EPERM", "Refusing to move a filesystem root")})
			continue
		}
		if _, statErr := os.Lstat(to); statErr == nil {
			message := fmt.Sprintf("%q already exists", filepath.Base(to))
			if intoDirectory {
				message = fmt.Sprintf("%q already exists in %q", filepath.Base(to), destDir)
			}
			failed = append(failed, MoveFailure{Path: from, Error: fsError("EEXIST", message)})
			continue
		}
		if strings.HasPrefix(to, from+string(os.PathSeparator)) {
			failed = append(failed, MoveFailure{Path: from, Error: fsError("EINVAL", "Cannot move a directory into itself")})
			continue
		}
		renameErr := os.Rename(from, to)
		if renameErr != nil && errors.Is(renameErr, syscall.EXDEV) {
			if cpErr := copyTree(from, to); cpErr != nil {
				failed = append(failed, MoveFailure{Path: from, Error: toFsError(cpErr)})
				continue
			}
			if rmErr := os.RemoveAll(from); rmErr != nil {
				failed = append(failed, MoveFailure{Path: from, Error: toFsError(rmErr)})
				continue
			}
			renameErr = nil
		}
		if renameErr != nil {
			failed = append(failed, MoveFailure{Path: from, Error: toFsError(renameErr)})
			continue
		}
		moved = append(moved, to)
	}
	return &MoveOutcome{Moved: moved, Failed: failed, Destination: destDir}, nil
}

func deleteEntries(targets []string) (*DeleteOutcome, error) {
	deleted := make([]string, 0, len(targets))
	failed := make([]DeleteFailure, 0)
	for _, target := range targets {
		if target == "" {
			continue
		}
		resolved, err := filepath.Abs(target)
		if err != nil {
			failed = append(failed, DeleteFailure{Path: target, Error: toFsError(err)})
			continue
		}
		if resolved == "/" {
			failed = append(failed, DeleteFailure{Path: resolved, Error: fsError("EPERM", "Refusing to delete a filesystem root")})
			continue
		}
		// force:false keeps a missing or protected path an error instead of a
		// silent success, so existence is checked before the recursive remove.
		if _, statErr := os.Lstat(resolved); statErr != nil {
			failed = append(failed, DeleteFailure{Path: resolved, Error: toFsError(statErr)})
			continue
		}
		if err := os.RemoveAll(resolved); err != nil {
			failed = append(failed, DeleteFailure{Path: resolved, Error: toFsError(err)})
			continue
		}
		deleted = append(deleted, resolved)
	}
	return &DeleteOutcome{Deleted: deleted, Failed: failed}, nil
}

// addHiddenName appends a name to a directory's .mchide file. It is idempotent
// and adds the newline the previous writer might have left out, so the new name
// cannot join the last line and hide whatever that line spelled.
func addHiddenName(dir, name string) (string, error) {
	if dir == "" || name == "" || strings.ContainsAny(name, "\r\n") {
		return "", fsError("EINVAL", fmt.Sprintf("%q cannot be listed in %s", name, hideMarker))
	}
	resolved, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	file := filepath.Join(resolved, hideMarker)
	existing, readErr := os.ReadFile(file)
	if readErr != nil && !errors.Is(readErr, fs.ErrNotExist) {
		return "", readErr
	}
	for _, listed := range parseHiddenNames(string(existing)) {
		if listed == name {
			return file, nil
		}
	}
	content := string(existing)
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	content += name + "\n"
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		return "", err
	}
	return file, nil
}

func directorySize(input string) (int64, error) {
	root, err := filepath.Abs(input)
	if err != nil {
		return 0, err
	}
	var total int64
	err = filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Only the folder the user asked about can fail the answer; an
			// unreadable subdirectory is simply not part of what can be counted.
			if current == root {
				return walkErr
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			return nil
		}
		total += info.Size()
		return nil
	})
	if err != nil {
		return 0, err
	}
	return total, nil
}

func canExec(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// decodeBlobJSON is a small helper for operations whose response is only JSON;
// it keeps the dispatch table readable.
func decodeBlobJSON(payload []byte, v any) error {
	return json.Unmarshal(payload, v)
}

// watchers is the registry of directory polls. The app refcounts a watch in
// main; the relay does the same so two panes on one directory share one poll.
var watchers = struct {
	sync.Mutex
	m map[string]*dirWatcher
}{m: map[string]*dirWatcher{}}

type dirWatcher struct {
	path  string
	refs  int
	stop  chan struct{}
	state map[string]fileStamp
}

type fileStamp struct {
	size  int64
	mtime int64
}
