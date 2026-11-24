//go:build !windows

package main

// The Unix half of the platform-specific filesystem facts: the raw mode bits,
// the filesystem's occupancy, and the mount point. Windows answers the same
// three questions in stat_windows.go.

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// rawMode returns the Unix mode bits the way Node's `stats.mode` does, type
// bits included. Go's FileMode is a portable representation, so the raw value
// is read from the syscall stat when it is available.
func rawMode(info os.FileInfo) uint32 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		// Darwin's `Stat_t.Mode` is a uint16 where Linux's is a uint32, so the
		// conversion is what lets one binary compile on both.
		return uint32(stat.Mode)
	}
	return uint32(info.Mode())
}

// filesystemSpace is the occupancy of the filesystem holding path, in bytes:
// the total, what `df` calls used (the total less the free blocks), and what an
// unprivileged writer may still use.
func filesystemSpace(path string) (total, used, free int64, err error) {
	var stat syscall.Statfs_t
	if err = syscall.Statfs(path, &stat); err != nil {
		return 0, 0, 0, err
	}
	blockSize := int64(stat.Bsize)
	return blockSize * int64(stat.Blocks),
		blockSize * (int64(stat.Blocks) - int64(stat.Bfree)),
		blockSize * int64(stat.Bavail),
		nil
}

// mountPointFor reads the longest mount point in /proc/self/mountinfo that holds
// the path, so a directory on a nested mount answers with the inner one rather
// than the root. Null when the file cannot be read.
func mountPointFor(target string) *string {
	data, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	best := ""
	for _, line := range strings.Split(string(data), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, " ")
		if len(fields) < 5 {
			continue
		}
		mount := decodeMountPath(fields[4])
		if !isWithinMount(target, mount) {
			continue
		}
		if len(mount) > len(best) {
			best = mount
		}
	}
	if best == "" {
		return nil
	}
	return &best
}

// decodeMountPath undoes the octal escapes /proc uses for a path (`\040` for a
// space, and so on).
func decodeMountPath(raw string) string {
	var out strings.Builder
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+3 < len(raw) {
			if value, err := strconv.ParseInt(raw[i+1:i+4], 8, 32); err == nil {
				out.WriteByte(byte(value))
				i += 3
				continue
			}
		}
		out.WriteByte(raw[i])
	}
	return out.String()
}

// isWithinMount reports whether target sits at or under mount, on a path
// boundary.
func isWithinMount(target, mount string) bool {
	if mount == "/" {
		return strings.HasPrefix(target, "/")
	}
	prefix := mount
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return target == mount || strings.HasPrefix(target, prefix)
}
