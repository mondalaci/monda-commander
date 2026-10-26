# Design notes

Why the code is the way it is: the reasoning behind decisions that are easy to
undo by accident. `AGENTS.md` carries the rules themselves; this file carries the
justification, so a change that looks harmless can be checked against what it
would break. Loaded on demand.

## Window and shell

### The remembered window geometry

`src/main/windowState.ts` keeps the window's size, position and maximized flag in
`userData/window-state.json`. Only the *normal* bounds are stored (a maximized
window's own bounds are the screen), written on a debounce so a drag is one save
rather than one per frame, and restored only if the display it was on is still
attached — a window placed on a coordinate no display covers cannot be reached,
so its position is dropped and its size clamped to the display it lands on.

### The frameless window

The window is frameless (`frame: false`), so the OS decoration is replaced by
`TitleBar.vue` (a single 32px row that holds the logo, the workspace tabs and the
window controls; clicking the active tab toggles its terminal). Moving the window
depends on `-webkit-app-region`: the header is `drag-region` and interactive
children must be `no-drag`, otherwise a new control silently swallows clicks.
Both are `@utility` rules in `main.css`. Window controls go through
`window.mc.win`; main broadcasts `window:maximized-change` so the maximize/restore
icon stays in sync. Double-clicking the bar toggles maximize, and it must key off
`button` targets, not `no-drag` ones: the tab strip is a `no-drag` `flex-1`
child, so a `.no-drag` test would swallow every double-click on the bar's empty
middle (only the small logo/drag area would respond).

### The workspace stack

The app is a stack of workspaces — one tab each, shown in the title bar. A
workspace owns its own pair of file panes and its own shell, so switching tabs
switches sessions; only the active workspace is rendered, and a tab that comes
back replays its session buffer (see `useWorkspace.ts`).

### The shell outlives its view

`TerminalPane` must not kill the shell on unmount — main reaps sessions when the
window goes away, and a workspace kills its own session only through
`shell.dispose()` when its tab is closed. Killing it on unmount let any remount
(a Vue HMR update, a workspace switch, a reload) race a fresh spawn and take the
*new* shell down with it. For the same reason `attachTerminal` does not drain the
output buffer: a view that attaches later replays the session so far. A workspace
object (`createWorkspace`) survives tab switches, so its shell's `startPromise`,
buffer and cwd are preserved and remounting the view re-attaches rather than
respawns.

### The collapsed strip is the shell, so its input line is state we model

`shell.inputLine` (one per workspace) is fed from xterm's `onData`. It decides
whether `Enter` runs the line or activates the panel entry, and it stops the cwd
sync from injecting a `cd` into a half-typed command.

### Panel → shell cwd sync

The panel and the shell keep their cwd in sync in both directions, which is why
it needs a guard: the shell's cwd is *polled* (300ms), so a read can be stale for
a moment after we inject a `cd`. `pendingPush` in `useWorkspace.ts` marks the path
we asked for so those stale reads are ignored rather than bouncing the panel back.
The injection is also gated on `pty:state` reporting the shell is at a prompt —
writing mid-command feeds the text to whatever is running.

The sync types a real `cd` into a real prompt, so the shell echoes it and the
strip fills with commands the user never issued. The injected line carries a
trailing `printf '\033[1A\033[2K'` that walks back over the echo and clears it,
so only the new prompt shows. `&&` keeps a failed `cd` visible as an error.
Gating on an empty input line is what stops the injection from being appended to
a half-typed command. Erasing the echo is only half of it, because readline added
the line to the **history list** before running it, so Up offered the sync as if
the user had typed it: the line ends by deleting the entry it just became
(`history -d "$HISTCMD"`, guarded on `$BASH_VERSION` so a non-bash `$SHELL` is
not handed a command that errors). It must *not* be prefixed with a space: a space
is the usual request to forget a line, but `HISTCONTROL=ignorespace` drops it
before it is ever numbered, so `$HISTCMD` would still name the user's previous
command and the delete would take that one. Started at column 0 the entry is
always ours — and if a shell drops the line anyway (`ignoredups` on a repeat) the
worst it can reach is an earlier copy of this same line.

This erase only works while the terminal has a row to spare: a **one-row**
terminal scrolls on every newline, so the echoed `cd` leaves the viewport for the
scrollback before the `printf` runs, and `Ctrl+O` then shows a transcript of them.
`refit()` in `TerminalPane` therefore clamps the terminal to at least two rows,
and the collapsed strip clips the spare row away rather than showing it. What is
visible must be the row the **cursor** is on, not the top of the buffer: the strip
is the command line, so `applyStripViewport()` measures a row's height, sizes the
host's content box to exactly that, and shifts the terminal up so the cursor's row
lands inside it. Leaving the terminal at the top instead showed the row *above*
the cursor — after `ls`, the last output line rather than the prompt sitting under
it. The clip must be the row exactly, so the host carries no vertical padding:
`overflow: hidden` clips at the **padding box**, and with the `py-1` the strip
used to have, the translated row above the cursor painted its descender tips into
the top padding — a stray pixel of the previous line under the strip's border,
visible only when that line had a `p`/`y`/`g`/`q` or an underscore low enough to
reach it. The gutter above and below is the host's margin (`my-1`), which lies
outside the clip edge, so the height written there is one row on its own.

### `pty:state` is Linux-only

It reads `/proc/<pid>/cwd` for the cwd and `tpgid` in `/proc/<pid>/stat` to tell
whether the shell is at a prompt. Elsewhere it reports `idle: false`, which
disables injection rather than guessing.

## Directory listing

### A pane's directory is watched, not polled

`useDirectory` subscribes to `fs:changed` for its current `state.path` and
re-lists on a match, so files made by another program appear on their own. Main
refcounts watchers per webContents id, *not* per directory: both panes can show
one directory, and a plain Set would close the shared watcher when the first of
them navigated away. Notifications are debounced (200ms trailing edge, but never
later than 750ms after a burst's first event) because one action (a recursive
copy, an editor's write/rename) emits a burst of inotify events — and a pure
trailing debounce never fires while events keep arriving, which is exactly a
download streaming a `.crdownload` file, so the pane stayed frozen until it
finished.

### A refresh highlights what changed

`useDirectory` diffs each re-list and marks entries that are new or whose
size/mtime/kind changed into `fresh`; `FilePanel` puts `flash-row` on those rows,
which runs the looping `flash-sweep` animation in `styles/flash.css`. The clear
timer is re-armed by every refresh, so a one-off change sweeps exactly once while
a file still being written (a download) keeps sweeping until a full cycle passes
with no change. The gradient holds two peaks and never reaches zero alpha and
scrolls one period per cycle — a single band with a blank tail leaves a dead beat
between passes, which reads as the animation stalling. A batch over 150 entries is
skipped so a big copy or checkout cannot animate hundreds of rows.

### Only changes made behind the app's back sweep

A copy, move or `mkdir` the user asked for must not animate its own result, and
the watcher reports those changes exactly like an external writer would, so the
app marks the panes involved as making the change themselves: `beginSelfChange` /
`endSelfChange` in `useDirectory` silence `markFresh` while the operation runs and
for a 1000ms tail afterwards (enough to cover the watcher's debounce), so neither
the operation's own re-list nor the watcher's delayed notification flashes.
`App.vue` wraps the F5/F6 transfer on both panes (the target always gains entries,
the source too when the destination is a relative path), and mutes the panes at
the shell's directory from a submitted command until it finishes and settles. A
download in another directory, or one that starts after the tail, still sweeps; so
does `Ctrl+R`.

### The row list must contain only entries, and the notice travels

The pane's row list must contain only entries. A status message rendered as a
sibling `<li>` shifts every index, which silently breaks cursor scrolling and page
jumps; `FilePanel` renders that notice as a sibling of the `<ul>`.

That notice *travels* (`styles/notice.css`): it descends into place, and ascends
back out when Escape puts it away — the gesture reads as taking the message away
rather than as the message vanishing. It moves inside a window of its own height,
an `overflow: hidden` box that is always there, and the animated element is the
message rather than that window: a moving window would carry the clip with it. The
room the notice takes is the layout's the moment it is in the DOM, so the listing
is pushed down by the mount and not by the animation, and the message comes down
from behind the path bar instead of over it; the room is released when the ascent
is over, which needs no reveal — `onListResize` moves the view only for the
footer's own height, and a listing that regained room is left alone. The travel is
the *message's* alone: animating the room instead would drag the rows down under a
cursor sitting behind the animation, the same reason the footer strip snaps
smaller. The message is keyed by its text, so a new one replaces the old through
the animation (out-in: the old ascends, the next descends) while a repeat of an
identical one is the same notice still standing and does not re-announce itself.

## The hide mode (`.mchide`)

### A `.mchide` file puts a directory in hide mode

It is a list of names, one entry per line; main's `listDirectory` reads it and
reports those names in `DirListing.hiddenNames`, and the *pane* is what leaves
them out. Main does not filter: the mode can be switched off and on in the
interface, so the filter has to be re-appliable without reading the folder again —
`useDirectory` keeps the whole listing in `state.allEntries` and rebuilds
`state.allRows` from it (`buildRows`), which is also why `toRows` takes entries
and a parent rather than a `DirListing`. Blank lines are skipped and each line
trimmed, so a Windows line ending or a stray space still matches.

The reading and the writing of that format are one function each, next to each
other in `main/ipc/fs.ts` (`parseHiddenNames`, which both go through), because a
rule that lived in the reader and not the writer would show up as a name that
hides nothing. The writing is `fs:hide-add` — the pane menu's
`Hide (add to .mchide)`, so a list can be curated without the file being opened in
the editor. It *appends*, leaves a name that is already listed alone (the request
is "hide this", not "list this twice"), and adds a newline first when the file
does not end in one, since otherwise the new name would join the last line and
hide whatever that line spelled; a name that is empty or spans lines is refused,
because it cannot be spelled in this format at all. The item is left out of the
menu for a name the folder already lists — it is on screen only because the mode
is off, and the title bar's dim icon is what says so — and the mode is switched
*on* with the write, since the file only says what to leave out and the mode is
what leaves it out: a name written into a list nothing is applying would look like
the item had done nothing. Both panes showing the folder are told the change is the
app's own before the listing is re-read, so the row that was asked to disappear
does not sweep as though something had happened behind the app's back; the names
come from the listing rather than from a read of the file, which is why the folder
is listed again at all. The file is filtered like any other entry — naming itself
in it hides it too — which is safe because Alt+. is always there to reveal what
the mode is covering, and the title bar's icon still stands for the folder having
a list. A *folder* called `.mchide` is not the file (the write is refused with
`EISDIR`, which the pane reports), and an unreadable one lists nothing. A name
that matches nothing is simply a name: nothing is said about it.

### The hide mode is one state for the whole app, and it is remembered

Alt+. flips it (`toggleHideMode` in `composables/useHideMode.ts`), which is a
module-level ref — not per-pane state — so a toggle re-filters every pane,
including the tabs that are not on screen, and `useDirectory` watches it to
rebuild its rows and park the cursor on the entry it was on wherever that entry
survives. A mark for an entry the mode now covers is dropped (`pruneSelection`),
because a mark is a promise about what F5/F6/F8 act on and an invisible one would
make the footer's count disagree with those keys. The choice is written through
`hide:get`/`hide:set` to `userData/hide-mode.json` (`src/main/hideMode.ts`) and
read once on mount before the first listing, so it outlives the window and a
`.mchide` folder opens the way it was left rather than flashing its contents
first. The key is claimed *after* the expanded-terminal check on purpose: in a
real terminal Alt+. is readline's yank-last-arg, and the shell keeps it. The icon
in the pane title bar is the mode's state — an eye-off while it is on, a dim open
eye while it is off, each with its own tooltip naming the file and the key — and
it appears wherever a folder has a list, so turning the mode off leaves a place
to see and undo that. The eye-off is drawn in the title text's own color
(`text-fg-bright` on the active pane, `text-fg-dim` on the other), not the gold
the marks and the cursor take, so it reads as a note about the pane rather than a
second selection. The name, the key and both tooltips live in
`src/shared/hide.ts` so the file and the gesture are spelled one way.

## Marks, the right button, and the context menu

### A mark is a gold band across the row

A marked row takes `bg-marked` (`main.css`) — a dark gold, `#625018`, the mark's
own hue (`--color-selected`, 45deg) hand-picked rather than mixed, because a
`color-mix` of that yellow into the row background walks to the background in a
straight line and reads olive at every stop below the bright end. It is a band
rather than a highlight, which is what lets every color on the row go on reading
as itself: the name keeps the color its kind gives it, including the green of
something runnable, the size and the date keep the plain `text-fg` a filename has,
and only the symlink target beside them stays its own color — the dim gray of a
target that resolves, red when it does not. The band yields to the cursor's blue
when the two coincide, and the mark is then added to that band rather than
replacing it: the row takes the cursor's ordinary band (active or inactive) *plus*
`row-mark`, which weaves the mark's gold through the band on a diagonal and frames
the row in it. So the background goes on saying where the keyboard is, the weave
and the frame say this is one of the rows F5/F6/F8 act on, and every color on the
row — the runnable green among them — goes on reading as itself. That is what
keeps "the row I am on" and "the row I marked" tellable apart when the two
coincide.

### The row that is both marked and under the cursor

`styles/mark.css`, through the `row-mark` class `rowClass` adds: gold woven
through the cursor's band on a `\` diagonal, 3px of the mark's gold at 135deg, and
a gold frame around the row's whole box in the mark's own bright hue at 70%
(`--color-selected`, the yellow that names the mode elsewhere in the app). Two
things about that file are deliberate. The band inside the pattern is
`transparent` rather than the band's own color, so the row's background-color
shows through and the weave lands on the *inactive* pane's grey instead of
painting the blue that means "focused". And the weave is withheld while a row is
hot (`.row-mark:not(.flash-row)`) rather than outranked, because `background-image`
is one property and a refresh sweep and a weave cannot both be on it — the refresh
notice is the one that has to be seen, and a question of which stylesheet was
imported last is not something to leave a silent rule to. The frame is a
`box-shadow`, so it is the one part that stays through the sweep.

### The right button: click, drag, hold

A right *click* toggles the row's mark on the release; a right *drag* paints one
across the rows it sweeps over; a right press *held* on a row opens that row's
menu. One button, told apart by what the pointer does rather than by a modifier,
and none of the three moves the cursor: the right button marks a row and the left
one is where the cursor goes, so a mark is not also a jump. The press itself
therefore settles nothing but *which* row the gesture is about, taken by path
because a held button gives the pane time to re-list: travelling past
`HOLD_SLOP_PX` makes it the sweep, staying put for `HOLD_MENU_MS` makes it the
menu, and the button coming up first makes it the click — whose mark is applied on
the release, which is exactly what leaves the hold free to be the menu instead. So
*nothing* is marked while the press is pending, and the ending that turns out to be
the menu has nothing to take back: the mark belongs to the gesture that means it.
The mark the click would set is decided from the row as it was pressed — the value
that row was *not*, so a marked row unmarks — and that one answer is what a sweep
paints too: a paint rather than a per-row toggle, so crossing a row twice, or
coming back over it, leaves it as the gesture first set it.

Holding is shown rather than guessed at — 150ms in (`HOLD_HINT_MS`) a ring appears
where the button went down and fills over the rest of the hold (`HoldRing.vue`,
`styles/hold.css`), so a plain click never flashes one — and `HOLD_MENU_MS` is
450ms rather than the second Total Commander uses for exactly this collision (a
marking right button meeting a context menu) because the ring makes the wait
visible where that one gives nothing to look at until the menu is up. The ring is
an element rather than a `cursor:` image because a cursor image cannot animate,
and what *decides* the gesture is the JS timer: the animation is decoration, so a
throttled or disabled one costs the ring and not the menu.

The sweep is a *region*, not the rows the pointer was reported over
(`paintSweepTo`): pointer events arrive at their own rate, so a flick crosses a
dozen rows between two of them, and the rows it crossed are what the gesture was
drawing a line through — each one paints forward from the last row it painted,
which is also what makes a fast flick correct rather than merely less wrong, since
the row it started painting from is the row the button went down on. The row
entered during a fast flick is painted in the same pass that starts the sweep,
because `mouseenter` is reported *before* `mousemove` for one pointer move: a
swipe that crossed a row inside the slop would otherwise start painting from the
wrong place. `Ctrl+right-click` asks for the menu outright, and a hold is
abandoned rather than resolved when the window loses focus with the button still
down — no release is coming that the pane will hear.

### The menu is the app's; the pane only asks for it

`FilePanel` emits `context-menu` with the row's *path* — a held button gives the
pane time to re-list, so an index taken at the press can name a different row by
the time it is read — and the app owns the menu (`PaneContextMenu.vue`,
`lib/paneMenu.ts`), since the items are the keys' own operations and those are the
app's. Opening it puts the cursor on that row: `F5`, `F8` and `F3` act on the
cursor, or on the marks, so the row the menu is *about* has to be the row they
would act on, or the menu is a trap rather than a shortcut. And it is the menu that
has to do it, since the right press that asks for it moves the cursor nowhere (see
the right button above): this is the one thing that brings both routes to the same
place — the pointer's, which marks rather than moves, and the keyboard's
`Shift+F10`, which has no press behind it at all. The entries are captured as it
opens, exactly as the delete and copy dialogs capture their targets, so a refresh
under it cannot change what they say or do.

**Opening the row is deliberately not an item**: `Enter` and a double-click are the
row's own gesture, and a menu that repeats what the pointer has just done is a
longer way to the same place — so what the menu carries is what the listing cannot
say with one click, which is View/Edit for a file, the full-screen mode for media,
the transfers, Rename, Delete, the mark, and `Hide (add to .mchide)` (written up
with the file it writes — see the hide mode above). Each item carries the key that
does the same thing without a menu, since being where those are found is half of
what the menu is for, and the separators are put *between* the groups that came out
with something in them rather than written into the list: what a row can offer
depends on what it is — a folder has no view, edit or full-screen — and a divider
with nothing on one side of it is a line the menu has nothing to say.

`Shift+F10` and the keyboard's own `Menu` key ask for it on the cursor row, anchored
from the same index-against-`ROW_HEIGHT` arithmetic the windowed listing is built
on (`cursorMenuAnchor`), because a scrolled-out row has no element to measure.
`Shift+F10` is claimed after the expanded-terminal check, with the panes' own keys,
since what it is about is a row of a listing an expanded terminal has left no room
for, and it is `Shift+F10` rather than `F10` because `F10` alone is what the
programs running in the terminal use (`mc`'s quit, `vim`'s menu). The full-screen
presentation is the one it leaves alone: the panes are covered by the display, so a
menu about a cursor nobody can see is not a thing to offer — while a display *in a
pane* leaves the asking pane's own listing where it was, and its menu is that
pane's business like any other.

While it is up the menu holds the keyboard by holding the *focus*: its own handler
moves the highlight with the arrows and picks with Enter, Escape (claimed by the
app, which closes it) is the way out, and `restoreFocus` leaves it alone. **A hidden
element cannot be focused**, which is the one thing that has to be got right about
that: the menu is drawn `invisible` for the single frame its own size is being
measured in, and `focus()` on it while it is still hidden is silently ignored — the
arrows then drive the shell's line editor behind the menu, which reads as the menu
ignoring the keyboard entirely. So the focus waits for the placement to reach the
DOM. As a second line of defence the app also *drops* any key that is not the
menu's own (`ownsKey(event.target)`), so a key that arrives while the focus is
somewhere else cannot reach the panes or the shell behind a menu that is meant to
be the only thing listening. Its backdrop is the whole window, which is what makes
a click anywhere else, or a wheel, a dismissal. The backdrop carries
`@contextmenu.prevent` for the release that ends a hold: the button is still down
when the menu appears, so that release lands on the backdrop, and a platform that
fires `contextmenu` on the way *up* would otherwise find an element with no handler
for it. That release is deliberately not a click on anything — a menu opened under
a held button must not pick the item under the pointer when the button comes up.
Two places have no menu on purpose: the `..` row, and the empty space below the
listing.

## Files

### A file the user can run is named in green

The rule is `isRunnable` in `lib/executable.ts`, and it needs both halves: an exec
bit on a regular file, *and* a name the icon table has not already recognized as
data. So a screenshot that happens to be `+x`, a `.deb`, and every directory (all
directories are executable) keep their ordinary color, while a compiled binary
with no extension and a `libfoo.so.2` are named in green — the latter because the
test is on the extension the icon table would use, and its last dotted part names
nothing. The color is `text-runnable` (`main.css`, `--color-runnable`), and it
goes on the row's *name span* by way of `nameClass`, not on the row: the icon
keeps the color its own type gives it, the size and date beside the name take the
plain `text-fg` rather than a dim of it, and a marked row keeps the green too —
the mark's band is a tint, so the name goes on reading in its own color there. The
exception is the cursor standing on a marked row: its gold takes the name as it
takes the rest of the row's text (`text-selected` overrides `text-runnable` in
`nameClass`), and the green comes back with the cursor leaving.

### A broken symlink's target is red

The `→ target` beside a symlink's name is the dim gray (`text-fg-dim`) that keeps
it secondary to the name, and `text-danger` when the link does not resolve. Nothing
has to test for that: `kind` is `symlink` only when `stat` through the link failed —
a loop, a permission, and by far the most often a target that is not there, which
is what `~/.steampath` is. Only the target takes the color; the name goes on
reading as the name, and the span is its own under the cursor and on a marked row
too (`symlinkTargetClass` in `FilePanel.vue`).

### A file the user can run is run on Enter, in the shell the panes already have

`shouldExecute` (`lib/executable.ts`) is the green rule less a `.desktop` — that
one *describes* a program, and the system is what launches those — and the pane
hands the entry to its workspace, which types the quoted path into the shell's own
line and submits it (`runInShell` in `useWorkspace.ts`), so it echoes and reaches
the history like a real command line. The program's stdout and stderr *are* the
terminal's: it is the shell's foreground process rather than something spawned
behind its back, so there is nothing to pipe anywhere. The terminal is shown for as
long as it runs — the run expands it, and collapses it again only if it was
collapsed to begin with and no Ctrl+O touched it in between, since a program that
holds the shell holds the terminal with it. When it is over is the same signal the
panes already keep for a submitted command: `shell.idle`, the one that re-lists the
panes at the shell's directory and releases the `await`. The panes' own view is
left where it was for all of it: the terminal taking room and giving it back is the
pane's box changing rather than the listing moving, which is a resize
`onListResize` has no cursor to reveal for (see the footer's own note). A busy
shell takes no second command, so Enter on an executable while one runs is refused
with the pane's own notice rather than fed to whatever is running.

### `F7` creates a directory, and the dialog takes a name rather than a path field

Making a folder is the sibling of `F5`/`F6`/`F8`, so it is the same shape: a key
stages a modal the app owns (`ConfirmMkdir.vue`, `mkdirOpen` in `App.vue`) and the
dialog's confirm is what acts. The field is a *name*, not a destination: the pane
the gesture was made on is where the folder goes (`activePane`), and the name is
what to call it — while a path typed there still works, resolved by main the way
the transfer dialogs resolve their destination (absolute as given, relative
against the pane), so `notes` and `~/work/notes` both land where they read.
`fs:mkdir` is deliberately *not* recursive: the gesture is "make this directory",
so a name that is already there is an `EEXIST` the pane reports through its notice
rather than a success that changed nothing, and a missing parent is a real error
rather than a chain of folders nobody asked for. (The transfers *are* recursive,
because there a folder destination is a place to put things, not the thing asked
for.) The resolved directory comes back, so the pane re-lists with its cursor on
the new folder, exactly as an in-place rename lands on the renamed entry, and
every pane showing that directory is muted around the operation (`beginSelfChange`)
so the folder it just made does not sweep as though a program had written it —
the same reason `mkdir foo` at the prompt is muted.

## Git status

### Git is asked, not reimplemented

The panes read a repository's status by running `git status --porcelain=v2`
(`src/main/ipc/git.ts`), the same way a clip Chromium cannot play is transcoded by
running ffmpeg: an external binary this app can do without, gated behind a probe
(`MC_GIT` names one that is not on `PATH`), and answered with nothing drawn when it
is not there. A library was the obvious alternative and was measured before being
turned down. `isomorphic-git`'s `statusMatrix` takes 23ms on this repository's 70
files and 380ms on a 9,409-file work tree, where the binary takes 1.2ms and 10ms
for the same answer — and forking git at all costs 0.7ms, which is not where a
status read spends its time. Status is index-parse, tree-walk and `lstat` work that
git does in C with index v4, `core.untrackedCache` and `core.fsmonitor` behind it,
and the JavaScript one redoes all of it with none of those caches, so the gap
widens on exactly the repositories where it would matter. `nodegit` is worse: a
native module would need `electron-rebuild` and a libgit2 in the package, which is
the thing node-pty is praised here for *not* needing. The binary is also the more
truthful reader — it detects renames (the library reports a staged rename as a
delete plus an untracked add, so the `R` a file manager most wants is simply
absent), it has a vocabulary for unmerged paths, it understands worktrees and
submodules, and every one of those stays right as the user's git version,
gitattributes and configuration change. The fear a library would answer is forks
per file, and there is no such thing: porcelain answers for the whole work tree in
one call, so it is one fork per repository per refresh.

Two flags matter more than they look. `--no-optional-locks` (with
`GIT_OPTIONAL_LOCKS=0` in the environment) stops the read from refreshing the index
in place: without it, asking git a question rewrites the index, races the user's own
git and every editor open on the same work tree, and fires our own watcher for a
notification about nothing. `-z` is what lets a path hold a space or a newline
without being quoted, and it is what makes a rename's origin an unambiguous field.
`maxBuffer` is raised well past `execFile`'s 1 MiB, because the status of a large
work tree is precisely the output that outgrows it.

### A row's mark is a dot on its own icon

A row git has something to say about carries a small dot on the corner of its icon,
in the colour the status carries: amber for a modification, green for an addition or
an untracked path, red for a deletion or a conflict, blue for a rename. It is filled
when the entry itself is what changed and a ring when the folder merely holds what
did, so "this file" and "inside here" are told apart without reading anything beside
them.

The colour is the whole of the mark, which is what makes it free: a dot costs no
width, so the listing's columns never move and no row has to reserve space for a
character it might not have. It also cannot live on the *name* — green there already
means runnable and gold means marked, and a broken symlink's target is red, so a
fourth meaning in the same place would be a collision rather than a feature. The
palette lives in `lib/gitMark.ts` beside `fileIcon.ts`'s for the reason it does
there: it is chosen per entry, from what git said about it, so it cannot be a class.

What a colour cannot say, the title and the footer do — words are what a dot has no
room for, and both of those places have room. Git's two status characters are still
what all of it is *read* from, the pair being what tells one modification from two;
they are simply not drawn, because a row's width is worth more to the listing than a
repetition of what the dot already says.

### A folder shows the best of what is inside it

The pane does not ask per row. `buildGitView` turns one status into a `Map` of
changed absolute paths and another of every folder holding one — rolled up in main's
own terms at build time, so a row's mark is a `Map.get` and the window's thirty rows
cost nothing. A folder's mark is the most interesting thing beneath it (a conflict
before a staged change, a staged change before a deletion, which matters because a
deletion's own row is *gone* — the path is no longer in the listing — so the folder
is the only place it can ever appear), with the count in the title. Deleted files
are the one status a listing cannot show as a row, and the roll-up is what makes
them visible at all.

One case needed care: git reports a *wholly* untracked directory as a single
`/`-suffixed record rather than listing the files in it, which is cheaper and is
what the folder's own row wants — but a pane standing *inside* that directory then
has nothing of its own to go on, while everything there is untracked. So those
directories are remembered as a set (`GitView.untracked`) and a row walks its path
up to the work tree's root to find one, one lookup per level. A pane inside a
brand-new project therefore says `??` about everything, which is exactly what is
true of it.

The mark is read off the same window as the rows (`visibleRows`), so a status read
landing re-renders exactly the rows it could mark, and the pane holds it raw
(`markRaw`) because it is replaced whole and never edited — there is no reactive
path inside it worth paying for.

### The status bar says in words what a row's dot says in colour

The footer's right group already describes the row under the cursor — its mode, its
size, its date — so that row's git mark belongs there too: a dot carrying the
status's colour, and the status itself to the right of it. A dot on a 22px row has
no room for words, so this is where they go, and the row's own full label is in the
footer's title for where even these run out. The dot is drawn the way the row's is
— filled when the entry is the thing that changed, a ring when the folder only
holds what did — so "this file" and "inside here" read the same way in both places.

`markSummary` says it in as few words as a status bar has room for, which is a
second form of the mark rather than the same one clipped: a rename's origin and the
difference between one modification and two are the title's business, not the
footer's, and a folder's dot says the kind so its words need only count. A row git
has nothing to say about shows nothing at all, which is what keeps a clean
directory's footer as quiet as its rows.

### The work tree's HEAD is the pane's, not the app's

The title bar carries the branch — or `detached@<short sha>` — with how far HEAD has
drifted from its upstream. Per pane, because the two panes can be in different
repositories, and in the title's own colour rather than the gold the marks take, so
nothing up there competes with a selection further down. It is what makes a
repository visible in a *clean* directory, where every mark is blank by design.

Beside it sits how dirty the tree is, as one count with a dot in the colour of the
highest thing in it. That count is the *repository's*, not the directory's and not
the cursor's: the branch name is already an answer about the whole work tree, and a
count answering about a corner of it would read as a contradiction with the name it
stands beside — which is the whole difference between this and the footer, whose dot
and words belong to the row under the cursor. It counts *entries*, not files, because
a wholly untracked directory is one record naming however many files are inside it,
and finding that number out would cost exactly the read the collapse exists to save.
The breakdown the count has no room for is in the chip's title, where the kinds are
counted so that no entry lands in two of them — "staged and changed again" is its
own kind rather than a member of both — and so they add up to the count beside them.
A clean tree adds nothing at all: the branch is then the whole of what there is to
say, and a repository with nothing to report should not have to be read twice to
learn it.

### Watching what git thinks, and the writes it does not see

A stage, a commit or a checkout moves nothing in the directory the pane is listing —
it moves `.git` — so the directory watch cannot see it and a second watcher does
(`git:watch`, refcounted per work tree like the directory watch, debounced the same
way because a `git switch` is a burst). It watches the git directory itself, which
is where `index` and `HEAD` live, and the shared `refs/heads`, because a branch ref
can be rewritten without either of those moving. A pane re-targets that watch only
when it moves to a *different* work tree, so walking between a repository's folders
does not close and reopen main's watchers at every step.

The other direction is the subtle one. A file written in a directory the app already
watches changes the repository's status too, and the pane that should hear about it
may be looking somewhere else entirely — so the directory watch calls back into the
git side (`noteDirectoryChanged`), which drops the repository's cached answer and
tells every pane watching that work tree. That, plus a short freshness window and
in-flight sharing so two panes refreshing together cost one status read, is what
keeps the two panes honest about each other's edits.

## The preview footer

### Images

The footer grows to fit a thumbnail read through `fs:read-image`, which is the only
way to show a file the renderer has no URL for: the extension->MIME map lives in
`src/shared/image.ts` so both sides agree on what is previewable, main returns a
`data:` URL (the renderer CSP allows `img-src data:` but not `file:`), and
`FilePanel` reserves the space from the moment the cursor lands on media — the
extension says it is, before anything has been read — so stepping between clips
never collapses the footer and pushes the list back up.

The strip itself moves between its two sizes — the 24px status bar and the 72px
one carrying a preview box — and only its *growth* is animated, because only that
can be: a strip shrinking sweeps down over the very rows it is uncovering, so a
cursor landing there would sit behind it for the length of the animation, and
keeping the row clear of it instead would leave the listing scrolled up past where
the cursor's own move put it — a scroll nothing would ever take back. So the strip
snaps smaller, and the move that measures the listing's room (`scrollRowIntoView`)
is the one the instant resize decided.

Growing sweeps the same way, but the room it takes is room the cursor row needs
anyway, so there the reveal is the answer: the listing's own change of size is what
keeps the row clear of the strip as it arrives (`onListResize`), which is what makes
a move onto media near the bottom land with the row visible however much the strip
takes — and it is deliberately one-way, since a listing that has just *gained* room
must not be scrolled up for room it is regaining. That reveal is the *strip's*
alone, and `onListResize` tells the two causes of a resize apart by the footer's
own height: the pane's box changing — the terminal taking room for a program and
giving it back — must leave the view alone, since nothing in the listing moved and
the reveal would scroll the view down into the shrunken pane with nothing to bring
it back.

What the strip may not do either way is move the rows: its height is the listing's
height, so as it gives its room back the view's bottom edge moves, and the browser
keeps the view where it is rather than show blank below the content, which would
drag the rows down with it. The listing therefore carries a band at its end
(`listSlack`), measured by the move that is about to change the strip from the room
the listing has or is about to have — whichever is more, since a strip on its way
out has not given anything back yet — and only ever as wide as the scroll past the
listing's end is, so a listing that is not sitting at its end has none and the band
is never more than the strip's own growth (`FOOTER_GROWTH`).

Inside that space the box is held at the shape of the row just left until the new
one is known, so it neither blinks between rows nor is ever drawn at a shape it is
about to leave; only the first media row of a run, whose shape has never been
known, shows a bare spinner in the reserved space instead. The box is then drawn at
the picture's own shape: `fs:image-size` reads only the header
(`src/main/imageSize.ts`, no decode), so the box is the right ratio with a spinner
in it before the image arrives, and nothing jumps when it does. That probe is
issued on the cursor move itself, while the read waits out the settle delay, and
the box is held back until it answers: deferring the probe with the read left the
ratio-less default frame on screen for the whole settle delay, flashing a wide box
on the way to every preview, and a header read is cheap enough to run for each row
a key repeat passes over. The probe is also the reason a rotated photo is framed
correctly: it folds in the JPEG's EXIF orientation, which is what the browser will
apply when it paints. A format the header cannot be measured from (AVIF) leaves the
box at its cap and the image's own ratio is adopted once it renders.

The read itself waits for the cursor to settle (`PREVIEW_SETTLE_MS`, re-armed by
every cursor change): reading each row a held arrow key passes over stalls the
renderer on a large data URL — and main on a large decode — and the input being
handled is what pays for it, which is exactly the choppy cursor movement that
produces. The read is keyed by path *and* size/mtime and token-guarded, so an
external rewrite reloads while a slow read for a row the user has left cannot land
on the newer one, and main keeps the last few previews (bounded by bytes and by
count) so scrolling back over a folder does not pay for the same image twice. A
mapped extension that still fails to decode (a truncated PNG) clears the preview
through the `<img>` error handler and releases the space — the bar shows nothing
rather than a broken frame. Size is handled in main rather than refused: a file up
to 16 MiB travels as its own bytes — so an animated GIF stays animated, an SVG
stays vector and a JPEG keeps its EXIF orientation — and anything larger is decoded
with `nativeImage` and downscaled to 512px, so the payload stays small however
large the source is. That decode is synchronous and blocks main for the length of
one image, which is exactly why the small-file path skips it. Only a file that is
both past 64 MiB and undecodable by the platform is refused, and its reserved space
is given back.

### Video

A video cannot be read whole the way an image can — one frame's worth is a hundred
megabytes here — so main serves it as a ranged byte stream on its own `mc-media`
scheme (`src/main/media.ts`) and the footer mounts a `<video>` on it. The element
is muted — it is the *display*, not the thumbnail, that makes a sound when a clip
is enlarged — and it plays once rather than looping: a looping 4K clip decodes for
as long as the cursor happens to rest on the row, measured at over half a core. Its
box shows a spinner for as long as the box is up without a frame in it — which for
a clip main has to encode before any of it can play is the whole of that wait.

Beside the thumbnail the footer shows where the clip is: its position, a bar for
how far through it that is, and its length: what the element reports for a clip
Chromium plays itself, and `fs:video-duration` for one main has to encode — that
clip is a live stream, which reports only what is left of the clip rather than the
clip, so ffprobe is asked for the file's own. The bar is absent while there is
neither a length to show nor a position yet.

The scheme is declared before the app is ready, `media-src` carries it in the CSP,
and only previewable extensions are served, so it cannot become a reader for
anything the bar would not have offered anyway. A `.mov` is served as `video/mp4`:
Chromium demuxes the H.264 or HEVC inside an ISOBMFF container but will not accept
the QuickTime type, and `videoMimeFor` is the only place that mapping lives. Its
shape comes from the element's own metadata — there is no header parser for video
*dimensions*, as there is for images — so the element is mounted, and therefore
starts fetching, only once the cursor settles: like the image read, a burst over a
folder of clips must not start a fetch per row. (What stream to mount at all is a
header read of its own — see the codec sniff below.)

Finally the window disables the hardware video decoder (in `src/main/index.ts`):
its frames reach the compositor as DMA-BUFs that a Linux session without a working
GBM path cannot import, which takes the GPU process down with the decode and
disturbs the window's rendering over a preview nobody asked to watch.

### A clip Chromium cannot play is transcoded, when ffmpeg is there to do it

Chromium has no demuxer for AVI or ASF, and no decoder for the motion JPEG of an
old camcorder AVI or the WMV3/VC-1 of an ASF one — `canPlayType` answers no for
every one of them — so `src/shared/video.ts` keeps a second extension list of what
only ffmpeg can make playable, and main encodes those into H.264 for the same
`mc-media` stream (at most 720px wide, with its sound: a footer thumbnail is muted
by the element that plays it, but a display is heard). The encode is streamed out
**as it is produced** (`empty_moov` + `frag_keyframe`, a keyframe every thirty
frames, straight to the response with nothing written to disk): a plain mp4 has no
header until its encode has ended, so waiting for one would mean a black box for
the length of the whole clip, and a fragment is on screen a tenth of a second in
instead. There is no length limit and no finished file to wait for — a display is a
*player*, so a feature-length file is watched rather than prepared, and the encode
runs for as long as the clip is looked at (the element going away is what stops
it).

`from` is the whole of seeking, and is why the keys work on such a clip at all: a
live stream reports no range to move within, so moving about the clip means asking
for the stream again — `-ss` before the input — from the position wanted. The
element rebases whatever it is given to zero, so the pane that asked adds that
offset back to say where the clip is, and takes the length from the file itself
(`fs:video-duration`) rather than from a stream that only knows what is left of it.
However many elements ask for a clip — a footer playing it and a display showing
it — each has its own stream, and a seek on either is a position in the clip.

All of this is gated on ffmpeg existing: the renderer asks once (`fs:can-transcode`)
and, with no answer, those files are not media at all — `Enter` opens them in the
system player, exactly as before that list existed. That list is not the only way
in to this encode, either: a container Chromium demuxes but cannot decode reaches
it too (see the next note). `MC_FFMPEG` names the binary for a machine that keeps
it off the PATH.

### A container Chromium demuxes is not a stream Chromium decodes

Only the header can tell the two apart. An `.mp4` off a phone is HEVC as often as
it is H.264, and HEVC is the one codec Chromium reaches *only* through a platform
decoder — which on Linux is the hardware video decoder this app turns off (see
`src/main/index.ts`) — so such a file demuxes, plays its sound and draws nothing at
all. No extension can say which it is, so `src/main/videoCodec.ts` reads the codec
out of the file's own header: a box walk down `moov` → `trak` whose handler is
`vide` → `mdia` → `minf` → `stbl` → `stsd`, whose first sample entry's
four-character type *is* the codec. Only each box's own header is read, which is
what makes this a header read and not a file read: `moov` sits after the `mdat` of
anything written without fast-start, so a prefix of the file would not hold it, and
the walk seeks instead. Only the ISOBMFF containers are read at all
(`videoCodecSniffable`: `mp4`, `m4v`, `mov`) — those are the ones that carry such a
stream, while the other containers Chromium demuxes hold the codecs its own parsers
were written for — and nothing that fails on the way (a header that will not parse,
no video track where it looks, a file that has gone) is an error: it answers null,
which is not an accusation, and the file is served as it stands. What counts as
decodable is `DECODABLE_VIDEO_CODECS` (`avc1`/`avc3`, `vp08`/`vp09`, `av01`), and
`codecNeedsTranscode` is the question both sides ask. It is deliberately *not*
asked of the media stack: `canPlayType` answers "probably" for HEVC on this machine
and then never produces a frame.

Both sides have to know, because a clip that needs an encode is a *stream*: `from`
is what seeks it and `fs:video-duration` is what can say how long it is, so
`PreviewTarget.encode` carries the answer for the URL, the clock and the seek
alike. The renderer fills it from `fs:video-codec`, asked by `probeVideoCodec` on
the cursor move itself — a header read in main, memoized there by path/size/mtime,
so the pane's question and the stream's own request share one read — and held in a
reactive map keyed by path *and* size/mtime, so an answer that lands while the
cursor is already on the row re-derives the target through the same
`previewTargetFor`: the element is remounted on the other URL, or — a display
already playing — carries on from where it was. The flag travels with the
`StageRequest`, so the pane showing a display is told how to play it by the pane
that asked. With no ffmpeg to encode it, such a file is not media at all: `Enter`
opens it in the system player, exactly as an AVI with no ffmpeg is. That verdict
only settles once the header has been read, so its footer preview can collapse a
moment after the row's extension claimed it — which is the one price of asking the
file instead of its name.

## Display and full-screen

### A display is a mode of the panes, not a third overlay

`Enter` on an image or a video hands it to the *other* pane to show at full size
(`Enter` again takes it away, and `Escape` leaves the mode): the cursor stays where
it was, the pane that asked keeps the keyboard, and the display follows that cursor
from row to row — so the two panes are a browser and a screen rather than two
browsers. The listing the pane was showing stays in place and is blurred behind
the display — a `filter` on that content (`paneContent`), animated in over the
reveal and back out as it is dismissed, so the pane needs no background of its own
and the media sits on the folder it came from. That content is also clipped to its
own box (`clip-path: inset(0)`): a filter's output is not held inside the element
it is applied to, so the blur would otherwise spill over the border into the pane
next door. That blur belongs to the *mode*, not to whatever is being shown: on a
row there is nothing to display for, the display empties but the pane stays blurred
and covered — saying so, and how to leave (`Preview mode` / `Esc or right-click to
exit`, the two ways out) — and coming back to a media file fills it again.

The display itself carries no chrome, not even the file's name, so the media is all
there is to look at — except a video's play bar directly beneath it, exactly as
wide as the picture, with a play/pause button, its position and its length. The
whole row is the seek target, so it is grabbable with the mouse: clicking or
dragging scrubs the clip (a clip main must encode is re-asked from the dropped
position, rather than re-encoding per pixel). A left click on the picture itself
pauses or resumes it, as does `Space` while the command line is empty, while a
double left-click on the enlarged media — a clip or a still, the same gesture on
either — trades the pane and the whole window: the mouse's half of the `Ctrl+Enter`
full-screen toggle, where a clip's own pair of play/pause clicks cancel out.

What the screen shows is *derived* from the browser's cursor (`stageTarget` in
`App.vue`), not pushed to it, which is what makes navigating update it for free;
leaving media for an ordinary row empties the screen instead of freezing the last
picture. `Tab` is claimed while a display is up — it would move the keyboard, and
with it which cursor is being displayed, to the other pane — while `Ctrl+U` swaps
the panes and takes the display with them: a display belongs to a *pane*, not to a
column, so the exchange is not a reason to leave the mode — the pane that was
showing shows on from the other column, and the pane that asked stays the active
one, now in the other column itself. Nothing of the display is taken down for it:
the panes are reordered rather than rebuilt (see `swapPanels` in `useWorkspace.ts`),
so what is on screen is the same element, still wherever the clip had got to, and a
clip main has to encode goes on streaming instead of being asked for again at that
offset. Switching tabs or closing one leaves the mode too, since the panes it
belonged to are gone.

The mouse makes the same two gestures: a double-click on the footer thumbnail asks
for the display when one is not already up (`stage-on` → `showStage`) — as does a
double-click on the row of an image or a video, which is `Enter` on it without its
toggling back off (`activate` → `activateRow`) — while a single click on that
thumbnail is the clip's own play/pause, and a triple one escalates past the pane to
the whole window (`fullscreen` → `openFullscreen`), the same escalation a
triple-click on a row's name makes. The single and triple clicks reach the
thumbnail through one `click` handler that reads the browser's click count, and the
double sits on `dblclick` as on the enlarged display — where each of a
double-click's two clicks toggles play/pause, so the pair cancels out and only the
pane's display is left to open, leaving the clip as it was found — and a quick
right-click on the pane showing it leaves the mode (`stage-off` → `exitStage`) —
the mouse's `Enter` and `Escape`; a held right press, or one that wheel-scrubs the
clip, is not that click.

A display's media fills the pane however small the file is (`h-full w-full
object-contain`), upscaled as far as its own aspect allows, so a 320x240 camcorder
clip is not a postage stamp in the middle of it. The reveal is one animation of one
element: the media is laid out where it will sit, then transformed back onto the
footer thumbnail it grew out of (`translate` and `scale` together), and released.
It is the media's *own* rectangle that is moved, not the element's — the element is
the whole pane with the media letterboxed inside it, so `drawnRect` works out where
the picture actually is from the element's box and the media's intrinsic size, and
`handoffTransform` lays that onto the thumbnail (`previewRect()` on the source
pane). It plays once per *entry* into the mode, guarded by `stage.animation`, so
arrowing through a folder swaps the display in place rather than re-animating on
every row — and a row whose thumbnail is not up yet has nothing to grow from, so it
simply appears. The gesture is for entering the mode and leaving it, not for the
cursor crossing a row: a display that has nothing to show for a row empties at once
(no shrink onto a thumbnail that never held it), and coming back onto a media file
fills it again without the reveal — nothing grew out of that thumbnail either.
Leaving the mode plays the same gesture backwards and waits for it: the media
shrinks back onto the thumbnail it came from and is only taken off screen when it
has arrived, so `FilePanel` holds the request it is showing (`shownStage`) past the
prop that asked for it, and a display asked for again mid-dismissal calls the
shrink off instead of flickering.

A display is watched rather than glanced at, so an enlarged clip is the one thing
that makes a sound: its element stays muted until the reveal, then its volume is
ramped up over the reveal's own length, and ramped back down — ending muted — as it
shrinks away. The footer's own thumbnail stays silent throughout. It does not loop,
either: a clip that has run out stays on its last frame with the transport saying
`Play`, so the end of the clip is an end here too, and only a step back into it
plays on (`onStageEnded` clears `stagePlaying`, since an ended element fires no
`pause`). The ramp follows frame callbacks for smoothness but is bounded in time as
well, because those stop while the window is hidden and a dismissal waits on it.

The display *takes the clip over*: the pane that asked gives up its own copy rather
than playing it twice — no `<video>` is mounted in its footer, so a 4K clip is not
decoded to draw the same thing twice — while the space the thumbnail had is kept,
so nothing about the strip moves and the shrink still has somewhere to land. Its
play bar is drawn from the display instead: the displaying pane publishes the clock
it is playing (`stage-clock`, a `PlaybackClock`) and the pane that asked reads it,
asking the file itself for a length when the display can only say where it is (a
clip still being encoded). The position travels with the clip in *both* directions,
so enlarging one is the same clip changing place rather than starting over: the ask
carries where the footer's own preview had got to (`resumeAt`, taken before the
display exists, because the display is what takes that element away), and dismissing
hands it back the same way. Each element is created fresh for the hand, so the
position is applied as soon as the new one knows enough to be moved — and it is held
with the clip it belongs to, so it can never be carried onto a different one. A
preview that has played itself out hands nothing over: the display is where a clip
is *watched*, so it starts that one again rather than sitting on the last frame the
thumbnail stopped at. The bar spans the hand-off for the same reason it must not
flicker: it reads the display's clock while the display has the clip, the held
position while the clip is on its way back to an element that is still at 0:00, and
its own element otherwise — the clock is read from `loadeddata` rather than
`durationchange` for exactly that reason, since the earlier of the two fires before
the hand-back has been applied.

With the command line empty the arrow keys — and the coarser `Ctrl+J`/`Ctrl+L` (a
minute) and `Ctrl+H`/`Ctrl+;` (ten) steps — are a scrubber for what is showing
(`seekPreview` steps the footer's clip and, when a display is up, the same clip in
the other pane, so the two cannot drift apart): stepping back into a clip that had
played itself out plays on from there, and stepping past its end stops there — the
end of a clip is not quietly its beginning again. The wheel over a clip is a
scrubber too (`wheelScrub` in `FilePanel`): a plain wheel steps it ten seconds, the
left button held a minute and the right button ten — wheel-up forward — and in a
footer it is bound to the media box rather than the whole pane, so the wheel over
the listing still scrolls the listing. In the *display* the media box is not the
element (`overStageMedia`): the wheel is measured against the picture's own
rectangle — an image's element is the whole stage with the picture letterboxed
inside it — and against the transport directly under it, so a wheel on a clip's
picture or on its bar seeks, while one over a *picture* — an image, which has
nothing to move within — is the folder's wheel like any other, as is one anywhere
else in the pane — the letterbox, the padding, an emptied display — which steps the
*folder being browsed* instead: one row a notch, up for the row above and down for
the one below, which a display follows on its own. That is a way of flicking
through what a display is showing without leaving the mode, and a wheel turned with
a button held is part of that press's gesture here too, so its release neither
leaves the mode nor counts as a click.

### An action on a clip is answered by a YouTube-style on-screen display

A pause, a resume or a seek flashes a glyph over the picture that holds for a
moment and fades on its own (`PlaybackOsd.vue`, `styles/osd.css`) — nothing is
permanently drawn over the video, and a repeat of the action restarts the flash
rather than being swallowed. It is a play/pause glyph in the middle, or a direction
chevron with how far the clip was stepped on the side it is moving toward — seconds
as `10`, and a coarser step as `1m`/`10m` (`formatSeekStep`), at the size of the box
it is over: the enlarged display's, or — when no display is up, so the footer's own
preview is the thing being driven — the small thumbnail's, compact. The overlay owns
only the *animation*: it reports the end of the flash back with a `done` event, so
no timer has to be kept in step with the CSS, and it never takes a click
(`pointer-events-none`). The footer and the display keep one display each, since the
two can be showing different clips. A seek is flashed in `seek()` itself, so the
keyboard, the wheel and the coarser Ctrl steps read the same, while a drag of the
transport does not — that is a scrub with the bar under the pointer rather than a
step.

### The full-screen mode is the display, presented over the whole window

It is not a third thing to maintain: `Ctrl+Enter` (and a triple-click on a media
file's name, which is the same gesture with the mouse) opens the display the arrow
keys already drive and asks the pane showing it to lay it out over everything
instead of in its pane (`stageFullscreen` in `App.vue`, broadcast to both panes; the
overlay in `FilePanel` becomes `fixed inset-0 z-50` — the pane row is `isolate` and
its parent is positioned, so the fixed layer paints over the tab strip and the
terminal without anything being teleported or hidden). Everything else is untouched:
the pane that asked keeps the keyboard, so arrowing still browses the folder and the
media follows the cursor; seek, play/pause, the wheel, the transport and the sound
ramp are the same code. The display is the panes' business, so a pane
presentation's `Tab` and `Escape` are claimed with the panes' other keys — only
while the panes hold the keyboard — while the full-screen presentation, covering the
window, owns the two wherever the keyboard is, as the viewer owns its `Escape`: a
terminal nobody can see must not be the thing that answers them.

The reveal still grows out of the footer thumbnail — the source pane is behind the
overlay, not unmounted, so its footer is still measurable — and the reverse still
shrinks back onto it. A display that is already up changes *presentation* rather
than being entered or left, and that travels the same way
(`switchStagePresentation`): the media is laid out in the other box and then put
back onto the rectangle it had in the one it left, so the picture glides between its
pane and the window rather than jumping between two sizes, the transport travelling
with it. The far end of that travel is *measured* after the layout has turned —
which keeps a clip honest, since its box is measured from the area it sits in, so
the new area is fed in before the media is — and both flushes are microtasks of one
task, so the media is never painted at its new size before the motion that brings it
there. For the length of that motion the display counts itself a `z-40` layer
(`stageTravelling`), because it hangs over the other pane on the way and the divider
between the panes is a `z-30` one: at the pane's own rank the divider would be drawn
across the picture, which is what the handle wants at rest (its grab band and
re-centre button reach into the panes) and exactly what must not happen mid-travel.
What the display sits on is its own always window-sized layer (`stageBackdrop`):
transparent in the pane, opaque over everything else, and *faded* rather than
switched, because on the way back into the pane it has to go on covering what the
media is still hanging over until the picture has landed. That is also why leaving
the mode holds the full-window layout until the dismissal has landed
(`fullscreenPresentation` latches past the `fullscreen` prop when the mode is being
*left* — a presentation change, by contrast, moves it at once): snapping the overlay
back to its pane under the shrinking picture would resize the media out from under
its own animation. The pane row is `isolate` *and* `relative z-10`: isolation
confines the panes' own z-ranks to the row, but it also confines the fixed overlay
that lives inside a pane, so the row must itself be a positioned stacking context —
a non-positioned row is painted before the terminal that follows it, and the overlay
then sits under the command line instead of over it.

## The viewer

### The viewer is a modal overlay over the panes and terminal

`App.vue` renders `FileViewer` absolutely inside a `relative` wrapper that holds
`main` and `TerminalPane`, so the title and status bars stay visible. While a file
is open the window capture handler consumes only `Escape` and returns for everything
else, so Monaco — not the panes or the shell — owns the keyboard. Escape closing is
*delegated* to the viewer only for the question of whether there is anything to lose
— it exposes `isDirty()` via a template ref, since only it knows whether an edit
(F4) has unsaved changes — while the app owns the answer: a dirty buffer stages the
same kind of in-app `ConfirmDiscard` dialog as the copy and delete confirmations
(`discardOpen` in `App.vue`) rather than an OS `window.confirm`, so every prompt in
the app looks and behaves alike. Its Cancel hands focus back to the editor via the
viewer's `focusEditor()`, and its Discard is what actually closes. `Escape` is
claimed at the window level rather than as a Monaco command so that even a viewer
with no editor — one whose Monaco would not load — still closes. Ctrl+S is a Monaco
command, which the capture handler deliberately lets through untouched. A *save*
failure sets `saveError` (a header strip) rather than `error`, because `error` swaps
the editor's container out of the DOM — using it would unmount the very buffer the
user is still editing. A file the read had to truncate is refused for editing
outright: saving it back would write only the first 8 MiB and silently destroy the
tail.

**A file nothing can be shown of never opens the viewer at all.** `openViewer`
reads the file first and hands the `FileContent` to the viewer as a prop, rather
than letting the viewer read it: main refuses a binary or a non-regular file, and
that refusal is the *pane's* notice to give (`state.error` in the footer, exactly
like a failed copy), so F3/F4 on a binary leaves the listing and the command line
where they were instead of covering the window with an overlay whose only content is
the message. That notice is worded for the user rather than quoted from main — `"x"
looks binary — cannot be opened for viewing` (or `for editing`, as F4 asked) — since
`EBINARY: "x" looks binary` says what the machine found and not what was wanted;
every other failure keeps the `code: message` the panes report elsewhere. Escape
puts the notice away, after the things it would otherwise leave (an open search box,
a typed command line, an expanded terminal). A read is async and the cursor can move
— or another F3/F4 start — while one is in flight, so a request token guards it, and
closing a viewer retires the pending read with it. The viewer therefore exists only
with something to show, and its own `error` is Monaco failing to load.

### Viewing (F3) has no cursor, because its keys are a viewer's and not an editor's

The arrows scroll the document a line at a time, the pages a screenful, and
`Home`/`End` jump to its ends, instead of walking an invisible caret that would keep
the view still until it had passed the bottom of the screen. The remap is
`editor.addAction(...)` — not `addCommand` — at the core commands' own `scroll*`
ids (`scrollLineUp`/`scrollLineDown`/`scrollPageUp`/`scrollPageDown`/
`scrollEditorTop`/`scrollEditorBottom`), gated on `'textInputFocus'` so it stays out
of the find box the way Monaco's core navigation does, and only in view mode — F4
keeps the caret. `addAction` is not a style preference: a standalone editor's
`addCommand` registers a *global* dynamic keybinding whose `when` clause carries no
editor scope and which nothing unregisters, and its weight (1000) beats Monaco's own
core bindings (0). Such a leaked binding outlives the viewer and swallows the arrow
keys of a later F4 editor — its handler triggering the scroll on a disposed editor,
so the caret never moves — which is exactly the bug this replaced. `addAction` scopes
the binding to the editor's own `editorId` and returns a disposable, so the remap
lives and dies with the view. The caret itself is hidden by `styles/viewer.css`
(`.viewer-no-cursor .cursors-layer { display: none }`, the host carrying that class
only when read-only), which leaves the selection highlight — a different layer — so
the mouse still selects and copies; the current-line highlight goes too, via
`renderLineHighlight: 'none'`, since with no caret there is nothing for it to point
out.

### Monaco is imported only when the viewer first opens

Its workers are answered by `MonacoEnvironment.getWorker` with Vite `?worker`
imports in `lib/monaco.ts`. Monaco 0.57 otherwise builds its workers from
`new URL('...worker.js', import.meta.url)` paths inside `node_modules`, which do not
survive the build; installing `getWorker` before the first `editor.create` is what
makes the base and language workers load (verified under both dev `http://` and the
`file://` production build). F3 stays closed to anything that is not a regular file
— opening a FIFO would block — and main's `fs:read`, which the opener runs before the
viewer exists, re-checks that with `O_RDONLY | O_NONBLOCK` plus a NUL-byte binary
test and an 8 MiB ceiling, so the viewer is only ever opened for text an editor can
show (or a `truncated` flag), and `fs:write` (the save) refuses a target that exists
but is not a regular file or symlink.

