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
src/main/ipc/fs.ts       IPC: fs:home, fs:list, fs:dir-size, fs:dir-size-cancel,
                         fs:read, fs:write, fs:read-image, fs:image-size, fs:open,
                         fs:reveal, fs:hide-add, fs:hide-remove, fs:mkdir
src/main/imageSize.ts    header-only image dimensions (PNG/JPEG+EXIF/GIF/BMP/ICO/WebP/SVG)
src/main/videoCodec.ts   header-only codec sniff for ISOBMFF (mp4/m4v/mov)
src/main/media.ts        mc-media scheme: ranged video stream + live ffmpeg transcode
src/main/pdf.ts          poppler-backed PDF pages: page count and every page's
                         shape (pdfinfo), page -> PNG rasterization (pdftocairo),
                         a page's word boxes for the selection layer (pdftotext
                         -bbox-layout), all probed and cached
src/main/ipc/watch.ts    IPC: fs:watch, fs:unwatch; pushes fs:changed
src/main/ipc/git.ts      IPC: git:status, git:file-base, git:watch, git:unwatch;
                         pushes git:changed (one watcher per work tree)
src/main/gitStatus.ts    the `status --porcelain=v2` reader (pure: no Electron)
src/main/ipc/pty.ts      IPC: pty:create/write/resize/kill/state; pushes pty:data, pty:exit
src/main/ipc/window.ts   IPC: window:minimize/toggle-maximize/close/is-maximized
src/main/ipc/hide.ts     IPC: hide:get, hide:set
src/main/hideMode.ts     hide mode persisted in userData/hide-mode.json
src/main/ipc/quickCd.ts  IPC: quickcd:get, quickcd:set
src/main/quickCd.ts      quick cd directories persisted in userData/quick-cd.json
src/main/pdfView.ts      how a PDF display is sized — a fit (width/page) or a scale
                         of the page's own — persisted in userData/pdf-view.json;
                         IPC: pdf:view-get, pdf:view-set
src/main/model.ts        the model reader (pure: no Electron except the two IPC
                         handlers): a mesh format's bytes read as they stand, a CAD
                         document (STEP/IGES/.fcstd) meshed to STL through FreeCAD
                         (MC_FREECAD), probed once and cached; fs:read-model,
                         fs:can-render-model
src/preload/index.ts     contextBridge -> window.mc (implements McApi)
src/shared/types.ts      DirEntry/DirListing/Result/ImagePreview/PixelSize/Pty* types
src/shared/api.ts        McApi interface (the preload contract)
src/shared/image.ts      extension -> previewable image MIME map
src/shared/pdf.ts        the one PDF extension the panes render in-app, and its MIME
src/shared/model.ts      the two model families by extension: mesh formats the
                         renderer parses (stl/3mf/obj/ply/gltf) and CAD documents
                         main meshes through FreeCAD (step/iges/fcstd)
src/shared/video.ts      video MIME map, ffmpeg-only extensions, decodable codecs, scheme name
src/shared/hide.ts       the `.mchide` name, the toggle key, the two tooltips
src/shared/viewMode.ts   the pane's two view modes (details/thumbnails), the cycle
                         key and the button's tooltip, the tile-size ladder, and the
                         fallback entrance's pacing numbers
src/main/thumbnail.ts    tiles and clip posters read from main: an image decoded
                         and shrunk to a tile, one frame of a video through ffmpeg,
                         LRU-cached; fs:thumbnail (local only)
src/shared/quickCd.ts    the quick cd key and the two tooltips the title-bar
                         button is spoken with
src/shared/archive.ts    the archive location model: the NUL-joined
                         `<archive>\0<inner>` string, its split/normalize/display
                         helpers, and the enterable-extension list
src/main/archive.ts      the 7z-backed archive reader (pure: no Electron):
                         listing with synthesized dirs, entry reads, folder sums,
                         and the tar-inside-a-wrapper chain
src/renderer/src/App.vue global keyboard model, workspace stack, layout, focus
src/renderer/src/components/TitleBar.vue       frameless title bar + window controls;
                                               hosts the workspace tab strip
src/renderer/src/components/WorkspaceTabs.vue  the tab strip
src/renderer/src/components/FilePanel.vue      one pane: path bar, list, footer, display
src/renderer/src/components/ThumbnailGrid.vue  a pane's rows as a windowed wall of
                                               tiles, when its view mode is thumbnails
src/renderer/src/components/DiskUsage.vue      the pane title's disk-occupancy widget:
                                               `used / total` inside a progress bar,
                                               with the mount point in its tooltip
src/renderer/src/components/TerminalPane.vue   xterm: collapsed strip / full terminal
src/renderer/src/components/ModelViewer.vue    three.js canvas for a 3D model: the
                                               footer thumbnail (auto-turning) and
                                               the display (orbit + wheel zoom)
src/renderer/src/components/ModelWall.vue     the thumbnail wall's 3D tiles: one
                                               WebGL renderer painting every model
                                               through a scissor box (all turning)
src/renderer/src/components/FileViewer.vue     Monaco overlay: read-only (F3) or edit (F4)
src/renderer/src/components/PaneContextMenu.vue  a row's menu
src/renderer/src/components/HoldRing.vue       the ring on a held right press
src/renderer/src/components/ColumnAddButton.vue    the column editor's gap "+"
src/renderer/src/components/ColumnDropMarker.vue  the arrow + line insertion point
src/renderer/src/composables/useWorkspace.ts   one tab: its two panes, its shell, cwd sync
src/renderer/src/composables/useShell.ts       createShell(id): one shell session
                                               (own process, buffer, cwd, line model)
src/renderer/src/composables/useDirectory.ts   per-pane navigation state + actions
src/renderer/src/composables/useHideMode.ts    the hide mode's on/off state
src/renderer/src/composables/useQuickCd.ts     the app-wide quick cd directory list
src/renderer/src/composables/usePdfView.ts      the app-wide PDF fit + magnification
src/renderer/src/lib/format.ts        size/date/permission formatting
src/renderer/src/lib/executable.ts    runnable/green rule and `shouldExecute`
src/renderer/src/lib/archive.ts       the archive-support ref (`fs:can-archive`),
                                      asked once so Enter knows what a `.zip` means
