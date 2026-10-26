# Monda Commander

A modern orthodox (dual-pane) file manager with a VSCode-inspired UI.
Electron + electron-vite + Vue 3 + TypeScript + Tailwind v4.
Integrated terminal via xterm.js + node-pty. Linux is the primary target.

The rules are here; the full reasoning is one link away, in
[`docs/design.md`](docs/design.md), and is worth reading before undoing anything
that looks arbitrary. Keys are in [`docs/keybindings.md`](docs/keybindings.md);
dev-mode verification (on request only — see below) is in
[`docs/verifying.md`](docs/verifying.md).

## Commands

```bash
npm run dev          # dev server + Electron with HMR
npm run dev:sandboxed # same, but keeps the renderer sandbox (needs setuid chrome-sandbox)
npm run build        # typecheck, then build main/preload/renderer into out/
npm start            # preview the production build
npm run typecheck    # tsc (main/preload) + vue-tsc (renderer)
npm run dist:linux   # electron-builder AppImage + deb  (not yet verified end-to-end)
```

There is no linter or test runner configured yet.

**Do not visually or interactively test changes unless explicitly asked.** The
user does the visual and interaction testing by default; launching, restarting or
driving the dev app (xdotool, screenshots, CDP) is slow and disruptive. The steps
for when it is wanted are in [`docs/verifying.md`](docs/verifying.md).

## Architecture

```
src/main/index.ts        window lifecycle, single-instance lock
src/main/windowState.ts  remembered window size/position/maximized flag
src/main/ipc/fs.ts       IPC: fs:home, fs:list, fs:read, fs:write, fs:read-image,
                         fs:image-size, fs:open, fs:reveal, fs:hide-add, fs:mkdir
src/main/imageSize.ts    header-only image dimensions (PNG/JPEG+EXIF/GIF/BMP/ICO/WebP/SVG)
src/main/videoCodec.ts   header-only codec sniff for ISOBMFF (mp4/m4v/mov)
src/main/media.ts        mc-media scheme: ranged video stream + live ffmpeg transcode
src/main/ipc/watch.ts    IPC: fs:watch, fs:unwatch; pushes fs:changed
src/main/ipc/pty.ts      IPC: pty:create/write/resize/kill/state; pushes pty:data, pty:exit
src/main/ipc/window.ts   IPC: window:minimize/toggle-maximize/close/is-maximized
src/main/ipc/hide.ts     IPC: hide:get, hide:set
src/main/hideMode.ts     hide mode persisted in userData/hide-mode.json
src/preload/index.ts     contextBridge -> window.mc (implements McApi)
src/shared/types.ts      DirEntry/DirListing/Result/ImagePreview/PixelSize/Pty* types
src/shared/api.ts        McApi interface (the preload contract)
src/shared/image.ts      extension -> previewable image MIME map
src/shared/video.ts      video MIME map, ffmpeg-only extensions, decodable codecs, scheme name
src/shared/hide.ts       the `.mchide` name, the toggle key, the two tooltips
src/renderer/src/App.vue global keyboard model, workspace stack, layout, focus
src/renderer/src/components/TitleBar.vue       frameless title bar + window controls;
                                               hosts the workspace tab strip
src/renderer/src/components/WorkspaceTabs.vue  the tab strip
src/renderer/src/components/FilePanel.vue      one pane: path bar, list, footer, display
src/renderer/src/components/TerminalPane.vue   xterm: collapsed strip / full terminal
src/renderer/src/components/FileViewer.vue     Monaco overlay: read-only (F3) or edit (F4)
src/renderer/src/components/PaneContextMenu.vue  a row's menu
src/renderer/src/components/HoldRing.vue       the ring on a held right press
src/renderer/src/composables/useWorkspace.ts   one tab: its two panes, its shell, cwd sync
src/renderer/src/composables/useShell.ts       createShell(id): one shell session
                                               (own process, buffer, cwd, line model)
src/renderer/src/composables/useDirectory.ts   per-pane navigation state + actions
src/renderer/src/composables/useHideMode.ts    the hide mode's on/off state
src/renderer/src/lib/format.ts        size/date/permission formatting
src/renderer/src/lib/executable.ts    runnable/green rule and `shouldExecute`
src/renderer/src/lib/preview.ts       preview target, PlaybackClock, stage requests
src/renderer/src/lib/monaco.ts        lazy monaco import + worker wiring + language
src/renderer/src/lib/fileIcon.ts      per-entry icon: name/extension -> 24x24 svg
                                      (FILENAME_ICONS, EXTENSION_ICONS, fallback text)
src/renderer/src/lib/swapAnimation.ts how a Ctrl+U exchange is shown: copies of
                                      both panes travelling to the other column,
                                      carrying the display's blur (styles/swap.css)
src/renderer/src/lib/paneMenu.ts      the context menu's model
```

