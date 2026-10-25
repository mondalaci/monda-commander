# Verifying changes in dev

**Do not visually or interactively test changes unless explicitly asked.** This
manual is here for when the user asks for it; by default they do the visual and
interaction testing themselves, and driving the app (xdotool, screenshots, CDP)
is slow and disruptive. So treat the steps below as on-request only — do not
launch, restart, or drive the dev app to check your own work unless told to.

Nothing here is exotic, but each item below produced a confidently wrong
conclusion at least once, so treat them as required steps.

- **Restarting `npm run dev` leaves instances behind.** Stopping the npm/npx
  wrapper can leave `electron-vite` and Electron running, which keeps port 5173
  held; the next start then silently falls back to **5174** and you now have two
  windows titled `Monda Commander`. Window tools address them by title, so
  `xdotool` and `import` can type into one window and screenshot another. Check
  by **port**, not process count — a single `npx electron-vite` chain already
  matches ~4 processes:
  ```bash
  ss -ltn | grep -E '5173|5174'      # expect exactly one listener
  ```
  Clean up scoped by project path, and use a bracketed pattern so `pkill`
  does not match its own command line (it will otherwise kill your shell):
  ```bash
  for pid in $(pgrep -f "electron-[v]ite dev"; pgrep -f "monda-commander/node_modules/[e]lectron"); do
    case "$(readlink /proc/$pid/cwd 2>/dev/null)" in *monda-commander*) kill "$pid";; esac
  done
  ```
- **The display is 2x scaled.** `xdotool getwindowgeometry` and `import` report
  *physical* pixels — a 1280x820 window measures 2624x1724. Divide by 2 for CSS
  pixels, and never judge a layout from a scaled-down preview: crop the real
  screenshot and compare pixel positions.
- **Drive the UI over CDP**, not by guessing coordinates: start dev with
  `--remoteDebuggingPort 9222` and use `Runtime.evaluate` against the page
  target. Two traps:
  - `Input.insertText` does nothing for xterm — it only drives real inputs. Type
    into the terminal with `Input.dispatchKeyEvent` per character, setting
    `text`.
  - `xdotool` clicks land on whatever window is stacked under the pointer, so
    raise and activate first. `Input.dispatchMouseEvent` respects hit-testing
    (drag regions included) and is the reliable option.
- **`window.mc.pty.state('ws-1')` is the fastest health check.** A live
  shell reports a `cwd`; `cwd: null` means the session has exited, so any typing
  afterwards proves nothing. Workspace sessions are `ws-1`, `ws-2`, ... in
  creation order.
- **A dev-mode HMR update of `App.vue` or `TerminalPane.vue`, and switching
  workspaces, remount the terminal view.** That is harmless (the shell survives
  and the buffer replays), but it does mean a running shell can look "reset"
  mid-test.
