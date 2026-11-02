package main

// Git is asked, not reimplemented. The relay runs the same porcelain command
// the local app runs and parses the same records, so a remote pane's marks mean
// what a local pane's marks mean.

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

type GitFileStatus struct {
	Path     string  `json:"path"`
	Index    string  `json:"index"`
	Worktree string  `json:"worktree"`
	From     *string `json:"from"`
}

type GitStatus struct {
	Root     string          `json:"root"`
	Branch   *string         `json:"branch"`
	Oid      *string         `json:"oid"`
	Detached bool            `json:"detached"`
	Ahead    int             `json:"ahead"`
	Behind   int             `json:"behind"`
	Files    []GitFileStatus `json:"files"`
}

// gitEnv is the environment a read must run in. A status read that is allowed
// to take the optional index lock refreshes `.git/index` in place as a side
// effect — which changes `.git`, which the directory watcher then reports, which
// makes the pane re-list and ask git again: an endless sweep. The local app sets
// exactly these, so a remote pane behaves like a local one.
func gitEnv() []string {
	var filtered []string
	for _, entry := range os.Environ() {
		key := entry
		if idx := strings.IndexByte(entry, '='); idx >= 0 {
			key = entry[:idx]
		}
		switch key {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR":
			continue
		}
		filtered = append(filtered, entry)
	}
	return append(filtered, "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
}

func runGit(dir string, args ...string) ([]byte, error) {
	command := append([]string{"-C", dir}, args...)
	cmd := exec.Command("git", command...)
	cmd.Env = gitEnv()
	return cmd.Output()
}

func gitStatus(dir string) (*GitStatus, error) {
	rootOut, err := runGit(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fsError("ENOTREPO", "not a git repository")
	}
	root := strings.TrimSpace(string(rootOut))

	out, err := runGit(
		dir,
		"--no-optional-locks",
		"status",
		"--porcelain=v2",
		"--branch",
		"--untracked-files=normal",
	)
	if err != nil {
		return nil, fsError("ENOTREPO", "git status failed")
	}

	status := &GitStatus{Root: root, Files: []GitFileStatus{}}
	for _, line := range strings.Split(string(out), "\n") {
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "# branch.oid "):
			oid := strings.TrimPrefix(line, "# branch.oid ")
			if oid != "(initial)" {
				value := oid
				status.Oid = &value
			}
		case strings.HasPrefix(line, "# branch.head "):
			head := strings.TrimPrefix(line, "# branch.head ")
			if head == "(detached)" {
				status.Detached = true
			} else {
				value := head
				status.Branch = &value
			}
		case strings.HasPrefix(line, "# branch.ab "):
			// "+ahead -behind"
			parts := strings.Fields(strings.TrimPrefix(line, "# branch.ab "))
			for _, part := range parts {
				if strings.HasPrefix(part, "+") {
					if ahead, convErr := strconv.Atoi(part[1:]); convErr == nil {
						status.Ahead = ahead
					}
				}
				if strings.HasPrefix(part, "-") {
					if behind, convErr := strconv.Atoi(part[1:]); convErr == nil {
						status.Behind = behind
					}
				}
			}
		case strings.HasPrefix(line, "1 "):
			fields := strings.SplitN(line, " ", 9)
			if len(fields) == 9 {
				xy := fields[1]
				status.Files = append(status.Files, GitFileStatus{
					Path:     fields[8],
					Index:    string(xy[0]),
					Worktree: string(xy[1]),
				})
			}
		case strings.HasPrefix(line, "2 "):
			fields := strings.SplitN(line, " ", 10)
			if len(fields) == 10 {
				xy := fields[1]
				pathField := fields[9]
				from := ""
				path := pathField
				if tab := strings.LastIndex(pathField, "\t"); tab >= 0 {
					path = pathField[:tab]
					from = pathField[tab+1:]
				}
				var fromPtr *string
				if from != "" {
					value := from
					fromPtr = &value
				}
				status.Files = append(status.Files, GitFileStatus{
					Path:     path,
					Index:    string(xy[0]),
					Worktree: string(xy[1]),
					From:     fromPtr,
				})
			}
		case strings.HasPrefix(line, "u "):
			fields := strings.SplitN(line, " ", 11)
			if len(fields) == 11 {
				xy := fields[1]
				status.Files = append(status.Files, GitFileStatus{
					Path:     fields[10],
					Index:    string(xy[0]),
					Worktree: string(xy[1]),
				})
			}
		case strings.HasPrefix(line, "? "):
			status.Files = append(status.Files, GitFileStatus{
				Path:     line[2:],
				Index:    "?",
				Worktree: "?",
			})
		}
	}
	return status, nil
}