Styles are referenced inline below: `styles/mark.css`, `hold.css`, `notice.css`,
`flash.css`, `osd.css`, `swap.css`, `viewer.css`, all under
`src/renderer/src/`.

## Gotchas

The reasoning behind every rule here is in [`docs/design.md`](docs/design.md).

### Build and packaging

- **TypeScript must stay on 5.x.** `vue-tsc` cannot run against TypeScript 7 (the
  native compiler no longer exposes `./lib/tsc`). Do not upgrade without replacing
  the renderer typechecker.
- **Preload builds to `out/preload/index.mjs`** (ESM), which requires
  `sandbox: false` in `webPreferences`. `src/main/index.ts` probes for `.mjs` then
  `.js` so a CJS build still works.
- **`--noSandbox` in the dev script** is a dev-only workaround: the bundled
  `chrome-sandbox` is not setuid on this machine. Use `npm run dev:sandboxed` once
  the helper is configured correctly.
- **node-pty needs no `electron-rebuild`** — it is N-API based, so the prebuilt
  binary loads unchanged. `postinstall` runs `install-app-deps` regardless, and
  `asarUnpack` keeps the native module extractable.
- **`ELECTRON_RUN_AS_NODE` is set in this shell environment.** Unset it when
  launching Electron directly, or it runs as plain Node:
  `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron .`

### Window and shell

- **The window is frameless** (`frame: false`); `TitleBar.vue` replaces the OS
  decoration. Moving it depends on `-webkit-app-region`: the header is
  `drag-region` and interactive children must be `no-drag`, or a new control
  silently swallows clicks. Double-click-to-maximize must key off `button`
  targets, not `no-drag` ones, or the tab strip (`no-drag flex-1`) eats every
  double-click on the bar's empty middle.
- **The app is a stack of workspaces**, one tab each; a workspace owns its panes
  and its shell, only the active one is rendered, and a returning tab replays its
  session buffer.
- **The shell outlives its view.** `TerminalPane` must not kill the shell on
  unmount — only `shell.dispose()` on tab close does. `attachTerminal` does not
  drain the output buffer, and a workspace object survives tab switches, so a
  remount re-attaches instead of respawning.
- **The collapsed strip is the shell, so its input line is state we model.**
  `shell.inputLine` (one per workspace) is fed from `onData`; it decides whether
  `Enter` runs the line or activates the panel entry.
- **The panel and the shell keep their cwd in sync in both directions**, which
  needs a guard: the shell's cwd is polled (300ms), so `pendingPush` in
  `useWorkspace.ts` marks the path we asked for so stale reads cannot bounce the
  panel back, and injection is gated on `pty:state` reporting the shell is at a
  prompt.
- **Panel→shell sync types a real `cd` into a real prompt**, so the injected line
  erases its own echo (`printf '\033[1A\033[2K'`), deletes its own history entry
  (`history -d "$HISTCMD"`, guarded on `$BASH_VERSION`) and is *not*
  space-prefixed (`HISTCONTROL=ignorespace` would misnumber it). It needs a spare
  row, so `refit()` clamps the terminal to ≥2 rows; the strip clips to exactly the
  **cursor's** row (`applyStripViewport`), and the host carries no vertical
  padding because `overflow: hidden` clips at the padding box.