**The language is the file's name first and its shebang second** (`languageFor` in
`lib/monaco.ts`): an extension or a known filename is the deliberate signal and wins
(`foo.py` is python however it starts), but the fallback is no signal at all, and
the file it leaves grey is exactly the extensionless script (`manage`, `configure`)
whose first line names its interpreter — so `#!/usr/bin/env python3` is highlighted
as python. Only interpreters with a tokenizer that fits are mapped: Monaco has no
awk or expect, and `fish`/`csh` are close enough to the shell tokenizer only in
name, so those stay plaintext — a script in the wrong colours reads worse than none.
The first line costs nothing to read because the viewer is handed the text anyway.

## The terminal

### The mono font is bundled, not hoped for

`--font-mono` starts with `'JetBrainsMono Nerd Font Mono'`, an `@font-face` in
`main.css` over the two TTFs in `src/renderer/src/assets/fonts/` (Nerd Fonts
v3.5.1, the *Mono* cut so icon glyphs are one cell wide and the terminal grid stays
square; `out/renderer` emits them, and the relative `url()` survives the `file://`
build, covered by `font-src 'self'` in the CSP). It is there because
box-drawing/block/braille and the private-use-area glyphs a TUI labels itself with —
Nerd Font icons, Powerline separators — are in no stock mono face, so without it
every one fell to a per-glyph fallback or tofu. Only Regular and Bold ship; italic
is synthesised. Because the font is now a web font, the first `fit()` measures a
fallback, so `TerminalPane` re-fits on `document.fonts.ready` — otherwise the
cols/rows reported to the pty would keep the fallback's cell size.

