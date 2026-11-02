package main

// Directory watches are polls, not inotify. A poll costs one readdir a second
// and needs no kernel subscription the remote may not offer; the app's panes
// already re-list on an event, so a second's delay is the price of a transport
// that works anywhere. Refcounted per path so two panes on one directory share
// one poll, exactly as the local watcher shares one inotify watch.

import (
	"os"
	"path/filepath"
	"sync"
	"time"
)

type stamp struct {
	size  int64
	mtime int64
}

type watchKey struct {
	kind string
	path string
}

type watchEntry struct {
	refs int
	stop chan struct{}
}

var (
	watchMu  sync.Mutex
	watchMap = map[watchKey]*watchEntry{}
)

const watchInterval = time.Second

func startWatch(conn *Conn, path, kind string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	key := watchKey{kind: kind, path: absolute}
	watchMu.Lock()
	if entry := watchMap[key]; entry != nil {
		entry.refs++
		watchMu.Unlock()
		return nil
	}
	entry := &watchEntry{refs: 1, stop: make(chan struct{})}
	watchMap[key] = entry
	watchMu.Unlock()

	go pollWatch(conn, absolute, kind, entry.stop)
	return nil
}

func stopWatch(path, kind string) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return
	}
	key := watchKey{kind: kind, path: absolute}
	watchMu.Lock()
	defer watchMu.Unlock()
	entry := watchMap[key]
	if entry == nil {
		return
	}
	entry.refs--
	if entry.refs > 0 {
		return
	}
	close(entry.stop)
	delete(watchMap, key)
}

func pollWatch(conn *Conn, path, kind string, stop chan struct{}) {
	ticker := time.NewTicker(watchInterval)
	defer ticker.Stop()
	last := snapshot(path, kind)
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			current := snapshot(path, kind)
			if sameSnapshot(last, current) {
				continue
			}
			last = current
			_ = conn.SendEvent(Event{Type: kind, Path: path})
		}
	}
}

// snapshot records what a directory holds and when each entry last changed. A
// git watch also samples the files git itself rewrites, since a commit changes
// .git/index and a checkout changes HEAD without adding or removing an entry in
// the work tree.
func snapshot(path, kind string) map[string]stamp {
	result := map[string]stamp{}
	record := func(name, full string) {
		info, err := os.Lstat(full)
		if err != nil {
			return
		}
		result[name] = stamp{size: info.Size(), mtime: info.ModTime().UnixNano()}
	}
	entries, err := os.ReadDir(path)
	if err == nil {
		for _, entry := range entries {
			record(entry.Name(), filepath.Join(path, entry.Name()))
		}
	}
	if kind == "git:changed" {
		record(".git/index", filepath.Join(path, ".git", "index"))
		record(".git/HEAD", filepath.Join(path, ".git", "HEAD"))
	}
	return result
}

func sameSnapshot(a, b map[string]stamp) bool {
	if len(a) != len(b) {
		return false
	}
	for name, value := range a {
		if b[name] != value {
			return false
		}
	}
	return true
}

func stopAllWatches() {
	watchMu.Lock()
	defer watchMu.Unlock()
	for key, entry := range watchMap {
		close(entry.stop)
		delete(watchMap, key)
	}
}