- **`pty:state` is Linux-only** (`/proc/<pid>/cwd`, `tpgid`); elsewhere it reports
  `idle: false`, which disables injection rather than guessing.

### Directory listing

- **A pane's directory is watched, not polled.** Main refcounts watchers per
  webContents id, *not* per directory (two panes can share one). Notifications are
  debounced (200ms trailing, never later than 750ms after a burst's first event).
- **A refresh highlights what changed.** `fresh` → `flash-row` → `flash-sweep`
  (`styles/flash.css`); the clear timer is re-armed by every refresh; a batch over
  150 entries is skipped.
- **Only changes made behind the app's back sweep.** `beginSelfChange` /
  `endSelfChange` in `useDirectory` silence `markFresh` for the operation plus a
  1000ms tail. `App.vue` wraps the F5/F6 transfer on both panes and mutes the
  panes at the shell's directory from a submitted command until it settles.
- **The pane's row list must contain only entries.** The status notice is a
  sibling of the `<ul>`, never an `<li>` (an extra `<li>` shifts every index). The
  notice travels (`styles/notice.css`) and is keyed by its text.

### The hide mode

- **A `.mchide` file puts a directory in hide mode.** It is a list of names, one
  per line; main reports them in `DirListing.hiddenNames` and the *pane* filters.
  Read and write go through one parser each (`parseHiddenNames`, `main/ipc/fs.ts`).
  `fs:hide-add` appends (refusing empty/multiline names, adding a leading newline
  when needed), switches the mode *on*, and flags the change as the app's own.
- **The hide mode is one remembered state for the whole app.** `toggleHideMode`
  is a module-level ref; covered marks are dropped (`pruneSelection`); it is
  persisted via `hide:get`/`hide:set` to `userData/hide-mode.json` and read once
  on mount before the first listing. Alt+. is claimed *after* the
  expanded-terminal check. The pane title bar's icon is an eye-off (on) / a dim
  eye (off), both in the title text's color, never gold.

### Marks, the right button, and the context menu

- **A mark is a gold band across the row, and nothing else changes.** `bg-marked`
  (`#625018`), hand-picked, not mixed. When the cursor coincides, the cursor's band
  stays and the mark is *added* (`row-mark`), so "row I am on" and "row I marked"
  stay tellable apart.
- **The marked-and-cursored row** is drawn by `row-mark` in `styles/mark.css`
  (gold weave + `box-shadow` frame); the weave's band is `transparent` so it lands
  on the inactive grey, and the weave yields to `flash-row` (both want
  `background-image`).
- **A right click toggles the mark on the release; a right drag paints one across
  the rows it sweeps; a right press held opens the menu.** None moves the cursor.
  Told apart by time and pointer behaviour (`HOLD_SLOP_PX`, `HOLD_MENU_MS` 450ms,
  `HOLD_HINT_MS` 150ms ring), not a modifier. The mark is decided from the row as
  pressed (so a marked row unmarks) and a sweep *paints* one answer rather than
  toggling. A hold is abandoned on window blur. `Ctrl+right-click` asks for the
  menu outright.
- **The menu is the app's; the pane only asks for it.** `FilePanel` emits
  `context-menu` with the row's *path*; the app owns `PaneContextMenu.vue` /
  `lib/paneMenu.ts`. Opening it puts the cursor on the row; entries are captured at
  open; **opening the row is deliberately not an item**. `Shift+F10` (not `F10` —
  that is the terminal programs' key) and the `Menu` key anchor from
  `cursorMenuAnchor`. The menu holds the keyboard by holding *focus*, so focus must
  wait until placement is in the DOM (a hidden element cannot be focused), and
  `ownsKey` drops any foreign key. The window-sized backdrop is the dismissal and
  carries `@contextmenu.prevent`. No menu on the `..` row or the empty space below.

### Files

- **A file the user can run is named in green** — `isRunnable` needs both an exec
  bit and a name the icon table has not recognized as data. The color goes on the
  name span (`nameClass`); `text-selected` overrides it on the cursor-over-mark row.
- **A broken symlink's target is red** — `kind` is `symlink` only when `stat`
  through the link failed; only the target span takes the color.
- **A runnable file is run on `Enter`, in the panes' own shell.** `shouldExecute`
  is the green rule less a `.desktop`; `runInShell` types the quoted path and
  submits it, so it echoes and reaches history. The terminal is shown for as long
  as it runs; the run ends on `shell.idle`. A busy shell refuses a second command.
- **`F7` makes a directory in the pane being browsed.** `fs:mkdir` resolves the
  name against that pane (absolute, or relative, as the transfer dialogs do) and
  is deliberately *not* recursive, so an existing name is an `EEXIST` the pane
  reports rather than a silent success; the new folder does not sweep, because
  every pane showing the directory is told the change is the app's own.

### The preview footer

- **A pane footer previews the image under its cursor.** `fs:read-image` returns a
  `data:` URL (shared map in `src/shared/image.ts`); space is reserved from the
  moment the cursor lands. The strip's *growth* is animated, its shrink snaps;
  `listSlack` keeps the rows from moving; `fs:image-size` reads the header (EXIF
  aware) so the box is the right ratio before the image arrives. Reads settle
  (`PREVIEW_SETTLE_MS`), are keyed by path+size/mtime, token-guarded and cached in
  main. ≤16 MiB travels as bytes, larger is downscaled to 512px; ≥64 MiB and
  undecodable is refused.
- **A pane footer plays the video under its cursor, silently.** `mc-media` is a
  ranged stream (`src/main/media.ts`); the element is muted and plays once. The
  bar shows position/length (`fs:video-duration` for an encoded clip). A `.mov` is
  served as `video/mp4` (`videoMimeFor`). The element mounts only after the cursor
  settles. The hardware video decoder is disabled in `src/main/index.ts`.

### Display and full-screen

- **A display is a mode of the panes, not a third overlay.** `Enter` hands media
  to the *other* pane; the cursor stays and the asking pane keeps the keyboard.
  The listing is blurred behind it (`filter` + `clip-path: inset(0)`). What shows
  is derived from the cursor (`stageTarget`). `Tab` is claimed; `Ctrl+U` carries
  the display. The reveal grows out of / shrinks back onto the footer thumbnail;
  the clip's sound is ramped (muted at rest) and it does not loop. The display
  *takes the clip over* (`stage-clock` + `resumeAt` both ways). `seekPreview` on
  the arrows, `wheelScrub` on the wheel (`overStageMedia` distinguishes the
  picture/transport from the folder).
- **A clip action is answered by a YouTube-style OSD** (`PlaybackOsd.vue`,
  `styles/osd.css`) that owns only the animation and reports done via a `done`
  event; one per surface. `seek()` flashes, a transport drag does not.
- **The full-screen mode is the same display over the whole window** (`Ctrl+Enter`
  / triple-click). The overlay becomes `fixed inset-0 z-50`; the full-screen
  presentation owns `Tab` and `Escape` window-wide. A presentation change travels
  (`switchStagePresentation`, `stageTravelling` at `z-40`); the backdrop is
  `stageBackdrop` (faded, not switched); leaving latches `fullscreenPresentation`.
  The pane row must be `isolate` **and** `relative z-10`.

### Media codecs

- **A clip Chromium cannot play is transcoded, when ffmpeg is there.** A second
  extension list in `src/shared/video.ts`; H.264 at ≤720px with sound, streamed as
  it is produced (`empty_moov` + `frag_keyframe`, keyframe every 30 frames). `from`
  is the whole of seeking (`-ss` before input); length comes from
  `fs:video-duration`. Gated on `fs:can-transcode`; `MC_FFMPEG` names the binary.
- **A container Chromium demuxes is not a stream Chromium decodes.** `videoCodec.ts`
  box-walks to the `stsd` sample entry; `DECODABLE_VIDEO_CODECS` (avc1/avc3,
  vp08/vp09, av01) vs `codecNeedsTranscode`. The answer rides
  `PreviewTarget.encode`; `probeVideoCodec` asks `fs:video-codec` on the cursor
  move, memoized by path/size/mtime. The verdict settles only once the header is
  read, so a footer preview can collapse a moment after the extension claimed it.

### The viewer

- **The viewer is a modal overlay over the panes and terminal.** While open, the
  window handler consumes only `Escape` (the rest is Monaco's). Closing is
  delegated to `isDirty()` via a template ref, then `ConfirmDiscard`; a save
  failure sets `saveError`, never `error` (which would unmount the buffer). A
  `truncated` file is refused for editing.
- **A file nothing can be shown of never opens the viewer.** `openViewer` reads
  first and hands the `FileContent` in; a refusal is the *pane's* notice, worded
  for the user (`EBINARY` special-cased). The read is token-guarded.
- **Viewing (F3) has no cursor** — the remap uses `editor.addAction(...)`, never
  `addCommand`, at the core `scroll*` ids, gated on `'textInputFocus'`. `addCommand`
  leaks a global keybinding that outlives the view and swallows a later F4 editor's
  arrows. The caret is hidden by `styles/viewer.css`.
- **Monaco is imported lazily**, workers answered by `MonacoEnvironment.getWorker`
  via Vite `?worker` imports; `fs:read` uses `O_RDONLY | O_NONBLOCK` + a NUL test +
  an 8 MiB ceiling. The language is the **name first, the shebang second**
  (`languageFor`); only interpreters with a fitting tokenizer are mapped.

### The terminal

- **The mono font is bundled** (`JetBrainsMono Nerd Font Mono`, `@font-face` over
  the two TTFs in `src/renderer/src/assets/fonts/`); `TerminalPane` re-fits on
  `document.fonts.ready`, since the first `fit()` measures a fallback.
- **The terminal's cell is the font's own line box** (`lineHeight: 1.0` → 16px),
  which is what keeps a TUI's frames joined. `customGlyphs` does nothing under the
  DOM renderer.
- **The terminal is a surface of its own**: xterm `background`/`cursorAccent` are
  `--color-surface-2`, and the sixteen ANSI slots are **xterm's defaults**, not VS
  Code's.

### Keyboard and focus

- **Intercepted keys must `stopPropagation`, not just `preventDefault`.** xterm
  ignores `defaultPrevented`; `consume()` in `App.vue` does both, registered in
  setup so it runs ahead of xterm's.
- **Incremental search holds DOM focus in its input**, so `handlePaneKey` lets
  editing keys through and intercepts only navigation keys.
- **Focus model:** the command line holds focus whenever the terminal does not, so
  `focusPanes()` focuses the command line. The search box and the terminal are the
  other two targets.

### Styling

- **Tailwind v4 is configured CSS-first** (`@theme` in `styles/main.css`), no
  `tailwind.config.js`. Theme tokens are the design system — prefer `bg-surface`,
  `text-fg-dim`, `border-border` over raw hex.
- **The renderer has a CSP** in `src/renderer/index.html`. `img-src data:` and
  `media-src mc-media:` are what let a footer show a preview the renderer has no
  URL for.

## Conventions

- Keep filesystem and pty access in the main process; the renderer only talks to
  `window.mc`. Never enable `nodeIntegration`.
- IPC handlers return `Result<T>` instead of throwing across the bridge.
- The security model is contextIsolation on, nodeIntegration off, and the preload
  exposes a narrow, explicitly typed surface.