### The terminal's cell is the font's own line box

Which is what keeps a TUI's frames joined. xterm 6 uses the *DOM* renderer by
default, which draws every character — box-drawing included — with the font; its
`customGlyphs` option, the one that would have xterm draw those glyphs itself, is
documented as not working with that renderer and does nothing here. So continuity is
a question of cell height against glyph ink: JetBrains Mono's `│` spans ~1.52em
(bounds -400..1120 on a 1000 upem), while `lineHeight: 1.25` made a 20px cell for
the 12px font and left ~3px of it empty below the ink — every row a short dash, a
frame of "pipes" that never join, next to an emulator whose cell is the font's
natural height. `lineHeight: 1.0` gives the same 16px cell GNOME Terminal uses (the
font's `hhea` line box: 1020 + 300 on 1000 upem, ~1.32em = 15.84px, rounded to 16),
and there the ink overflows the cell and consecutive rows meet. The bundled font's
glyph coverage is what makes this work at all: a font without a range would fall back
per glyph and break the grid.

Measuring it is a one-liner over CDP, and it is worth doing before reaching for
`customGlyphs`: `document.querySelector('.xterm-rows').firstElementChild` and
`getComputedStyle(...).height` gives the real cell height, and forcing
`document.head` `<style>.xterm-rows > div { height: 16px !important }</style>` shows
the joined frame without a rebuild.

### The terminal is a surface of its own, not the app's chrome

Its xterm `background` and `cursorAccent` are `--color-surface-2` (#2d2d30), and the
`section` around it carries the same token (so the host's padding does not frame it
in another colour). A TUI is entitled to lay its layout out against the host
terminal's *default* background — `SGR 49`, which is what herdr leaves its sidebar
and panes at while it paints only its chrome — and that only reads as panels if the
background differs from the chrome drawn on top. Sharing the app's near-black
`--color-bg` (#1e1e1e) put the two within a few units of each other (herdr's base is
#1e1e2e) and flattened the whole UI, while a standard terminal background (GNOME's
#2e3436) showed it correctly. It is not a colour-depth or capability problem: herdr
emits only truecolour (`38;2` / `48;2`) and its colours arrive intact; the background
was the only delta. The sixteen ANSI slots are **xterm's defaults** (`#cd0000`,
`#00cd00`, `#0000ee`, `#5c5cff`, …), not VS Code's: ANSI standardises the slot names
and not their RGB values, so any palette is opinionated, and `TERM=xterm-256color`
makes xterm's the reference a CLI tool's colour choices are written against. That is
the least surprising set to inherit; the foreground (#cccccc) and the surface stay the
app's own.

## Keyboard and focus

### Intercepted keys must `stopPropagation`, not just `preventDefault`

xterm handles keys from a capture listener on its own textarea and does *not*
consult `defaultPrevented`, so a merely-prevented navigation key is still forwarded
to the shell — Up recalls history and Home moves the line cursor, silently
corrupting a half-typed command. `consume()` in `App.vue` does both, and that
listener is registered in setup so it runs ahead of xterm's.

### Incremental search holds DOM focus in its input

so `handlePaneKey` in `App.vue` intentionally lets editing keys through (printable
characters, Backspace/Delete) and intercepts only navigation keys. Anything added to
that switch also changes search-mode behaviour — decide deliberately whether the
search box or the pane should consume it.

### Focus model

The command line holds focus whenever the terminal does not, so `focusPanes()`
*focuses the command line* rather than blurring. The search box and the terminal are
the other two focus targets. Navigation keys are intercepted in the window capture
handler; editing keys are left to whichever input owns them.

## Styling

### Tailwind v4 is configured CSS-first

`@theme` in `src/renderer/src/styles/main.css`. There is no `tailwind.config.js`.
Theme tokens are the design system — prefer `bg-surface`, `text-fg-dim`,
`border-border` over raw hex values. The terminal resolves its font from the
`--font-mono` token at runtime, so the mono font is defined in one place.

### The renderer CSP

It lives in `src/renderer/index.html`. Dev-only allowances (`ws://localhost:*`,
`'unsafe-inline'` styles) are required for Vite HMR, and `img-src data:` /
`media-src mc-media:` are what let a footer show a preview the renderer has no URL
of its own for.