src/renderer/src/lib/preview.ts       preview target, PlaybackClock, stage requests
src/renderer/src/lib/pdf.ts           the shared page each PDF is on, keyed by file,
                                      plus the stacked document's layout and the one
                                      probe of its page count and page shapes
src/renderer/src/lib/model.ts         three.js loaders: a model's bytes -> one scene
                                      object (mesh formats), with the neutral
                                      material a bare STL/PLY is shaded in
src/renderer/src/lib/monaco.ts        lazy monaco import + worker wiring + language
src/renderer/src/lib/fileIcon.ts      per-entry icon: name/extension -> 24x24 svg
                                      (FILENAME_ICONS, EXTENSION_ICONS, fallback text)
src/renderer/src/lib/gitMark.ts       git status -> per-row marks, folder roll-ups,
                                      and the palette they are drawn in
src/renderer/src/lib/diff.ts          the viewer's changed-line view: a line diff
                                      against a HEAD baseline, and the Monaco
                                      decorations the buffer's side is drawn with
                                      (styles/diff.css; the removed side is a view
                                      zone, built in FileViewer.vue)
src/renderer/src/lib/hideAnimation.ts how a change to what the hide mode covers is
                                      shown: covered rows squeezed out where they
                                      stood, the rest closing the gap by sliding,
                                      uncovered rows sliding back in
src/renderer/src/lib/swapAnimation.ts how a Ctrl+U exchange is shown: copies of
                                      both panes travelling to the other column,
                                      carrying the display's blur (styles/swap.css)
src/renderer/src/lib/viewTransition.ts  the mode switch as a morph: run the change in
                                      a View Transitions `startViewTransition` so
                                      the named entries fly to their new boxes
