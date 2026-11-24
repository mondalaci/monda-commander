//go:build windows

package main

// The Windows half of the platform-specific filesystem facts: the mode bits,
// the filesystem's occupancy, and the mount point. Unix answers the same three
// questions in stat_unix.go.

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

// rawMode has no Windows counterpart to read: NTFS keeps ACLs rather than Unix
// mode bits, so Go's FileMode is all there is. The pane's Mode columns are
// meaningless here anyway and are hidden.
func rawMode(info os.FileInfo) uint32 {
	return uint32(info.Mode())
}

var (
	kernel32               = syscall.NewLazyDLL("kernel32.dll")
	procGetDiskFreeSpaceEx = kernel32.NewProc("GetDiskFreeSpaceExW")
)

// filesystemSpace is the occupancy of the volume holding path, in bytes, asked
// of `GetDiskFreeSpaceEx` — the Windows equivalent of `statfs`. `used` is the
// volume's total less its total free (what `df` calls used), and `free` is what
// the calling user may still write, which is the same figure for everyone on a
// volume without quotas.
func filesystemSpace(path string) (total, used, free int64, err error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, 0, err
	}
	var freeToCaller, totalBytes, totalFree uint64
	ok, _, callErr := procGetDiskFreeSpaceEx.Call(
		uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(&freeToCaller)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if ok == 0 {
		return 0, 0, 0, callErr
	}
	return int64(totalBytes), int64(totalBytes - totalFree), int64(freeToCaller), nil
}

// mountPointFor is the volume root the path lives on — `C:\` for `C:\Users\…` —
// which is what the pane's tooltip names. Windows has no nested-mount notion to
// walk, so the volume name is the whole answer.
func mountPointFor(target string) *string {
	volume := filepath.VolumeName(target)
	if volume == "" {
		return nil
	}
	root := volume + string(filepath.Separator)
	return &root
}