src/renderer/src/lib/paneMenu.ts      the context menu's model
```

Styles are referenced inline below: `styles/mark.css`, `hold.css`, `notice.css`,
`flash.css`, `hide.css`, `osd.css`, `swap.css`, `view.css`, `viewer.css`,
`diff.css`, `columns.css`, all under `src/renderer/src/`.

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
  `Enter` runs the line or activates the panel entry. It cannot see what readline
  draws itself (Up/Ctrl+P recall, completion, yank), so the panes' keys ask the
  terminal whether the line is occupied through `TerminalPane.lineHasContent()`
  (the cursor against the remembered prompt end), which is what keeps the arrows
  on the line rather than on the clip after a history recall.
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
- **A `cd` typed at the prompt that did not take is said in the pane's notice.**
  The command line is the real shell, so the shell's own complaint lands a row
  above the prompt the collapsed strip shows — `Ctrl+O` is the only way to see it
  otherwise. `useWorkspace` reads the submitted line off `shell.lastCommand` (the
  *model's* line; a history recall is not captured), and once the command settles,
  a `cd`/`pushd` whose shell cwd is unchanged is checked against the filesystem
  (`lib/directoryChange.ts`): a target that is not a directory is reported, a
  `cd .` that asked for where the shell already was is not. Only an explicit
  plain path is judged — a `~user`, `$VAR`, glob or escape is left to the shell.
  The notice is set after the post-command re-lists land, so they do not wipe the
  notice by clearing a stale error.

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
- **The columns sort, and can be dragged into another order.** A header click
  cycles its column: ascending if it was not the sort, otherwise ascending ⇄
  descending; the sorted header draws its direction (↓ ascending, ↑ descending)
  to the right of its name. Folders stay in front whatever the column, the name
  is the always-ascending tie-break (so default = the old order), and the `..`
  row is prepended rather than sorted. `sortKey`/`sortDir`/`columnOrder` live in
  the *pane* (`useDirectory`), and `columnOrder` is the one source the header and
  every row's cells read, so the name column (icon, name, symlink target
  included) can be dragged anywhere. The drag shows an **insertion point — a gap
  between two headers**, not a highlight on a column: the gap is read from which
  column's midpoint the pointer has passed, the two gaps beside the dragged
  column are not offered (nothing would move), and `moveColumn` takes that gap
  index and corrects it for the column being lifted out. The point is a white
  line down the header with a downward triangle as its upward elongation, the
  triangle overshooting the header's top over the pane title
  (`ColumnDropMarker.vue`); it is drawn once at the header's level (only the
  header's box can hold something that overshoots it), positioned by the gap's
  measured x. The drag image is a chip built by `setDragImage` from an offscreen
  clone, not the browser's bare-text image of a transparent button, so it carries
  its background. A drop reorders without also sorting (the drag's end is timed),
  and the header gives DOM focus back on the way out — dragging must not
  `preventDefault` its `mousedown`. Reasoning in
  [`docs/design.md`](docs/design.md).
- **The columns can also be built, not only rearranged.** `Alt+E` (or the icon
  pinned to the right edge of the header, shown on hover) puts the pane's
  `columnEdit` mode on: each header becomes one bordered, rounded capsule holding
  a grip, a `<select>` of column types — Name, Size, Modified, Mode, Mode (num)
  — and a remove button (hairline dividers between the three), with an add
  button *outside* the capsule in every gap (before each column and after the
  last). The name
  column cannot be removed. Adding opens the new column's picker (a `showPicker`
  on the next tick, the add being a real click). The grip is what drags a column
  to a new place while editing — a picker and buttons cannot be the drag, or the
  picker could not be opened — and the column's wrapper carries `data-column`, so
  the shared gap logic is unchanged. Types are unique among the columns, so
  pickers grey out the ones already shown and an add inserts the first unused
  type; changing the sorted column's type hands it the sort, dropping it falls
  back to the first column left. The picker stops its own `mousedown` so
  `focusPanes` cannot steal focus before the native dropdown opens. The mode is
  the keyboard's too: the pane holds a `columnFocus` (the column the keys act on,
  moved by the arrows and set by a click), and while `columnEdit` is on App.vue
  claims the arrows/Home/End to move it, Enter to open its picker, Insert to add
  after it, Delete to drop it, and Alt+Left/Right to re-order it. Reasoning in
  [`docs/design.md`](docs/design.md).
- **The pane's row list must contain only entries.** The status notice is a
  sibling of the `<ul>`, never an `<li>` (an extra `<li>` shifts every index). The
  notice travels (`styles/notice.css`) and is keyed by its text.
- **A pane can draw its rows as a wall of thumbnails, cycled by `Alt+T`.** The
  mode is the pane's own (`state.viewMode` in `useDirectory`), like its sort and
  columns, and it is the *same rows*: the cursor, marks, filter, order, watcher,
  transfers and row menu are untouched — only the drawing changes. `ThumbnailGrid`
  does its own windowing, page arithmetic and scroll-into-view on a cell pitch
  (the listing's `ROW_HEIGHT` geometry does not carry over), and the pane's
  `cellsPerRow`, which the view measures, is what lets App.vue move the cursor a
  whole row on the up/down arrows; `←`/`→` step a cell rather than seeking the clip
  in the wall. The header (and the column editor) belongs to the details listing
  and is hidden with the wall; `Alt+E` brings the listing back first. A switch
  between the modes is a *morph*: every visible entry is named in both layouts and
  the change runs in a View Transitions `startViewTransition`
  (`lib/viewTransition.ts`), so the entries fly and resize from the row they were
  to the tile they become; the staggered rise in `styles/view.css` is the fallback
  for an engine without one. Nothing expensive runs during the flight: the tile
  reads and the model wall (its WebGL context, its parses — and, on the way out,
  its teardown) are held back until `morphing` is false, so the wall appears once
  the entries have settled. Leaving the wall also hides its canvas before the old
  state is captured (`ThumbnailGrid.hideModels`): the canvas is not part of any
  named tile, so a live one is copied whole into the morph and left floating in
  the root while the boxes fly out from under it. The tiles are sized with `Ctrl+=`
  / `Ctrl+-` / `Ctrl+0` (`THUMB_SCALE_STEPS`, per pane as `thumbStep`): the grid
  animates its own scale a frame at a time and re-measures, so the model wall —
  which measures each tile's box every frame — grows the models inside their boxes.
  A view morph is deliberately *not* used for the zoom, a snapshot being exactly
  what would freeze them. A tile's
  picture is read from main as a *tile* (`fs:thumbnail` decodes and shrinks with
  `nativeImage`; a clip is one ffmpeg frame), never as the whole file — the
  status-bar preview handing a ≤16 MiB file over whole would be ruinous sixty
  times over. A tile carries the row's git dot too — `rowMarkFor`/`dotStyle` live
  in `lib/gitMark.ts` and both the listing and the wall read them, so the dot is
  one reader's answer whichever way the row is drawn — in the wall it rides the
  picture box's bottom-right corner (a model is framed with margin, so the
  transparent canvas there never hides it). 3D tiles turn
  too, by *one* shared renderer (`ModelWall`): one WebGL context per tile would
  exhaust the browser's contexts (`ModelViewer` gives its own back on unmount for
  the same reason), so every model is painted through a scissor box the size of
  its tile, in an async chunk fetched only where the folder could hold a model. A
  model that will not read or parse falls back to its icon, and a remote target
  draws icons too (the relay has no resize step and no CAD mesher). In the wall
  the footer keeps no preview of a model (a second WebGL context and a re-read per
  cursor step is what stutters the rotation), so a display is revealed out of the
  cursor's *tile* instead — `ThumbnailGrid.cellRect`, reached from
  `previewRect`/`previewBarRect`. Reasoning in
  [`docs/design.md`](docs/design.md).

### The hide mode

- **A `.mchide` file puts a directory in hide mode.** It is a list of names, one
  per line; main reports them in `DirListing.hiddenNames` and the *pane* filters.
  Read and write go through one parser each (`parseHiddenNames`, `main/ipc/fs.ts`).
  `fs:hide-add` appends (refusing empty/multiline names, adding a leading newline
  when needed), switches the mode *on*, and flags the change as the app's own.
  `fs:hide-remove` is the menu's other half: offered for a row the folder lists,
  which is the row that is on screen only because the mode is *off*, it drops the
  lines naming it — the rest of the file, blank lines and comments included, is
  rewritten as it was read — leaves a name it does not list alone, never creates
  the file, and leaves the mode where it is. Both are refused inside an archive
  (`ENOTSUP`).
- **The hide mode is one remembered state for the whole app.** `toggleHideMode`
  is a module-level ref; covered marks are dropped (`pruneSelection`); it is
  persisted via `hide:get`/`hide:set` to `userData/hide-mode.json` and read once
  on mount before the first listing. Alt+. is claimed *after* the
  expanded-terminal check. The pane title bar's icon is an eye-off (on) / a dim
  eye (off), both in the title text's color, never gold.
- **A row the mode covers leaves by collapsing where it stood** — squeezed out
  while everything below slides up to close the gap; an uncovered row slides back
  down into the room it opens (`lib/hideAnimation.ts`, `styles/hide.css`). Only a
  real change to the mode's coverage animates: `state.hideTick` is what marks one
  (a toggle, or a `.mchide` write a refresh picked up), so a navigation, a sort and
  an ordinary refresh leave their rows alone. The view does the animating, not the
  controller: it keeps the rows it rendered last, copies the covered ones out of
  the DOM *before* the render (there is nothing left to copy afterwards), and
  rides the fixed `index * ROW_HEIGHT` geometry — the surviving rows are nudged
  with a `translateY` in the pane's already-new layout, so nothing is measured and
  nothing else moves. The copies are appended to the `<ul>` as `.hide-ghost` (which
  is why it is `relative`), out of the flow and off the pointer.

### Quick cd

- **Quick cd replaces the pane's rows, not the pane's place.** `Alt+C` is a mode of
  the *pane* (`state.quickCd` in `useDirectory`): while it is on,
  `allRows`/`entries`/`cursor` are the bookmarked directory paths, so every cursor
  move, page jump, scroll and row lookup works unchanged, while `state.path` — with
  its watcher, its title and the shell sync — is left alone. The listing the pane
  was showing is held aside (`browseListing`) and given back on `Escape`, exactly
  as it was.
- **The list is one remembered state for the whole app** (`quickCdDirs` in
  `useQuickCd`), persisted via `quickcd:get`/`quickcd:set` to
  `userData/quick-cd.json` and read once on mount. Alt+C is claimed *after* the
  expanded-terminal check (so a real terminal keeps its Alt+C, readline's
  capitalize-word); the column editor moved to Alt+E.
- **A bookmark is an ordinary `PaneEntry`** of kind `directory` whose `name` is its
  path with the home directory shown as `~` (`quickCdLabel`), so the row machinery
  needs nothing for it. It carries no size, date
  or mode, so the pane draws only the name column and hides the header with the
  rest. A navigation *leaves the mode* (`navigateTo` calls `toggleQuickCd`) — that
  is what keeps a `cd` typed at the prompt from landing under a list that is no
  longer the one being shown. The incremental search is opened with the mode
  (entering sets `searchActive`, and `applyFilter` runs over the bookmarks): the
  arrows move what the filter leaves while Left/Right and printable keys edit the
  query.
- **The row menu edits the list.** On a folder row it offers `Add to quick cd` (or
  the pane's own folder from any other row); on a row *of the list* it offers
  `Move up`/`Move down` (`Alt+Up`/`Alt+Down`) and `Remove from quick cd`. The order
  is the user's and is never sorted — an add appends, and `reorderQuickCd` swaps a
  row with its neighbour. `setSelected`/`isSelected` are no-ops in the mode, so a
  right-press on a bookmark opens the menu and never paints a mark. An empty list
  is said in the pane's notice, and a write that fails is put back and said there
  too (`changeQuickCd`), so the rows never show an entry the next launch will not
  have.
- **The mode has a pointer door.** A star button in the pane *title bar*
  (`FilePanel.vue`, beside the hide eye) toggles it — not in the header, which the
  mode hides, so the way out would vanish with it. It is a state as much as a
  switch (filled for on, outline for off), keeps the title's own color rather than
  the gold a mark takes, and reads `QUICK_CD_TOOLTIP`/`QUICK_CD_LEAVE_TOOLTIP` from
  `shared/quickCd.ts`. Building the list stays the row menu's alone.

### Disk occupancy

- **A pane's title bar shows how full its filesystem is, left of the hide icon.**
  `fs:disk-usage` reads `statfs` for the pane's path (`DiskUsage`: `total`, `used`
  as `df` counts it, `free` as what the user may still write), answered for the
  archive file itself inside an archive and by the relay's `syscall.Statfs` on a
  remote. The pane re-reads it on every navigation and refresh, token-guarded so
  a slow answer for a directory already left cannot land, and its tooltip names
  the filesystem's mount point (`/proc/self/mountinfo`, longest match, so a nested
  mount answers with the inner one). `DiskUsage.vue` is one progress bar with
  `used / total` (`2.1T / 4T`) written *inside* it, filled green → gold → red (a
  darker green than the runnable hue, since the label is white); the label is
  fixed white, on a dark track, so the same reading holds over the empty stretch
  and the fill alike, and the bar is sized to its own numbers under a hairline
  border.

### Git status

- **Git is asked, not reimplemented** — one `git status --porcelain=v2 -z
  --branch` per work tree per refresh, through `MC_GIT` (default `git`), gated on
  one memoized probe that git can be run at all. A library was measured and
  rejected: `isomorphic-git` is 35–70× slower here and does not detect renames.
  Never per-row calls: porcelain answers for the whole tree at once. See the
  design note before changing this.
- **`--no-optional-locks` and `GIT_OPTIONAL_LOCKS=0` are not optional.** Without
  them a read refreshes the index in place, racing the user's own git and firing
  our own watcher for a notification about nothing. `-z` is what lets paths hold
  spaces; `maxBuffer` is raised past `execFile`'s 1 MiB, which a large status
  outgrows.
- **A row's mark is a dot on its icon** (`dotStyle`), in the status's colour —
  filled for the entry, a ring for a folder's roll-up. It costs no width, so the
  listing's columns never move. The palette lives in `lib/gitMark.ts` beside
  `fileIcon.ts`'s, because it is chosen per entry and cannot be a class; a mark
  never recolours the *name*, where green is runnable, red is a broken symlink's
  target and gold is a mark. Git's two status characters are what the colour, the
  kind and the rank are *read* from, and are not drawn.
- **A folder shows the best of what is under it.** `buildGitView` rolls up every
  ancestor at build time, so a row's mark is a `Map.get`. A deleted file has no
  row at all (its path left the listing), so the roll-up is the only place it can
  appear.
- **A wholly untracked directory is one `/`-suffixed record**, not a listing of
  its files, so a pane *inside* one has nothing of its own — `GitView.untracked`
  plus `untrackedAbove` walks the path up to the work tree's root to answer `??`
  for everything below it.
- **The pane holds the view `markRaw`** — it is replaced whole, never edited.
  `visibleRows` reads it through `markAt`, which is what re-renders the window
  when a status read lands.
- **The title bar's chip answers about the whole work tree**: HEAD (or
  `detached@<sha>`), its drift, and one count of how dirty the tree is
  (`GitView.summary`), with the non-overlapping breakdown in the chip's title. The
  count is of *entries*, not files — a wholly untracked directory is one record —
  and a clean tree shows no count at all. The footer's dot is deliberately the
  opposite: the row under the cursor.
- **The footer's right group carries the cursor row's mark too** — a dot (filled
  for the entry, a ring for a folder's roll-up, `dotStyle`) and
  `markSummary`'s short form beside it, with the full `markTitle` in its title.
  The short form is a second wording, not a clipped one; a row git says nothing
  about draws neither dot nor words.
- **`git:watch` refcounts per work tree, not per directory**, and the pane
  re-targets it only when the root changes, so walking folders does not churn
  main's watchers. The other direction is the catch: a directory write calls back
  into the git side (`noteDirectoryChanged`, from `watch.ts`), which drops that
  repository's cached answer and tells every pane watching it — that is what keeps
  the *other* pane's rows honest.

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
- **`Space` on a folder adds up what it holds.** A listing knows a file's size
  but not a folder's, so the row's size column is blank until the gesture asks:
  `fs:dir-size` walks the tree in main and the pane keeps the answer by path
  (`state.dirSizes`). The walk does not follow symlinks (a link back up its own
  tree would be endless; a link counts as the link it is, as `du` counts it), and
  an unreadable entry is skipped rather than failing the whole answer. The walk
  is started, not awaited: the cursor steps to the next row at once, so holding
  `Space` sizes a column of folders, and the row counts up live as subdirectories
  are traversed — `fs:dir-size-progress` carries the running total, throttled in
  main to one report per 100ms and matched by the folder's path, and `…` is shown
  only until a walk has accounted for its first byte. A size belongs to the
  listing it was asked from — navigating away clears the map and bumps a run
  counter, so a walk for the folder left behind cannot land in the new rows, and
  progress for it is ignored for the same reason. A walk that is still going
  shows a 2px bar sliding along the size cell's bottom edge (`styles/size.css`),
  clipped to the cell so it never widens it or shows beside it — the columns
  never shift while a walk runs, the same rule the git dot follows. The bar is
  not shown from the first moment: it appears only after a walk has run for about
  a third of a second (`SIZE_BAR_DELAY_MS`, `state.sizeSlow`), because a folder of
  a few files is walked faster than the eye catches and a bar that blinked for it
  would say nothing useful. `sizeSlow` is kept apart from `sizing` — the walk
  itself — so the delay is a display matter and not a second guess at when the
  walk began. Space on the `..` row sizes every folder in the listing at once
  and leaves the cursor where it is, since there is no row below that the gesture
  could mean. The work is shaped for the fs thread pool rather than for fan-out:
  main keeps a batch of `SIZE_STAT_BATCH` (12) `lstat`s in flight per walk, so a
  single folder's stats are not one wait after another, while the pane allows only
  `SIZE_WALK_LIMIT` (2) walks at a time and queues the rest — enough to saturate
  the pool, not enough to flood it, and the rows then fill in the order they were
  asked instead of all crawling at once. While a recalculation waits in that
  queue, a folder that already had a size keeps showing it dimmed (`sizeStale`),
  so an old total is never mistaken for a fresh one; the dim goes the moment the
  walk starts and its running total takes the column. `Escape` stops every walk
  in the app (`stopAllSizeWalks`): the queue is dropped by bumping an epoch, main
  is told by `fs:dir-size-cancel` and gives up at its next batch, and each pane
  restores the size the row showed before the walk (or blanks it), so a partial
  sum is never left looking like a total. A size *sort* respects these totals and
  keeps up with them: `sizeFor` orders a folder by its walked size when it has one
  — what the row shows — and by its metadata size otherwise, and a sort by size is
  re-run live as totals land, debounced (`SIZE_SORT_DEBOUNCE_MS`) and capped
  periodically (`SIZE_SORT_MAX_MS`) so a long walk keeps re-ordering rather than
  waiting for its end. The cursor is kept on the entry it was on across each
  re-order (`applyFilter`), so the rows move around the cursor. `Space` only
  reaches this when there is no clip to play, and otherwise stays the shell's own
  space. **A size is drawn in a colour read from how big it is** (`sizeColor`,
  `lib/format.ts`): plain `text-fg` up to 1 MiB, then a log-scale ramp from amber to
  red as it grows toward 1 TiB, so the big files stand out on the eye's scan. A
  stale folder total keeps the plain dim and takes no heat; the footer's cursor
  size takes the same colour as the row.

- **`F7` makes a directory in the pane being browsed.** `fs:mkdir` resolves the
  name against that pane (absolute, or relative, as the transfer dialogs do) and
  is deliberately *not* recursive, so an existing name is an `EEXIST` the pane
  reports rather than a silent success; the new folder does not sweep, because
  every pane showing the directory is told the change is the app's own.

### Archives

- **A place inside an archive is one path string, `<archive>\0<inner>`.** NUL cannot
  occur in a POSIX path or an archive entry name, so a location stays a single
  string and everything path-keyed (marks, the cursor anchor, the watcher's match,
  the size map) keeps working by equality. Never hand the NUL form to a syscall or
  the user — `archiveDisplay` is the readable split. `src/shared/archive.ts` owns the
  model; `src/main/archive.ts` is the reader; `ipc/fs.ts` branches on
  `isArchivePath`.
- **Entering is asked of 7z, probed once** (`fs:can-archive`, `MC_7Z`). False with
  no 7z means Enter on a `.zip` opens it with the system, as before. A `.tar.gz` is
  a wrapper: the tar inside it is listed/read through a pipe (`run7zPipe`), never
  written to disk. A name is passed to 7z in both spellings (`name`, `./name`) so a
  `.`-rooted tar reads too.
- **An archive is entered only from a `file` entry** whose name is in the enterable
  list, so a *directory* named `foo.zip` is just a directory. The pane title draws
  the archive's own name **in the archive hue** (the gold its icon uses; no icon,
  no underline; `archiveDisplay`), which is what tells "inside `foo.zip`" from
  "inside a folder named `foo.zip`".
- **Read-only for now.** Writes (save/delete/rename/mkdir/copy in or out) are
  refused in main (`ENOTSUP`) and guarded in the pane; a video inside an archive is
  not previewable (the `mc-media` stream serves a real file); git is not asked, no
  watcher is opened; the terminal is **disabled** while the pane is inside an archive
  (`archiveMode` → `TerminalPane`'s `disabled`: the prompt is kept under a light scrim
  with a centred note, `disableStdin`, focus to the panes), and the path pastes are
  skipped.

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
- **A pane footer shows a PDF's page, and a display stacks the whole document.**
  A PDF is not one picture, so main renders a *page*: `pdftocairo`
  (`MC_PDFTOCAIRO`) at the width the box needs, as a PNG `data:` URL, alongside
  `pdfinfo` (`MC_PDFINFO`) for the page count and every page's shape. Both are
  gated on poppler being there (`fs:can-render-pdf`, asked once as transcode
  support is); without it a `.pdf` is not media and `Enter` opens it with the
  system. `fs:pdf-page` and `fs:pdf-info` are cached in main by path+size/mtime,
  page and width. The footer asks for 320px wide; the display lays its pages out
  from the header — stacked vertically, at the pane's width — and renders the page
  or two near the viewport at `devicePixelRatio` (capped at 2400), windowed like
  the listing. The wheel **scrolls** it; the transport and the arrows jump between
  pages by scrolling to them. The page in view is shared state (`lib/pdf.ts`), not
  handed across like a clip: a page costs nothing to show twice, and a display and
  a footer have to agree on which one is on screen.

### Display and full-screen

- **A display is a mode of the panes, not a third overlay.** `Enter` hands media
  to the *other* pane; the cursor stays and the asking pane keeps the keyboard.
  The listing is blurred behind it (`filter` + `clip-path: inset(0)`). What shows
  is derived from the cursor (`stageTarget`). `Tab` is claimed; `Ctrl+U` carries
  the display. The reveal grows out of / shrinks back onto the footer thumbnail;
  the clip's sound is ramped (muted at rest) and it does not loop. The display
  *takes the clip over* (`stage-clock` + `resumeAt` both ways). `seekPreview` on
  the arrows, `wheelScrub` on the wheel (`overStageMedia` distinguishes the
  picture/transport from the folder). A PDF is a document rather than a picture:
  its display is a scroll box of stacked pages, so the wheel is left to the
  browser to scroll it, while `seekStage` and the transport turn a page by
  scrolling to it, and the page under the top of the box is the shared page the
  footer reads. A **middle-button drag pans** the document (`onPdfPanStart`): the
  box's own scroll follows the pointer, both ways, since a magnified page is wider
  than the box as often as it is taller — and the press's default is called off, or
  the middle button's paste (and, where a browser offers it, its autoscroll) would
  be reading the same gesture.
  The scroll box *is* the display's media element (`stageMedia`), so
  it carries `origin-top-left` like the clip and the still do — `handoffTransform`
  scales about the element's top-left, and at the default centre origin the reveal
  would start half a pane to the right of the thumbnail it grows out of. That scale
  is by width, and the media's own rectangle is *centred* on the target it flies to
  (its fourth argument, which only the transport bar leaves off — the bar grows out
  from *under* the thumbnail, so its top edge is what has to sit on the target):
  the two rectangles rarely share an aspect — a letterboxed picture, a wall tile,
  and above all a 3D model, whose drawn rectangle is a centred square of the box's
  *height* (three.js fits the model to the vertical field of view; the box's width
  says nothing about how large it looks) — and a
  corner-pinned flight of those starts short of the middle and lands beside the
  thumbnail it belongs to. Its
  transport carries the fit switch — fill the box's width, or scale a whole page
  into it (`pdfView.mode`, `Alt+W`/`Alt+P`) — and a magnification (`pdfView.scale`,
  `Alt+=`/`Alt+-`, a fixed ladder of steps in `shared/pdf.ts`), with the two fit
  buttons and the `-`/percentage/`+` group at its right end. The two are one state,
  either a fit or a magnification of the box's own width: a fit keeps filling the
  box as the box changes, while a magnification chosen by hand is the same fraction
  of the width however the pane is resized. The percentage's reference is the
  *box's width*, not the page's size in inches — the thing on screen a reader can
  point at, and the reason **fit width is exactly 100%** (`Fit width — 100%` is what
  its tooltip says) while fit-page reads as the fraction of the width a page takes
  when its *height* is what was fitted. `+`/`-` step from the percentage *shown* —
  a page fitted at 80% steps to 100%, not to 80% of a rung — and so leave the fit
  behind. Above 100% the page is wider than the box and scrolls sideways
  (`overflow-x` is `auto`). The state is remembered in `userData/pdf-view.json`.
  Each page also carries an **invisible text layer** (`pdftotext -bbox-layout`
  through `fs:pdf-text`): every word is a
  transparent `span` at the box the tool reported for it, scaled to the width the
  page is drawn at, laid over the raster — so a drag selects the page's text and
  `Ctrl+C` copies it (the copy is made by the app from the selection's text —
  remembered as it is made, so a focus change or a reloaded display folding the
  selection away cannot hand the copy back to the row's name — rather than left to
  the browser). The separating space is written as an *expression*
  (`word.text + ' '`), never as template text: the template compiler's whitespace
  condensing drops a trailing space written between the interpolation and the close
  tag, and every word of the copy then runs into the next.
- **A PDF's selection highlight is drawn by the pane, not by the browser.**
  `pdfHighlightRects` in `FilePanel.vue`, with the native one turned off
  (`[data-pdf-text] ::selection` is transparent, `styles/pdf.css`): the browser's own
  highlight follows the *substitute font's* line box — a band a little taller than
  the words, a little low, and as wide as that font drew them rather than as wide as
  the word — while what is on screen is the raster it should be pointing at. So a
  translucent band is drawn per *run* of selected words on a line, from the word
  boxes the text was read from, at the line's own band and not a word's ink (which is
  shorter for a word with no descender in it, and a band that changed height word by
  word would read as a fault). Which words are selected is read from the selection's
  endpoints and their offsets, so the drawn highlight and what `Ctrl+C` copies cannot
  disagree; the selection itself is untouched.
- **The browser's paragraph is one word here, so a triple-click's is poppler's.**
  A word span is a block of its own (it has to be, to sit at its box), so poppler's
  text blocks are kept as each word's `block` and a **triple-click selects that
  block** as one range. Holding the button and dragging adds whole paragraphs from
  there (`paragraphDrag`), the word nearest the pointer deciding which end grows and
  across pages the layers' own order deciding the direction, so the paragraph the
  gesture began on is never lost. The nearest word is worked out from the word boxes
  rather than by hit-testing, because the
  boxes have gaps between them that the layer's own background fills. That is also
  why a PDF display has **no double-click-to-enlarge** (a double-click on a page is
  a word selection, as in any text; `Ctrl+Enter` and the row's triple-click still
  enlarge), why the panes' `Ctrl+C` keeps the *selection's* text rather than the
  row's name (`pdfSelection` in `App.vue`; the row copy is what it stands aside
  for), and why the focus model stands down too: a press on the text layer must not
  have `restoreFocus` put the keyboard
  back on the command line, which folds the selection away as it focuses. The
  scroll box is `tabindex="-1"` so a press inside it keeps the keyboard there
  rather than dropping it to `<body>`, and `selectingText` (a window-wide
  pointerdown/up watch in `App.vue`) covers the drag before a selection exists. A
  key the panes did not claim is not lost to that: with the keyboard on the document
  it is handed back to the command line — `TerminalPane.forwardKey` re-dispatches it
  to xterm's textarea, so readline's keys, Backspace and Enter arrive as if typed
  there (a `forwardingToShell` guard keeps the synthetic event off `App.vue`'s own
  capture listener) — except a bare modifier or lock key (`MODIFIER_KEYS`), which
  xterm sends nothing for and which must not take the keyboard either: a `Ctrl`
  pressed on the way to `Ctrl+C` is the first half of the copy gesture, and
  focusing the command line with it would fold away the very selection the copy is
  about. (A copy with a selection up never reaches that path: it is
  claimed earlier and the selection's text put on the clipboard.)
  The page subtrees carry `v-memo`, so a scroll re-renders only the pages that
  enter or leave the window rather than every word of every page on screen.
- **A display request that names the same media is not a reload.** The panes
  re-derive the target from their cursor (`stageTarget` → `previewTargetFor`) on
  every re-list, and that builds a *fresh* object each time, so `props.stage`
  changes identity whenever a directory is refreshed. The `props.stage` watcher
  compares kind, `encode` and `previewKeyFor` and returns early for the same media
  (`sameMedia`) — otherwise every refresh would tear the display down and build it
  again, which for a PDF drops its text layer and the user's selection with it.
- **A clip action is answered by a YouTube-style OSD** (`PlaybackOsd.vue`,
  `styles/osd.css`) that owns only the animation and reports done via a `done`
  event; one per surface. `seek()` flashes, a transport drag does not.
- **The full-screen mode is the same display over the whole window** (`Ctrl+Enter`
  / triple-click). The overlay becomes `fixed inset-0 z-50`; the full-screen
  presentation owns `Tab` and `Escape` window-wide. A presentation change travels
  (`switchStagePresentation`, `stageTravelling` at `z-40`); the backdrop is
  `stageBackdrop` (faded, not switched); leaving latches `fullscreenPresentation`.
  The pane row must be `isolate` **and** `relative z-10`. **The click run is counted
  in the pane, and taken on the scroller rather than on a row.** `event.detail === 3`
  is deliberately unused: the second click starts the pane display, and the work that
  takes lands between it and the third, so a count the browser takes from how clicks
  are *handled* runs out and a quick triple-click stops at the double-click that
  displayed the file. `onListClick` is fed by both scrollers — the details `<ul>` and
  the wall's, which forwards `list-click` — and reads the entry from `[data-path]`; a
  click that landed on no row at all *continues* the run on the cursor's entry
  instead of starting one, because a press and its release can end up sharing no row
  (the display the same clicks build replaces the DOM under the pointer), and the
  browser then dispatches the click to their nearest common ancestor, where a handler
  on the row would never hear it. `countEntryClick` counts three within
  `TRIPLE_CLICK_MS`, from the events' own `timeStamp`s.

### Models

- **One preview kind, two families, split by extension** (`shared/model.ts`). A
  *mesh* format (stl, 3mf, obj, ply, gltf/glb) is the file's own triangles: main
  reads the bytes (`fs:read-model`) and the renderer parses them through three.js
  (`lib/model.ts`) — no system dependency at all. A *CAD* document (step, stp,
  iges, igs, `.fcstd`) is a boundary representation no mesh loader can open, so
  main meshes it to STL through FreeCAD (`main/model.ts`, `MC_FREECAD`) first —
  and, like a PDF without poppler, it is **not a model at all** where FreeCAD is
  missing (`fs:can-render-model` is the probe, asked once like the others, so
  `Enter` opens such a file with the system instead). A converted file comes back
  as `{format: 'stl'}`, whatever it was named, exactly as a PDF page arrives as a
  PNG. `fcstd` is the icon table's too (`fileIcon.ts`, the teal `threeD` cube).
  the binary is `freecadcmd` on `PATH` (the default); `MC_FREECAD` names another.
  A FreeCAD *AppImage* keeps `freecadcmd` *inside* itself rather than on `PATH`,
  so that machine needs a one-line wrapper — `exec /path/FreeCAD.AppImage freecadcmd
  "$@"` — saved as `freecadcmd` somewhere on `PATH`.
- **`openDocument` reads only `.fcstd`; a STEP/IGES goes in through
  `Import.insert`.** The conversion script `main/model.ts` generates branches on
  the extension. It exports the shapes that are **nobody's input**
  (`not o.InList`): a PartDesign Body is one solid, not the Body plus the Pad plus
  the Pocket stacked on top of one another. A document with no such top shape
  falls back to every shape. The conversion runs in a scratch dir, is killed on
  quit (`killAllModelConversions`) and is cached by path+size/mtime.
- **`ModelViewer.vue` owns a WebGL context and gives it back on unmount**
  (`dispose()` **and** `forceContextLoss()`): stepping the cursor across a folder
  of models must not push the browser past its context limit. It announces
  `ready` only once it has a non-zero box — a footer box that is still `v-show`n
  away measures zero — and the display's reveal grows out of that event.
- **Both canvases turn on their own; the display's is then handled.** The
  thumbnail auto-rotates at a throttled ~40fps (a still frame reads as a silhouette,
  and a 64px ambient box is not worth a monitor-rate redraw), and the enlarged one
  auto-rotates too — via `OrbitControls.autoRotate`, switched off on the controls'
  own `start` event — so it reads as a solid until the pointer takes it over, at
  which point the drag turns it and the wheel zooms it. **The display is not
  throttled**: it is drawn every frame the compositor offers (the monitor's own
  rate), and only when the camera actually moved — hung on the controls' own
  `change`, not on what the tick's `update()` returns, because the wheel applies its
  dolly *inside* the controls' event and a render keyed to the tick would miss it (the
  camera dollies, the picture waits for the next drag to draw it) — so an
  idle, settled, non-spinning display costs nothing. The display's controls pan on
  the **middle button**, as a PDF document does — the same drag pans either — with
  the focus held within the model's own size so a drag can move it about but not
  lose it off the edge of the box. The right button is deliberately **left unbound**
  by the controls: on the display it is its own gesture (a quick right-click leaves
  the mode), so the left button goes on turning the model, and the middle press's
  default is called off (`onCanvasMiddleButton`, on the press, the release and the
  click the release turns into — the X11 primary-selection paste it offers would land
  on the command line) because a browser would otherwise
  start its own autoscroll on that button. `onStageWheel` hands a model's wheel to the
  controls rather than stepping the folder (as it does for a PDF's scroll), and
  `stageMedia` is the wrapper `div` the reveal measures and moves, the canvas inside
  it being what draws.
- **`three` is pure JS, bundled by Vite**, so the renderer CSP is untouched — no
  `wasm-unsafe-eval`, no new scheme. It is the app's one large renderer
  dependency, so `ModelViewer` is a `defineAsyncComponent` (`FilePanel.vue`):
  three and its loaders sit in their own lazy chunk, fetched when a row really is
  a model, exactly as Monaco is kept out of the main chunk.

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
  (`languageFor`); only interpreters with a fitting tokenizer are mapped, a curated
  name matches as a whole name, a dotted tail (`bash.bashrc`) or a bare head
  (`Dockerfile.dev`), and `/usr/bin/env` is followed past its options and
  `VAR=value` assignments.
- **The changed-line view is diffed in the renderer and shown interleaved**,
  against a HEAD baseline main reads (`git:file-base`, `git show HEAD:<rel>`):
  `lib/diff.ts` is a plain LCS over the two files' lines with the common
  head/tail trimmed first, so the marks update live as the buffer is edited
  (debounced) rather than being a snapshot that drifts under the caret. The
  buffer's side is a tinted line and a gutter bar (green added, amber modified);
  HEAD's removed side has no buffer line to tint, so the viewer draws it as an
  inline **view zone** above the run, in the editor's own font and line height
  (`removedLinesNode`), with a triangle left in the gutter and a red ruler mark.
  Lines are compared without their terminators, so a CRLF checkout does not
  differ from the LF blob. App.vue reads the baseline eagerly for a file the
  pane already marks changed, so its diff is on screen at open; every other file
  has the viewer fetch its own baseline the first time the buffer is *edited*, so
  a clean file opened and changed shows its diff without being reopened and a
  file only looked at costs nothing. An ignored path gets no baseline (a
  `truncated` read or a symlink gets none either, because the part that could not
  be shown — or the link's own text — would read as a whole file of deletions);
  a path HEAD has no blob for reads as wholly added. The palette is the panes'
  (`DIFF_COLORS` from `gitMark.ts`); `styles/diff.css` paints the lines, the
  gutter bars and the removal tint, and the overview ruler takes the same hues.

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
- **A search keystroke that would leave nothing to find is refused.** `updateSearch`
  returns whether it took; on a refusal the pane restores the last good query and
  pulses the field red (`styles/search.css`), so the listing never blanks out.
- **Focus model:** the command line holds focus whenever the terminal does not, so
  `focusPanes()` focuses the command line. The search box and the terminal are the
  other two targets.

### Styling

- **Tailwind v4 is configured CSS-first** (`@theme` in `styles/main.css`), no
  `tailwind.config.js`. Theme tokens are the design system — prefer `bg-surface`,
  `text-fg-dim`, `border-border` over raw hex.
- **The search field rides `text-rendering: optimizeSpeed`** (`styles/search.css`),
  against the body's `optimizeLegibility`. The mono font's underscore is an 80%
  dash on a 7.2px cell, so a sub-pixel glyph origin makes adjacent `_` fuse into one
  line or a dash fall between pixels and read as a space; snapping the advance to
  whole pixels keeps the count readable.
- **The search bar grows its own clipping window open and shut** (`styles/search.css`),
  animating height rather than sliding inside a fixed window, so the listing below is
  pushed down and pulled back up with the bar instead of jumping when a row lands.
  120ms, quick, because it answers a keystroke.
- **The renderer has a CSP** in `src/renderer/index.html`. `img-src data:` and
  `media-src mc-media:` are what let a footer show a preview the renderer has no
  URL for.

## Conventions

- Keep filesystem and pty access in the main process; the renderer only talks to
  `window.mc`. Never enable `nodeIntegration`.
- IPC handlers return `Result<T>` instead of throwing across the bridge.
- The security model is contextIsolation on, nodeIntegration off, and the preload
  exposes a narrow, explicitly typed surface.
