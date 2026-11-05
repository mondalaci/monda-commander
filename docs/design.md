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

The model only sees what was *typed*, and readline also draws the line itself: a
history entry recalled with Up or Ctrl+P, a Tab completion, a Ctrl+Y yank are put
there without a byte reaching `onData`, so the model reads empty while the line
is full. Emptiness has consequences beyond `Enter` — it is what hands the arrows
to the clip (`seekPreview`) instead of the line — so the panes' keys take the
terminal's word for it as well: `TerminalPane.lineHasContent()` remembers where
the cursor rests while the shell reports it is waiting at a prompt (that spot is
the prompt's end), and calls the line occupied once the cursor is anywhere else.
The spot is re-read from every parsed write, not only from the idle transition,
because the panel → shell `cd` sync is a **builtin**: it never leaves the shell's
process group, so `pty:state` never reports a busy spell and the transition that
a `cd` typed into the shell would produce never comes, while the prompt it prints
(a new cwd, so a new length and possibly a new row) has still moved the spot. A
key-driven readline redraw — the exact thing that must read as occupied — is held
off, so it does not overwrite the spot with the end of the recalled line.
The remembered spot can go stale and read an empty line as occupied, which only
costs the clip scrub; the reverse — an occupied line read as empty — would send
the arrows away from the text, which is the one thing that must not happen.
(`shell.inputLine`, unfixed, still gates the cwd sync, so the sync can still
append to a line recalled from history.)

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

### A `cd` that did not take is said in the pane

The command line is the real shell, so a `cd` typed at it runs in the shell and
the shell's complaint about a path it cannot enter is printed to the pty. The
collapsed strip shows the row the **cursor** is on, which after a failed command
is the fresh prompt — so the error sits one row above it, in the clip's
scrollback, and the only way to see it is `Ctrl+O`. That is the whole reason the
pane says it instead: the gesture was made in the pane, and the pane is where the
user is looking.

Three things have to be true to say it without lying. First, the app has to know
a *directory change* was asked for: the submitted line is read off
`shell.lastCommand`, which is the model's line (`noteInput`), so only what was
typed is seen — a command readline drew itself (a history recall, a completion)
reaches the shell without a byte passing through `onData` and is not captured.
Second, it has to know the change did not take: `useWorkspace` remembers the
shell's cwd when the command was submitted and compares it once the command has
settled (`shell.cwd` is re-polled in `settleCommand` before `finishCommand`, so
the comparison is against a fresh read). Third — and this is what keeps `cd .`
from reading as a failure — it has to know the target is not a directory the
shell could have entered: "the cwd did not change" is also what a `cd` naming the
directory the shell is already in looks like. The target is resolved against the
submitted cwd (`lib/directoryChange.ts`) and asked of the filesystem, and only a
`list` that fails is reported, in the shell's own words.

The reading of the line is deliberately conservative. Only a plain path is
judged: a `~user`, a `$VAR`, a glob, an escape, a brace — anything the *shell*
resolves — is left to the shell, because the app resolving it wrongly would mean
a failure reported for a `cd` that worked. A change naming no path at all (a bare
`cd`, `cd -`) is likewise the shell's to judge, since whether it worked is not
something the target can be checked for.

The notice is set on the pane *after* the re-lists the end of a command triggers,
not before: a `refresh` clears a stale `state.error` on its way through, and the
re-list is asynchronous, so setting the notice first would let that clear land
after it and wipe the message. `refreshPanelsAtShellCwd` was made to hand back
the promises it starts for exactly this ordering.

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

### The cursor follows its entry, and otherwise the row before it

A re-list keeps the cursor where it was by matching the entry's path, so an
unrelated change — a file appearing in the folder — does not move it. When that
entry is *gone* (deleted by another program, by a command at the prompt, by the
other pane's `F8`, or by this pane's own), the cursor settles on the row closest
**before** where it was rather than falling to the top of the listing: the nearest
surviving predecessor in the order the user was looking at, falling forward only
when nothing before it remains. `resolveAnchor` in `refresh` is the one place this
rule lives, so `F8` carries no cursor logic of its own — the rows it deleted are
simply absent from the listing the re-list reads back. Both listings that walk
hands in are the *visible* ones (`filteredRows`), so a filter is respected: an
active query cannot strand the cursor on a row it is hiding. `focusPath` still
wins where the caller knows where the entry went — an in-place rename, a
same-directory move, a fresh folder.

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
an `overflow: hidden` box, and **the window's height is animated with it**: the
window is a `0fr → 1fr` grid row, so the listing below is pushed down by the same
motion the message arrives with rather than being shoved down the instant the notice
mounts and then waiting for the text to catch up. The message's own box travels
inside that window too, so the text comes down from behind the path bar instead of
over it, and room opening and message descending read as one gesture. (The inner
carries `min-height: 0`, without which a grid item's automatic minimum refuses to
shrink past its content and the row could never close.)

The travel being the *message's* alone was the earlier choice, and the reason it was
taken — the room animating would move the rows under a cursor sitting behind the
motion — is answered by animating the room instead of ignoring it: the rows below
translate as one block, cursor row included, so nothing about their order or the
cursor's place in it changes; a row is moved, not re-sorted, and the push-down reads
as the notice making room rather than the list jumping. `onListResize` still only
reveals the cursor for a footer change, so the notice's own resize does not scroll
the view. The message is keyed by its text, so a new one replaces the old through
the animation (out-in: the old ascends, the next descends) while a repeat of an
identical one is the same notice still standing and does not re-announce itself.

### The columns sort, and can be rearranged

Each header is its column's switch. Clicking one orders the listing by that
column; a column not in use becomes the sort ascending, and the column already in
use flips (ascending → descending → ascending), so one header walks both
directions with no third state. The direction is drawn beside the name it belongs
to — a downward arrow for ascending, an upward one for descending — and only on
the column in use, so an unsorted header claims nothing about an order it is not
part of.

The order lives in the pane (`sortKey` / `sortDir` in `useDirectory`), not in
`FilePanel`, so it survives the view being remounted on a tab switch and stays
with the directory it was chosen in rather than resetting on navigation. Folders
keep their place in front whatever the column — a directory is not a row among
files, it is where they live — and within each group the chosen column decides,
in the chosen direction. The name is the tie-break, always ascending: entries the
column cannot tell apart (two files of one size) keep a stable, alphabetical
order rather than whatever order the read happened to return. When the column
*is* the name, that tie-break is the comparison itself, so the default is exactly
the old folders-then-name order. The `..` row is prepended rather than sorted in,
so no column — a size, a time — can move the way up out of first place.

The columns can also be dragged into another order. `columnOrder` in the pane is
the single source both the header and the rows' cells read, so a dropped header
can never put a column in one and not the other; the name column carries the
row's icon, its name and its symlink target, so all of it travels together. The
gesture chooses a *gap*, not a column: while dragging, an insertion point is
drawn between the two headers the column would land between — a white line down
the header to its bottom edge, and, as the line's own elongation upward, a
downward triangle that overshoots the header's top and hangs over the pane title
above. The triangle is what makes the marker unmistakable as a place to drop; it
is one element at the header's own level rather than a copy per column, because
only the header's box can hold something that overshoots its top — read from which
column's midpoint the pointer has passed (measuring the
columns rather than the gap under the pointer keeps a fast drag honest, since the
pointer may be over no column at all between two of them). The gaps on either
side of the dragged column itself are not offered, because dropping there would
move nothing. A drop inserts at that gap; `moveColumn` takes a gap index in the
order as it stands before the move and corrects it for the column being lifted
out, so a gap to the right closes up by one.

A header is both sortable and draggable, and a browser may still deliver a click
after a drag, so a drop is told from a click by the time the drag ended
(`columnDragEndedAt`) and never sorts as well. The image the drag carries is
built rather than borrowed: a header is a transparent button, so the browser's
own image is bare text, and `setDragImage` is handed an offscreen clone painted
as a chip — the same label on a solid background, the way the column reads in the
bar — so what is being dragged stays legible over whatever it passes. A click or
a drag leaves DOM focus on the button, where typing would go nowhere; the header
gives it back once the gesture is over, and the app's own focus model re-claims
it for the command line. Dragging cannot `preventDefault` its `mousedown` — that
would cancel the drag — so this is done on the way out rather than on the way in.

### The columns can also be built, not only rearranged

Dragging moves the columns a pane starts with; it cannot add one, drop one, or
change what one shows. That is what the column editor is for, and it is a mode of
the *pane* (`columnEdit` in `useDirectory`) rather than of the app, because the
columns it edits are the pane's own: the icon that opens it is pinned to the right
edge of the header and appears on hover, and `Alt+E` toggles the active pane's
mode from the keyboard. `Escape` leaves it, ahead of the background work it would
otherwise take back, because it is the visible state the key just made.

The icon is pinned rather than left in the columns' row on purpose. A pane's
header keeps the gutter the rows keep for the scrollbar (`pane-header-gutter`), so
a control in the flow past the last column would reserve its own width *inside*
that row and push the columns out of line with the rows below — a header that no
longer meets its own cells, and dead space at the right. Absolutely positioned, it
lives in the gutter instead: the columns line up, and the ordinary header is
nothing but the columns whether or not the icon is showing.

While the mode is on, each column becomes one *capsule*: the grip, the picker of
the column's type — the `<select>` carries the label the header drew as static
text, so a column is read and changed in the same place — and the remove button,
closed inside a single bordered, rounded control with hairline dividers between the
three. Grouping them is what makes a column read as one thing: left loose, they
were three controls plus the add buttons, with nothing to say which belonged to
which. The add button stays *outside* the capsule, in every gap, before each column
and after the last, so adding is visibly a move on the gap rather than on the
column. The grip is the drag: a reader header is one whole button and can be
grabbed anywhere, but an editor holds a picker and buttons, and a drag started on
the picker would make the picker unopenable. The grip makes the editor's drag a
gesture of its own, and the *column's wrapper* is what carries `data-column`, so
the gap a drop lands in is still read from the columns — the shared
`onHeaderDragOver` / `moveColumn` need nothing changed for the mode, and a column
can be re-ordered while it is being built. The name column is the one column that
is never dropped (its remove button is disabled): a listing without the entry's
own name is not a listing.

Both the rest of the gestures come from one model: a column *is* its type, and the
types are unique among the columns, so the picker greys out a type another column
already shows, and an add inserts the first type not already on screen and opens
its picker (`showPicker` on the next tick — the add is a real click, so the user
activation is still there). That uniqueness is also why `columnOrder` can go on
being a plain list of `SortKey`s: with no duplicates there is exactly one answer
per column, and the keyed `v-for` works unchanged. Adding a column does not touch
the sort; changing a column's type hands it the sort when the column was the
sorted one, and dropping that column falls the sort back to the first one left,
ascending — the direction belonged to the column that left, not to the place it
held.

The editor's controls are the header's chrome, so they hand the keyboard back the
way the headers do (`releaseHeaderFocus`). The picker stops its own `mousedown`
from reaching the pane, though: the pane's handler runs `focusPanes`, whose
command-line focus would steal the event before the native dropdown could open,
and the whole point of the picker is the list it puts on screen. An editor is
sized by its own controls (`editorClass`) rather than to the cells below it, since
a grip, a picker and a button need room a `w-16` cell does not have — the rows'
cells keep their widths throughout, so the listing itself never moves while the
columns are being edited.

The mode is the keyboard's as much as the mouse's, and that is what the pane's
`columnFocus` is for: it is the column the keys act on, drawn as a highlighted
capsule so the keys and the eye agree. Commands and navigation share the keys the
listing already uses — arrows to move, Home/End to the ends — which is why they
are claimed in App.vue's pane handler only while `columnEdit` is on: with the mode
off the arrows still seek the clip and move the cursor. `Enter` opens the focused
column's picker (the pane's own `openColumnPicker`, since only it holds the
`<select>` and the user activation to call `showPicker`), `Insert` adds a column
after the focused one and opens it, `Delete` drops the focused one (never the
name), and Alt+Left/Right re-order it in whole steps from its own index, so the
focus follows the column and the next press moves it again from where it now is.
A click on a capsule puts the same focus there, so the pointer is just another way
of saying which column is "this one"; a search box, whose input owns the caret,
keeps its keys.

## View modes

### A pane's rows can be a wall of thumbnails

The detail listing answers "what is in this folder" with names, sizes and dates,
which is the right answer for code, archives and text. For a folder of pictures,
clips, pages and models it is the wrong one: there the file *is* its picture, and
a name says almost nothing about it. So a pane has a view mode — `details` or
`thumbnails`, cycled by `Alt+T` — and the wall draws the same rows each as a tile,
from the entry's own thumbnail where one can be read and from its type icon where
none can.

It is a property of the pane, like its sort and its columns, and it is the *same
rows*: `state.entries`, with the same cursor, marks, filter, order and watcher.
That is the whole design — nothing about the cursor moves, the transfers, the
search or the row menu changes with the mode, because the mode changes only how
the rows are drawn. The listing's fixed row height is the one thing that cannot
carry over: a wall is a variable number of cells across, so `ThumbnailGrid` does
its own windowing, page arithmetic and scroll-into-view on a cell pitch, and the
pane's `cellsPerRow` (measured by the view) is what lets `App.vue` move the cursor
a whole row on the up and down arrows. In the wall the left and right arrows move
a cell rather than seeking the previewed clip, because a horizontal arrow that
could not reach the cell beside it would be the one key the grid could not answer.
The header — and so the column editor, the header sort and the drag — belongs to
the detail listing and is hidden with the wall; `Alt+E` in the wall brings the
listing back, because where the editor is, the columns are.

The mode deliberately does not persist: it is per pane, per session, like the
sort. A remembered default is a small addition if it is wanted.

The tiles can be sized, `Ctrl+=` and `Ctrl+-` walking a ladder of factors
(`THUMB_SCALE_STEPS` in `shared/viewMode.ts`) with `Ctrl+0` back to the middle
rung. It is a *step* rather than a free scale, as a PDF display's magnifications
are, and the rung is the pane's own state (`thumbStep`); the grid reads it and
animates its own `scale` toward it, a frame at a time, re-measuring as it goes —
so the columns that fit and the pitch the rows are placed at follow the size, and
the cursor's tile is revealed each frame so whatever is being looked at stays put.
Nothing has to tell the model wall: it measures each tile's box every frame, so
the turning models grow and shrink inside the boxes they are drawn in. That is
also why the zoom is not a view morph like the mode switch: a morph shows
snapshots, which would freeze the models where they stood while the boxes grew
around them.

A switch between the modes is a *morph*. Each visible entry carries a
`view-transition-name` in both layouts (`entryName` in `FilePanel.vue`, assigned
rather than derived — the names must be unique in the document, so they are
numbered per pane and prefixed with its side), and `withViewTransition`
(`lib/viewTransition.ts`) runs the state change inside the View Transitions API's
`startViewTransition`: the browser snapshots the page before and after and flies
every named entry from the box it had as a row to the box it has as a tile —
moving and resizing it — while the unnamed chrome cross-fades underneath. The
callback awaits a tick *inside* itself, because the "after" snapshot has to be of
the layout Vue has built by then. Two consequences of the same timing: the grid
measures itself synchronously on mount (a wall still laid out at one column would
be captured, and flown to, at the wrong shape), and the hide mode's row copies
drop the name (`lib/hideAnimation.ts`) so a copy and its live row cannot share one
and have the transition skipped.

The flight is also why the panes hold their expensive work back while it runs
(`morphing` in `lib/viewTransition.ts`). The content is not on screen for those
frames — a view transition shows snapshots — so a thumbnail decoded or a model
parsed into a fresh WebGL context is work on something nobody can see, on the same
main thread the flight needs to stay smooth. The grid defers its reads and the
model wall defers taking its context and parsing until `morphing` is false again,
so the wall appears once the entries have settled into their places rather than
competing with the animation. The same holds on the way out: a mode morph unmounts
the wall at the very start of its flight — the leave animation — so giving the
context back and disposing every geometry is held until the flight lands too. Work
already in flight when the switch began (a tile read that lands, a file about to
be parsed) waits on `whenNotMorphing()` rather than running in the flight's frames.

Leaving the wall has one more cost, and a visible one. Its canvas is not inside any
named tile — it lies *over* them — so a live one is both copied whole into the
morph and left behind in the root snapshot: the models float in place while the
named boxes fly out from under them. So the pane hides the canvas before the old
state is captured (`ThumbnailGrid.hideModels`, called from `FilePanel.toggleView`)
and the tiles travel as the boxes they are. Nothing has to be shown again, the pane
being on its way out of the wall.

Where an engine has no view transition, the switch falls back to the entries
rising in a step behind one another (`styles/view.css`, the `VIEW_ENTER_*` numbers
both the pane and the grid read from `shared/viewMode.ts`), gated by a flag the
pane raises for the length of the gesture so a row the viewport reveals later, by
a scroll or a resize, is simply there. A model tile is animated like any other;
its model is drawn by the wall's canvas once it has loaded, and the canvas is part
of the snapshot for the length of the flight.

A tile carries the row's git dot as well: the mark a row shows is a property of
the entry and the status, not of how the row is drawn, so `rowMarkFor` and
`dotStyle` moved to `lib/gitMark.ts` and both the listing and the wall read them
from there — one reader, one dot, whichever way the row is laid out. In the wall
the dot sits in the picture box's bottom-right corner, over the model wall's
canvas: a model is framed inside a sphere with margin (`buildModel`), so its
silhouette never reaches the corner, and the canvas is transparent there — the dot
reads whether the tile is a picture, a type icon or a turning model.

A tile's picture is read from main, not the renderer — a file has no URL — but *as
a tile*, not as the file: the status-bar preview hands a small file over whole,
which is right for one 64px box and ruinous for a wall of sixty, so `fs:thumbnail`
always decodes and shrinks to a fixed longest side (`nativeImage` does the resize,
off the fs thread pool). Images travel this way, PDFs through the same
`fs:pdf-page` the display uses at a tile's width, and a clip as one frame cut by
ffmpeg — gated by the same probe that decides whether the clip is previewable at
all, so no ffmpeg means the clip keeps its icon.

A 3D model is the exception that shaped the rest, and the reason the wall has a
renderer at all. One WebGL context per tile would exhaust what a browser allows in
a single screenful — the limit `ModelViewer` is built around — so `ModelWall`
draws *every* model with one context: a transparent canvas over the grid, into
which each model is painted through a scissor box the size and place of its tile,
so all of them turn at once rather than only the one under the pointer. The
canvas is `pointer-events-none` and only ever paints inside a tile's box, so the
tiles beneath keep their own clicks, hover and tooltips. The models are fetched
(`fs:read-model`, so a CAD document is meshed by main first) and parsed there, in
an async chunk of its own — three.js is loaded only where the folder could hold a
model, never for a folder of pictures. A tile whose model will not read or parse
falls back to its type icon. Only the local machine answers `fs:thumbnail` and
`fs:read-model`: a remote relay has no resize step and no CAD mesher, so a remote
pane draws icons.

In the wall the footer keeps no preview of the cursor's *model* — the tile is the
preview already, and a footer viewer would mount a second WebGL context and read
and parse the file again on every step between two models, which is exactly the
per-step work the wall's own rotation stutters on. What is not lost with it is the
reveal: a display grows out of the cursor's tile rather than the footer's box, so
`Enter` still enlarges the picture *out of the picture* (`ThumbnailGrid.cellRect`,
which `previewRect`/`previewBarRect` reach for in the wall — and the transport
grows out from under the tile the same way).

The tiles are read for the cells the window covers, four at a time, and the list
of what still wants reading is *rebuilt* from the window on every scroll rather
than appended to — so a fast flick down a folder of thousands drops the cells it
has left behind instead of queueing a decode for every one of them. The key is the
file's content (path, size, mtime), so a rewrite is a different tile, and the
renderer's own map is cleared on navigation, with reads that land after it dropped
by an epoch — the same shape the size walks use.

## Quick cd

A quick cd directory is a folder the user has bookmarked, and `Alt+C` puts the
list of them in the pane in place of its own listing. The list is one answer for
the whole app (`quickCdDirs` in `composables/useQuickCd`), like the hide mode:
both panes read it, so a folder added from one pane's menu is there in the other,
and it is remembered across launches in `userData/quick-cd.json`
(`main/quickCd.ts`, `quickcd:get`/`quickcd:set`).

It is a mode of the *pane* (`quickCd` in `useDirectory`) and it swaps the rows
rather than the place: while it is on, `state.allRows`/`entries`/`cursor` describe
the bookmarks, so every existing cursor move, page jump, scroll and row lookup
works on the list unchanged, while `state.path` — the directory behind it, with
its watcher, its title and the shell sync — is left alone. The listing the pane
was showing is kept aside (`browseListing`), so `Escape` gives it back as it was
rather than re-reading it, and Enter on a row simply navigates: `navigateTo` is
what leaves the mode, which is also what keeps a `cd` typed at the prompt from
landing under a list that is no longer the one being shown.

A bookmark is built as an ordinary `PaneEntry` of kind `directory` — its name is
the path with the home directory shown as `~` (`quickCdLabel`), since the path is
what tells two folders of one name apart — so the row machinery needs nothing new
for it. What a bookmark does not have is size, date or mode, so the pane shows only
the name column in this mode and hides the header with the other columns. The
incremental search the listing already carries is opened with the mode — entering
sets `searchActive`, and the same `applyFilter` runs over the bookmarks — so the
list is typed into the moment it appears: the arrows and the page/end keys move
what the filter leaves, Left/Right and the printable keys edit the query, and the
rest are the gestures a list of places can answer — Enter to go, Escape to leave,
Tab, Alt+Up/Alt+Down to move the row, and the menu.

The order is the user's and is never sorted: an add appends, and `reorderQuickCd`
swaps a row with its neighbour. The menu is how the list is edited — on a folder
row it offers `Add to quick cd` (or the pane's own folder from any other row), and
on a row *of the list* it offers `Move up`/`Move down` and `Remove from quick cd`
— and an empty list is not a blank pane: the notice says so, because where the
folders to put there come from is not something the pane otherwise makes visible.

The mode's switch is offered by pointer as well as by `Alt+C`: a star button in the
pane *title bar* rather than in the header, because the header is hidden with the
listing the mode replaces, so a control there would vanish exactly when "leave" is
needed, while the title bar stays and is where a mode's state already lives (the
hide eye, the git chip). It is a state as much as a switch — a filled star for the
mode on, an outline one for off — and it keeps the title's own color rather than
the gold a mark takes, so nothing up there competes with a selection further down.
Building the list stays the row menu's, which the button does not duplicate: putting
a folder on the list is a decision about that folder, not a mode to switch.

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
because it cannot be spelled in this format at all. The mode is switched *on* with
the write, since the file only says what to leave out and the mode is what leaves
it out: a name written into a list nothing is applying would look like the item had
done nothing.

Its other half is `fs:hide-remove` — the menu's `Remove from .mchide`, offered for
a row the folder *does* list. Such a row is on screen only while the mode is off
(the title bar's dim icon is what says so), and that is exactly where the gesture
is wanted: the mode is what made the item disappear, so taking the name off the
list is how the user says it should not have. It drops only the lines that spell
the name and rewrites the rest of the file as it was read, so a hand-written list
keeps its blank lines, its comments and the order it was given; a name the file
does not list leaves the file untouched rather than rewriting what is already
right, and the file is never created, since a name taken out of a list that does
not exist has already been taken out. The mode is left exactly as it is: it is off,
and switching it on over a name that has just stopped being covered would hide
every *other* covered row instead of leaving the user where they were. Nothing on
screen changes either way — the row was visible before and after — so the gesture's
answer is the menu itself, which offers the add again, and the title bar's eye,
which goes with the last name of the list.

Both gestures re-list the folder, with every pane showing it told the change is the
app's own before the listing is re-read, so the row that was asked about does not
sweep as though something had happened behind the app's back; the names come from
the listing rather than from a read of the file, which is why the folder is listed
again at all. The file is filtered like any other entry — naming itself
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

### A row the mode covers leaves by collapsing where it stood

Alt+. flipping the mode, or a name written into a `.mchide` and picked up by a
refresh, changes which rows are in the listing — and a row that blinks out of a
list reads as a glitch while one that leaves reads as a decision. So the rows the
mode has covered are squeezed out where they stood, fading as they go, and
everything below them closes the gap by sliding up; a row the mode has uncovered
slides back down into the room it opens, and the rows below it slide down too.
The work is `lib/hideAnimation.ts` and `styles/hide.css`.

What makes it cheap is that a row's geometry is known without measuring:
the listing is windowed and every row is placed at `index * ROW_HEIGHT`, so how
far a surviving row travels is just the difference between the index it had and
the index it now has. The animation lets the new layout stand and nudges the live
rows with a `translateY` from their old place to the new one, so nothing is
measured and nothing else in the pane moves. The rows that have been covered,
though, are already out of the document by the time the new layout is there — so
the view copies them out first. That is why the animating lives in FilePanel
(`watch` on `state.entries`, pre-flush) and only the moving lives in the module:
the copies have to be taken while the rows are still standing, and the moving has
to wait a tick for the new arrangement to exist to move within. The copies are
appended to the `<ul>` itself as `.hide-ghost` — absolutely positioned, out of the
flow and off the pointer, painted over the rows sliding up under them — which is
why the scroller carries `relative` it did not need before.

Only a change the mode makes animates. `state.hideTick` is the signal: a count
`useDirectory` bumps when the mode is toggled and when a refresh finds the folder's
hidden-name set actually different, and FilePanel compares it to the tick its last
rows were drawn for. Everything else that changes the listing — a navigation, a
sort, a search, an ordinary refresh — leaves the tick alone, so those rows appear
and disappear the way they always have (the refresh's own `flash-row` sweep, for
the ones it found). The copy is a picture of the row as it stood, so it can still
carry the mark or the cursor band the mode has just taken away; that is what the
row looked like a moment ago, and it is gone again when the copy is.

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

### A mark is spent by the operation it asked for

Once F5 or F6 has acted on the marks, the pane clears them: a mark is the promise
about what the *next* transfer acts on, not a record of what the last one did, so
rows left gold after a copy read as though the copy were still pending. A move
drops them anyway — the entries leave the directory, and `refresh` prunes whatever
the new listing does not hold — but a copy leaves its sources exactly where they
were, so `copyEntries` has to apply the same rule by hand. It does it per target
rather than as one `clearSelection`, leaving a source that *failed* still marked so
a retry after a collision still knows what the user meant. That is the same rule
delete already follows, whose removed rows take their marks with them while the
failures keep theirs; only copy had nothing to prune it, because only copy leaves
the entries behind.

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
the transfers, Rename, Delete, the mark, and the two hide-list items (`Hide (add to
.mchide)` and `Remove from .mchide`, written up with the file they write — see the
hide mode above). Each item carries the key that does the same thing without a menu,
since being where those are found is half of what the menu is for, and the
separators are put *between* the groups that came out with something in them rather
than written into the list: what a row can offer depends on what it is — a folder
has no view, edit or full-screen — and a divider with nothing on one side of it is
a line the menu has nothing to say.

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

### `Space` on a folder walks it, and the row says how much is in there

A listing can answer a file's size from its own metadata and cannot answer a
folder's at all: what a folder holds is the whole tree under it, which is a walk
rather than a stat. So the size column stays blank for a folder until the user
asks — `Space` on the row — and `fs:dir-size` answers with the total in bytes
(`directorySize` in `main/ipc/fs.ts`). The walk is deliberately *not* a `du`
clone: it never follows a symlink, because a link back up its own tree would make
it endless and because the question is about the folder itself, so a link is
counted as the link it is, exactly as `du` counts one. An entry it cannot read is
skipped rather than failing the answer, so a folder with one protected
subdirectory still reports the rest.

The answer is kept by path in the pane (`state.dirSizes`), not written back into
the entry: a `DirEntry` is the listing's own metadata and a walk is a separate
question with a separate lifetime. It is asked in the background and the cursor
steps to the next row immediately — the gesture is "size this one and move on",
so holding `Space` walks a column of folders while the rows fill in behind the
cursor. The `..` row is that gesture's widest form: `Space` there starts a walk
for every folder in the listing and leaves the cursor alone, because the row is
not a way down into anything and there is no "next" it could mean. The rows then
fill in independently, each with its own bar if its own walk outlasts the delay.
The row does not sit at `…` until the end: main sends the running total
back as `fs:dir-size-progress`, throttled to one report per hundred milliseconds
so a tree of hundreds of thousands of files costs messages in the tens rather
than one per file, and the pane writes each report into the same map the final
answer lands in. So the number counts up while subdirectories are being
traversed, and `…` is only what a walk shows before its first file is counted.
Report carries the folder's path, and the pane takes only those for folders it is
still sizing — that is what keeps another pane's walk, or one for a folder this
pane has already left, out of its rows. A size belongs to the listing it was
asked from: `navigateTo` clears the map and bumps a run counter, so a walk
started for the folder the pane just left cannot land in the new listing's rows,
exactly as marks and the filter do not cross directories. `refresh` leaves the
map alone — a write in the pane's own directory says nothing about the contents
of a folder below it.

A walked total is what the size column *sorts* by as well. `sizeFor` in
`useDirectory` reads `state.dirSizes` for a folder and falls back to the entry's
own metadata size for one that was never asked about, so a size sort orders a
folder by the number its row actually shows. The fallback is the point of the
whole thing: the blank is "not asked", not zero, and ordering an unasked folder as
an empty file would be a claim the column never made — so an unsized folder keeps
the place its metadata earns, and a walk is what moves it.

And the order keeps up with the walk while it runs. A size sort is re-run as the
running totals land, not only when the walk ends, because watching a folder's
total climb while the listing holds its old place is the one thing a live total
makes look wrong. It is debounced for quiescence and capped periodically
(`SIZE_SORT_DEBOUNCE_MS` / `SIZE_SORT_MAX_MS`): a burst of reports re-schedules the
run to a short wait after the last, but a stream that never quiets still fires
about every `SIZE_SORT_MAX_MS`, so a walk of hundreds of thousands of files
re-orders as it goes rather than once at its end. Each re-order keeps the cursor on
the entry it was on (`applyFilter`), so the rows move around the cursor instead of
under it, and the one-pass `Space` gesture survives the reordering it causes.

The work is shaped for the fs thread pool, not for fan-out. A walk keeps a batch
of `SIZE_STAT_BATCH` (12) `lstat`s in flight per directory, so a folder's stats
are not a chain of one-syscall waits; that is what actually reduces wall time,
because a stat is mostly latency. Fanning out every folder at once would add no
parallelism past the pool's four threads — it would only queue, multiply the
per-walk `readdir` arrays and progress messages, scatter a mechanical disk's
seeks across many trees, and make every row crawl instead of finishing in order.
So the pane allows `SIZE_WALK_LIMIT` (2) walks at a time and queues the rest
(`queueSizeWalk` in `useDirectory.ts`): two walks with a batch each already keep
the pool full, the rows fill in the order they were asked, and a queued folder is
marked `sizing` from the ask (so Space cannot ask twice) while its bar's timer
starts only when its slot is reached — a wait in a queue is not progress. A folder
that already had a total keeps showing it while it waits, but dimmed
(`sizeStale`): the number is the previous answer, not this walk's, and the dim is
what says so until the walk starts and the running total takes the column. That is
the difference between "this is what I found before" and "this is what I am
finding now", drawn in the one place both would otherwise look identical.

Escape takes the walks back, because they are the only thing the app still does
in the background. `stopAllSizeWalks` drops the queue by bumping a shared epoch,
tells main with `fs:dir-size-cancel` (a flag per walk, checked between stat
batches — a `readdir` already in flight cannot be un-read), and calls each pane's
`stopSizing`. Each pane bumps its own run so an answer still on its way is
ignored, clears `sizing`/`sizeSlow`, and restores the size the row showed before
the walk started (`sizePrior`), or blanks it if it had none: a partial sum that
stops with Escape must not be left looking like the folder's total. The gesture is
global on purpose — walks belong to panes of workspaces that may not even be on
screen, and one Escape meaning "stop that" is simpler than a per-pane rule nobody
can see.

A long walk says it is still going with a bar, because a walk is indeterminate:
the total is precisely what is not known yet. It is a 2px bar sliding along the
bottom edge of the size cell (`styles/size.css`), clipped to the cell, so it
never widens the cell and no part of it ever shows beside it — the number keeps
its place and the date column does not move, the same promise the git dot makes.
The bar is not shown from the first moment: it appears only once a walk has run
for about a third of a second (`SIZE_BAR_DELAY_MS`), because a folder of a few
files is walked faster than the eye catches and a bar that blinked for it would
say nothing useful. So the rule is: a quick walk shows only its answer, and only a
walk long enough to wonder about earns the bar. The bar's own `sizeSlow` set is
separate from `sizing` — the walk itself — so the delay is a display matter and
not a second guess at when the walk started.

`Space` reaches this only after the clip call has declined: a display or a footer
preview under the cursor keeps `Space` as play/pause, and a file, an empty folder
or a listing with no folder in it leaves it to the shell, so no key that already
meant something lost it.

### The size column reads as a heat, above a megabyte

The number in the size column is drawn in a colour read from the number itself
(`sizeColor` in `lib/format.ts`): plain `text-fg` up to a megabyte, then a ramp
from amber through orange to red as the size grows toward a terabyte. It answers
the question a file manager is asked most — *what is taking up the room* — with
the eye's own scan down the column instead of a sort. The ramp is over the
*logarithm* of the size, not the size, because files span orders of magnitude and
every doubling of a big file should move the colour the same distance; a linear
ramp would leave everything below a gigabyte indistinguishable and spend its whole
range on the handful of files above it. It is a colour chosen per entry rather
than a class, for the same reason `lib/gitMark.ts` keeps its palette in code.

The floor is deliberate: a listing's ordinary rows are small files, and colouring
all of them would make the column noisy while saying nothing, so the heat is
reserved for what is worth spotting at a glance. A folder's column is walked, not
known, so it takes the heat only once a total exists — and while a recalculation
is still queued the row keeps the plain dim (`sizeStale`), so an old answer is
never dressed as a fresh one. The footer's own size, under the cursor, is the same
number and takes the same colour. The colour rides an inline `color` on the size
span, so it goes on reading as itself on a marked or cursored row's band, the same
promise the runnable green makes.

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

### PDFs

A PDF is a document rather than a picture, and the one thing a pane shows of it is
a *page* — so a PDF is rendered a page at a time and then behaves like any other
media file: `Enter` hands it to the display, `Ctrl+Enter` fills the window, `Esc`
leaves, and the transport under the picture says where in it the box is. Chromium
can display a PDF through its built-in viewer, and that would be less code; it is
turned down for three reasons. The viewer is a plugin, and the renderer's CSP
forbids `<object>`/`<embed>` outright (`object-src 'none'`). It is a full chrome of
its own, a toolbar and a scrollbar rather than a picture the panes' reveal, blur
and full-screen could drive. And most of all it would not be *media*: the cursor in
the pane that asked keeps the keyboard, while the document is in the other pane, so
the page has to be something the app turns — not a plugin that turns it for itself
when it happens to be focused.

So main rasterizes a page at a time and the renderer stacks them into a document.
`src/main/pdf.ts` runs poppler's `pdftocairo` (`MC_PDFTOCAIRO`) with `-f`/`-l` at the
page asked for and `-scale-to-x` at the width the box needs, writing one PNG to
standard output (`-` with `-singlefile`) so no temporary file ever touches the disk;
`pdfinfo` (`MC_PDFINFO`) answers the page count and every page's shape, with each
page's rotation folded in so a ratio is the orientation the page is drawn in. Both
are probed once — a missing poppler means a PDF is not media at all, and `Enter`
opens it with the system's own viewer — and both are cached in main by the file's
size and mtime as well as the page and the width, so scrolling back over a document
is a lookup rather than a render. The footer asks for a page 320px wide to make its
thumbnail; a display lays the pages out from the header's shapes — stacked
vertically at the pane's width — and renders the page or two near its viewport (at
`devicePixelRatio`, capped at 2400), windowed like the listing, so a thousand-page
document is never all in the DOM or on the bridge at once. That is the same trade
the image reader makes when it hands a small file over whole and downscales a large
one: a page is rasterized at the size it will sit in.

A display is where a PDF is *read*, so it is a scroll box rather than a fitted
picture: the wheel scrolls the stack natively, the pages flow into one another as a
document's do, and the transport and the arrows turn a page by scrolling to it
rather than swapping a raster. The page in view — the last page whose top has
reached the top of the box — is what the footer's counter and the transport's thumb
read. That answer is shared state (`lib/pdf.ts`), not something a pane hands to a
display, and it is the one place a PDF is deliberately unlike a clip. A clip is
handed across because it can only play in one element at a time — decoding it twice
to draw the same thing is the cost the hand-off exists to avoid — and because its
position is something the *element* knows. A page has neither property: rendering it
twice is two cached lookups, and its position is the app's own number, not the
element's clock. So `lib/pdf.ts` keeps one page per file, keyed by the same identity
a preview is, and the footer's thumbnail and the display both read it; a scroll in
the display moves the same answer, and a display being dismissed finds the footer
already on the page that was last in view. A PDF claims no `Space`: it has no
playhead to pause, so the key falls through to the folder walk or the shell as it
would on a still image.

How the document is *sized* in that box is a choice, because a page and a pane
rarely agree on an aspect: filling the box's width makes the text as large as the
pane allows and leaves the page to be scrolled, while fitting the whole page in the
box shrinks it until its height — not just its width — is in view, which is what a
page of layout is read at. So the transport carries both, a button at its right end
for each and `Alt+W`/`Alt+P` with them, and a *magnification* beside them: `-`/`+`
stepping a fixed ladder (`shared/pdf.ts`), the step's percentage shown between them
and `Alt+=`/`Alt+-` as its keys.

The percentage's reference point is the **box's own width**, not the page's size in
inches: that is the thing on screen a reader can point at, and it is what makes
fitting the width *exactly* 100% — the fit-width button says so in its tooltip. So a
fit-page percentage is simply how much of the width a page takes when its height is
what was fitted, and anything above 100% is a page wider than the box, which then
scrolls sideways (`overflow-x` is `auto`). It is a deliberate choice over the
absolute reference a reader might bring from Acrobat, where 100% is the page at its
own size: a CSS pixel is not a fixed physical length, so that 100% is only as real
as the display's scale factor, while the box's width is exactly what is on screen —
and the label's own tooltip states it, so the number never has to be guessed at.

The fit and the magnification are one state rather than two (`pdfView.mode` and
`pdfView.scale`): they are two answers to the same question, and having both would
leave a stale magnification waiting behind a fit. `+`/`-` step from the percentage
that is *shown* — a page fitted at 80% steps to 100%, not to 80% of a rung — and so
leave the fit behind for a magnification of the box's own width, which is the same
fraction however the pane is resized. A fitted page, by contrast, is a rule rather
than a number: resizing the pane refits it and the percentage follows.

That sizing is one remembered answer for the whole app (`userData/pdf-view.json`),
as the hide mode is: it is a reader's preference rather than a property of a file, so
a second document opens the way the first was left rather than making the reader say
it again. Fit-page is worked out from the *first* page's aspect — the layout is
stacked at one column width, so a per-page width would reflow the whole document as
it scrolled — which is what makes it stable on a mixed document, the taller pages
simply scrolling. Fit-page also measures the box's *border-box* height rather than
its content height: a magnified page wider than the box raises a horizontal
scrollbar, and dividing by a height that scrollbar had just taken would make the two
chase each other as the page grew and shrank.

A rasterized page carries no text of its own, so selecting from one needs a second
layer over it: what is *seen* is the picture, and what is *selected* is an
invisible copy of the page's words laid on top. Main gets them from poppler's
`pdftotext -bbox-layout`, which writes each word's box in the page's own points
with the origin at its top-left — the coordinate space a text layer is drawn in —
and `fs:pdf-text` answers one page at a time, cached and fetched alongside the raster
as the page comes into view. The pane puts each word in a transparent `span` at its
box, scaled by the one factor that maps the page's width to the width it is drawn
at, so a zoom keeps the selection on the glyphs without asking for the text again.
The spans are clipped to their boxes and the font is not the PDF's own, so a word
the substitute draws wider is trimmed rather than spilled; what matters is that a
drag over a line selects the words under it, and that the copied text is exact
whatever the font draws.

**The highlight is the pane's, not the browser's.** None of that span geometry is
seen — the spans are transparent — but the browser's selection highlight *is* drawn
from it, and its idea of a word is the substitute font's: a band as tall as that
font's line box (about a sixth taller than the ink it covers, and sitting low) and
as wide as that font drew the word, which is neither the word's own width nor
anything the page shows. The selection looked, in short, like a rendering of the
text rather than a highlight *of* it — the glyphs it was supposed to be pointing at
were the raster's, a few pixels away. So the native highlight is turned off
(`[data-pdf-text] ::selection` is transparent, `styles/pdf.css`) and the pane draws
it instead (`pdfHighlightRects`): one translucent band per *run* of selected words on
a line, from the first word's left edge to the last one's right, at the line's own
band rather than a word's ink — a word's box is its ink, which is shorter for a word
with no descender in it, and a band that changed height word by word would read as a
fault. Which words are selected is read from the selection's own endpoints and their
offsets (the selection is what a drag, a triple-click and the paragraph drag all
leave behind, and `Ctrl+C` copies), so the drawn highlight and the copied text can
never disagree. What the selection *is* is unchanged; only what it looks like moved. The space between words is *in the markup as an
expression* (`word.text + ' '`) rather than as template text: Vue's template
whitespace condensing drops a trailing space written after an interpolation and
before the close tag, which would run every word of the copy together — the one
thing a text layer exists to avoid. `white-space: pre` is what then keeps that
space through the browser's own selection serialization, which otherwise drops a
line's trailing spaces.

The copy is the app's, not the browser's. A selection here lives inside a
`select-none` document, and the browser's own copy is a default action the app
cannot see the result of; doing it explicitly — `Ctrl+C` reads the selection's text
and puts it on the clipboard — is what makes it certain that the *text* is copied
rather than the row's name. The read is also *remembered as it is made*
(`selectionchange` keeps the last PDF selection's text, dropped when a press lands
outside a text layer, when a key is handed to the shell, and when the display is
left or moves to another file), because two things can take the live selection away
before the key arrives: a focus change — any focus change folds a document selection
away, which is the whole reason the focus model has to stand down here — and the
display being *reloaded*, which the panes used to cause on every re-list, since
`previewTargetFor` builds a fresh target object each time and the stage watcher
treated a new object as a new thing to show. The second is fixed at its source: a
request naming the same media (same kind, same `encode`, same
`previewKeyFor` — `sameMedia`) is the same display, so the pages are not torn down
and rebuilt under the reader's selection. (`pdfSelection` is the scoped read: a
non-collapsed document selection that is not the terminal's own, which xterm's DOM
renderer mirrors into the document selection; the terminal is excluded rather than
the text layer required, so a selection whose spans were re-rendered under it is
still recognised.) The panes' own copy therefore stands aside for the selection, and a
PDF display gives up its double-click-to-enlarge for the same reason — a
double-click on a page is a word selection, as it is in any text. A word span is a
block of its own, which makes the browser's idea of a paragraph one word, so the
paragraph is drawn from poppler instead: the `<block>` each word sits in is kept
with it, and a triple-click selects that whole block as one range — the browser's
own third-press selection being called off, since the only thing it would add is
the word again. The button that made it can then be *held and dragged*, and the
selection grows a paragraph at a time, which is the gesture a triple-click promises
and the browser cannot give once its own paragraph is a word: the drag
(`paragraphDrag`) keeps the paragraph it began on and adds whole blocks toward the
pointer, the word nearest it — worked out from the word boxes, since the gaps
between the boxes are the layer's background and hit-testing them would name
nothing — telling it which end grows, and the pages' own order telling it which way
is forward.

The app's focus model needs the same care, and it
is the subtle half: a pane normally keeps the command line focused by listening for
a focus drop and putting the keyboard back, and *putting it back is a focus change
that folds the document selection away* — which is exactly what made a word flash
into highlight and vanish. So the scroll box is focusable (`tabindex="-1"`) and a
press inside it leaves the keyboard there rather than dropping it to `<body>`, and
`restoreFocus` stands down while a drag is in flight (`selectingText`, a window-wide
pointerdown/up watch) or a selection stands. Typing is not interrupted by any of it:
a key the panes did not claim, with the keyboard on the document, is handed back to
the command line. `TerminalPane.forwardKey` re-dispatches it to xterm — a synthetic
key is enough, since xterm's listener is an ordinary one on its textarea and the
fields it reads (`keyCode` among them) are set by the `KeyboardEvent` constructor
the way a real key sets them — so readline's keys, Backspace and Enter arrive
exactly as if typed there, and the keyboard moves to the command line with them. A
bare modifier or lock key is the exception (`MODIFIER_KEYS`): xterm sends nothing
for one, and taking the keyboard for it would be pure harm — a `Ctrl` pressed on
the way to `Ctrl+C` is the *first half of the copy gesture*, and focusing the
command line with it folds away the selection the copy is about, which is exactly
how a selection came to vanish the instant a reader reached for the copy key. A
copy with a selection up never reaches that path: it is claimed earlier and its text
is put on the clipboard. (The synthetic event would also reach the app's own capture
listener, which is why a `forwardingToShell` guard sits at the top of it.)

A page is only offered where main can render it, which is the local filesystem: the
stream a remote target would need is the relay's business, so as with a clip a PDF
on a remote is left to the system. It is left out of an archive for the same reason,
and the page-count read is left out of one too — there is no real path for poppler to
open either way.

### Models

A 3D file is shown as *media* like any other — it previews in the footer, `Enter`
hands it to the display, `Ctrl+Enter` fills the window — but it is two quite
different things behind that one shape, and the split is what keeps the app honest
about its dependencies.

A **mesh** format (STL, 3MF, OBJ, PLY, glTF) *is* its triangles, so nothing external
is needed: main reads the bytes (`fs:read-model`) and the renderer parses them itself
through three.js (`lib/model.ts`). No system tool, no scheme, no CSP change — the
library is pure JavaScript, and Vite bundles it into the renderer on demand: the
viewer is an async component, so three and its loaders sit in their own chunk and
are fetched when a row really is a model, exactly as Monaco is kept out of the main
chunk. A **CAD** document
(STEP, IGES, FreeCAD's own `.fcstd`) is a boundary representation, and no mesh loader
can open one; the only thing that can is a CAD kernel. So main meshes it to STL
through FreeCAD first (`MC_FREECAD`, one conversion per file, cached by identity,
run in a scratch directory and killed on quit), exactly as a PDF page is rasterized
through poppler. That is also why such a file is **not a model at all** on a machine
without FreeCAD (`fs:can-render-model`, asked once like the transcoder and the PDF
renderer): rather than reserve a box for something that can never fill it, `Enter`
opens the file with the system, and the preview that can never render is never
promised. A mesh format needs no such answer — it is previewable wherever the
renderer runs.

The conversion is one generated Python script, and two details of it matter. The
first is that a STEP or IGES file is *not* a FreeCAD project, so it cannot go in
through `openDocument` — which reads only `.fcstd` — and goes in through
`Import.insert` instead; the script branches on the extension. The second is *what*
to export: the shapes that are **nobody's input** (`not o.InList`). A PartDesign
document lists a Body and, inside it, the Pad and the Pocket that built it; exporting
every object with a shape would stack all three on top of one another. Taking only
the top-level shapes — the Body, a boolean's result rather than its operands — gives
the solid the user actually sees, and a document of only nested shapes falls back to
every shape with one.

On the renderer side a model is drawn into a **canvas** rather than handed to a media
element, so a small component owns that canvas and its scene (`ModelViewer.vue`):
it parses the bytes, centres the model on its own bounds, frames the camera on it and
lights it, and turns it slowly so a single still reads as a solid rather than a
silhouette — the thumbnail by turning the model itself, the enlarged view through
`OrbitControls.autoRotate`. The two are drawn at different rates on purpose: the
thumbnail is ambient, so it is throttled to a calm ~40fps, while the display is
watched and handled and is drawn at every frame the compositor offers — the
monitor's own rate — and only when the camera actually moved, hung on the controls'
`change` rather than on the tick's `update()` return: a wheel's dolly is applied by
the controls *inside their event*, so a render keyed to the tick would skip it and
show the accumulated zoom only when the next drag drew one — so a settled,
non-spinning display draws nothing. The display also hands the
pointer to `OrbitControls`,
which take the turning over the moment they are grabbed (`autoRotate` is switched
off on the controls' own `start` event), so from then on the drag turns the model
and the wheel zooms it, the **middle button panning** the model as the same drag
pans a PDF document (the focus is held within the model's own size, so a drag moves
it about without losing it; the middle press's default is called off, or a browser
would start its own autoscroll on that button). The controls' own default puts pan on
the *right* button, and that one is deliberately not theirs here: on the display the
right button is its own gesture — a quick right-click leaves the mode — so it is left
unbound. The wheel is left to
the controls rather than turned into a folder step, exactly as a PDF's is left to
the browser's scroll. A
WebGL context is a scarce resource — a folder of models is stepped through quickly —
so the component gives its context back on unmount (`dispose()` and
`forceContextLoss()`), not merely when the page goes away.

What the display reveals off is the wrapper element around the canvas, not the canvas
itself: `stageMedia` is a `div`, so the reveal, the travel between presentations and
the wheel's hit test work on it as they do on a still's `<img>`. The one timing
detail is that the viewer announces `ready` only once it has a **non-zero box** — a
footer box that the strip has not yet grown to hold measures zero — and the display's
reveal grows out of that event, so it never measures the media before there is any to
measure.

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

`Enter` on an image, a video or a PDF hands it to the *other* pane to show at full
size (`Enter` again takes it away, and `Escape` leaves the mode): the cursor stays where
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
wide as the picture, with a play/pause button, its position and its length, or a
PDF's page transport in the same place (back and forward buttons, the page, a
track over the pages and the count) beneath the document's scroll box. The
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
pane). The model is the case that is not a letterbox: three.js fits it to the box's
*height* (the vertical field of view), so `drawnRect` reads a model as a centred
square of that height — the box's own width has nothing to do with how large it
looks, and a flight that scaled the box would start at the wrong size. The scale is
by width, so the flight is also *centred* on the target rather than pinned by a
corner: the two rarely share an aspect — a picture letterboxed in a pane, a wall
tile that is not the picture's shape, and above all a 3D model — and a
corner-pinned flight of those starts the media short of the middle and lands it
beside the thumbnail it belongs to. (The transport bar is the one that passes
`false`: it grows out from under the thumbnail, so its top edge is what has to sit
on the target.) It plays once per
*entry* into the mode, guarded by `stage.animation`, so
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
end of a clip is not quietly its beginning again. A PDF takes the same keys in a
different medium: the arrows and the coarser Ctrl steps turn it a page, `seekStage`
scrolling the document to that page rather than seeking an element, and the
transport's track is its seek target. The wheel is the one gesture that does not
turn a page — it scrolls the document itself, page boundaries and all. The wheel over a clip is a
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
file's name — or, in the wall, anywhere on its tile, since a tile *is* its name and
its picture — which is the same gesture with the mouse) opens the display the arrow
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

The run of clicks is *counted*, not asked of the browser, and it is taken on the
**scroller** rather than on a row. `event.detail === 3` looks like the whole
gesture, and `onListClick` used it at first — but the second click starts the pane
display, and the work that takes (a model read and parsed, a clip mounted) lands
between the second click and the third. A count the browser takes from how the
clicks are *handled* then runs out, and a quick triple-click stops at the
double-click that displayed the file: the third click reads as the first of a new
run. Taking it on the scroller is the other half. A press and the release that ends
it do not always come up on the same element — building the display can replace the
DOM under the pointer — and a `click` whose two ends share no row is dispatched to
their nearest common ancestor instead, so a handler on the row never hears it,
however it counts. Both scrollers feed the one place: the details `<ul>` by a `click`
binding of its own, the wall's by forwarding `list-click`. The entry comes from
`[data-path]`; a click that landed on no row at all *continues* the run on the
cursor's entry rather than starting one, since with no run behind it it is a click
on nothing. `countEntryClick` counts three on one entry within `TRIPLE_CLICK_MS`,
measured from the events' own `timeStamp`s — stamped as the clicks arrive, not when
the main thread gets round to them. The listing's gesture therefore covers a whole
row rather than its name alone, which is what the wall's tile already was.

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

### The changed-line gutter is diffed in the renderer

A changed file opened in the viewer shows what its working copy has done to HEAD,
with both sides of each change on screen: the buffer's lines as a faint tint and a
gutter bar (green for an addition, amber for a change), and HEAD's removed lines
drawn inline above the run they were replaced by, on the same removal tint, so a
modification reads as its old line then its new one and a removal reads as the old
line alone. A triangle is left in the gutter at each removal and a mark sits in
the overview ruler for every run. It is the same question the panes' dots answer,
asked of the file rather than the listing, and it is drawn in the same palette
(`DIFF_COLORS`, read from `gitMark.ts`, so the editor and the rows cannot drift
apart). **The baseline is HEAD and not the index** on purpose: a change already
staged still reads as changed from the last commit, which is what the pane's own
dot says about it, where a diff against the index would blank the view for a file
the row is still showing as modified.

**The removed side is a view zone, not a decoration**, because there is no buffer
line for it to be a decoration *of* — the text it names is gone from the model.
Monaco's `IViewZone` is the mechanism the diff editor itself uses for this: a
`domNode` the viewer builds from the baseline's own lines (`removedLinesNode`),
each on the editor's line height so the interleaved old content lines up with the
buffer beneath it, placed after the line the run sat behind (or above the run's
first buffer line, for a change). A zone reserves a fixed `heightInLines`, so the
old lines are drawn as they were and clipped at the right rather than wrapped: how
many lines a wrapped one would need is not known before the zone is placed. A run
larger than `MAX_REMOVED_LINES` shows that many and counts the rest in a final row,
so a whole-file rewrite does not become a hundred thousand nodes. The zones are
rebuilt with the decorations on every repaint, from the same comparison, so what
HEAD held moves with the text exactly as the rest of the view does.

**The comparison is made in the renderer, and main only supplies the baseline.**
The user edits an unsaved buffer, so a diff taken once at open would drift under
the caret the moment a line was inserted above it; re-running it against the
buffer is what keeps the marks on the lines they belong to, and that can only
happen where the buffer lives. Monaco's own diff engine was the obvious choice and
was turned down: it is reachable only through a second diff editor or through an
untyped import into its internals, either of which is more than a longest-common-
subsequence over lines costs (`lib/diff.ts`). The common head and tail are trimmed
before anything quadratic runs, which is what keeps an ordinary edit — and even
most large ones — from ever reaching the matrix at all; a stretch that would
outgrow `MAX_CELLS` is shown as one change rather than guessed at, and the whole
thing is debounced so a keystroke does not re-run it for every character. Lines
are compared without their terminators, so a checkout that shifted line endings
under `core.autocrlf` does not read as a whole-file change.

**A baseline is read as soon as it is needed, and never before.** App.vue asks for
it when the pane's own git view already marks the file as changed, so a file that
is changed when opened has its diff on screen from the first paint. Every other
file has no baseline until the buffer is *edited*: the viewer then fetches one for
itself and starts diffing, which is what makes a clean file opened and changed here
show its diff without being closed and reopened — and what keeps a file that is
only being looked at from ever costing a `git show`. The answer, once given, is
settled: a path outside a repository, a symlink and an oversized blob each leave
the view empty and are not asked again.

Main answers `git:file-base` with `git show HEAD:<rel>`. A path HEAD has no blob
for is new content — a new, staged-add or untracked file — and comes back empty, so
every line reads as added, which is what is true of it; a path git *ignores* comes
back as no baseline instead, the same nothing the panes' dots say about it. A
`truncated` read is given no baseline, because the part the viewer could not show
would read as one enormous deletion against the whole blob; a symlink is given none
either, since its HEAD blob is the link's own text and the viewer was handed the
file it points at.

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
A **curated filename table** (`FILENAME_LANGUAGES`) fills the names Monaco declares
no tokenizer for, because Monaco's shell claims `.sh`/`.bash` and no filename at
all, which left every rc file a shell reads (`~/.bashrc`, `~/.profile`, `~/.zshrc`)
grey. It holds only names whose language is certain — `.vimrc` and `.inputrc` are
not shell and Monaco has no tokenizer for them, so they stay plaintext rather than
borrow the shell's colours — and a name Monaco itself claims still wins.

**A curated key matches a basename in three shapes**, which is what lets one table
hold dotfiles, extensions and compound names at once (curatedNameMatches): the
whole name (`bashrc`), the dotted tail of a compound name (`.bashrc` claims
`bash.bashrc` — `/etc/bash.bashrc` is both a distribution's name for the file and a
compound one — and `.zsh` claims `run.zsh`, so a dotted key also stands in for an
extension Monaco does not declare), and the bare head of one (`dockerfile` claims
`Dockerfile.dev`, `containerfile` claims `Containerfile.prod`). Keys are tried
longest first, so `foo.zsh-theme` is `.zsh-theme` and not the `.zsh` inside it. Each
rc name is listed twice on purpose: the dot is how a home directory writes it and
its absence how a distribution ships it (`/etc/profile`, `/etc/zsh/zshrc`), and
which name belongs to which shell is read from GitHub's Linguist, the reference
list for it. The shebang side follows `/usr/bin/env` past its own options and the
`VAR=value` assignments it accepts, so `#!/usr/bin/env VAR=x python3` is python too.
What neither table can help with is a language Monaco ships no tokenizer for at all
— TOML, Makefile, vim — which is a limit of the grammar set, not of the guess: a
Cargo.toml stays plaintext rather than borrow the ini tokenizer's colours.

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

### `Ctrl+C` copies the name and `Ctrl+Shift+C` the path

The pair is the file manager's own — `Ctrl+C` the cursor entry's name,
`Ctrl+Shift+C` its path, on Explorer's "Copy as path" key — and it is claimed in
`handlePaneKey`, where a gesture for a pane's own listing lives. That placement is
the whole story of who *keeps* it: an expanded, focused terminal never reaches the
function, the viewer, a dialog and the pane menu own the keyboard above it, and a
search box (a text field with a selection of its own) is excluded by name. The
collapsed strip being a real command line — where a `Ctrl+C` nobody consumes is
readline's interrupt — is deliberately not a reason to withhold the key: a
`Ctrl+C` with the panes in front is always the copy, whatever the shell is doing,
and interrupting is what the *terminal* is for, reached with `Ctrl+O` (whose
expanded, focused self keeps readline's key outright). On the `..` row, or below
the last one, `copyEntryChoice` finds nothing and does nothing, and the key is
still consumed so it reaches no shell. The write is `navigator.clipboard`, the
renderer's own to reach, and a refusal is said in the pane's notice rather than
swallowed. Inside an archive the path copy uses `archiveDisplay`'s readable form,
since the NUL-joined location is internal and an entry is not a real path.

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

## Archives

### A place inside an archive is one path string, joined by NUL

A pane's whole identity is one absolute path, and it feeds the listing, the watcher,
git, the size walk, the marks, the cursor anchor, the transfers, the viewer and the
shell sync. Entering an archive therefore cannot be a second kind of value threaded
through all of them without a refactor that would touch everything to say nothing.
Instead a location is still one string, `<archive>\0<inner>`: NUL cannot occur in a
POSIX path *or* in an archive entry name (names are NUL-terminated), so the
separator is unambiguous, and `<inner>` empty is the archive's root. Every
path-keyed thing keeps working by string equality — marks, the cursor's
`resolveAnchor`, the size-walk map, the watcher's `event.path === state.path` — and
the branching is confined to main's `fs:*` handlers plus a handful of renderer
spots. The NUL form is internal: nothing is ever handed to a syscall or shown;
`archiveDisplay` is what the title draws. (`src/shared/archive.ts` holds the model
and the enterable-extension list; `src/main/archive.ts` is the pure reader.)

The alternative — a slash syntax like `foo.zip/inner` — was turned down because a
real folder can contain a file literally named `foo.zip`, so the string would be
genuinely ambiguous. Nesting falls out of the NUL model for free (`a.zip\0b.zip\0x`),
though v1 stops at one level.

### 7z is asked, not reimplemented — and the tar inside a `.tar.gz` is followed

Reading archives shells out to `7z` (`src/main/archive.ts`), probed once and
remembered exactly as git and ffmpeg are (`MC_7Z` names a binary off the `PATH`),
and answered with nothing drawn when it is absent: `fs:can-archive` is false and
Enter on a `.zip` opens it with the system, as it did before. A library was not used
because the reach is the point — one dependency opens zip, 7z, tar, the tar
compressions, rar, cab, iso, deb, rpm and more — and a bundled JS library covers a
handful of those at best.

A `.tar.gz` lists as a *single* member (`t.tar`), so listing one is a second 7z on
the tar inside it, chained through a pipe (`run7zPipe`, `x -so` into `l -slt -si
-ttar`) so neither the tar nor the wrapper is ever written to disk; the wrapper is
recognized by 7z's own `Type` (gzip/bzip2/xz/zstd/…) plus a single `.tar` member, so
a zip that merely *holds* a `.tar` is not mistaken for one. Reading an entry out of
such an archive is the same chain ending in `x -so -si -ttar`. A name is handed to
7z in both spellings (`name` and `./name`) because a tar rooted at `.` stores
`./name` while a zip stores `name`, and 7z treats a name it cannot find as a warning
rather than a failure — the normalized form alone would silently read nothing from a
`./`-rooted tar.

Directories are *synthesized* from the entry paths as well as read from explicit
records, because zip often stores no record for an intermediate directory; the
parsed listing is cached by the archive's mtime, so moving between folders of one
archive does not re-run 7z.

### An archive is a directory you walk into, and the title says which it was

`Enter` on an enterable archive descends into it (`joinArchivePath(entry.path, '')`),
and `..` at its root leaves to the folder that holds it, cursor on the archive. A
*directory* merely named `foo.zip` is never an archive: `activate` only descends for
an entry whose `kind` is `file`, and the listing already draws a folder-icon for a
directory and the gold archive-icon for a file.

The title is where the two could be confused, so the archive's own name is drawn
**in the archive hue** — the same gold `lib/fileIcon.ts` draws an archive's icon in
— with the full path in its tooltip, and the segments are joined with `/` and no
space between them, so the title stays one path:
`/home/laci/Downloads/3DPrinter/3DP_Material_profile_igus-filament.zip/docs/readme.txt`,
the archive file's name in gold. A folder named `foo.zip` keeps the plain title
colour. `archiveDisplay` is the one place that split is read.

### What an archive cannot yet do is said, not attempted

Read-only first: entering, viewing (F3), image previews (footer and display, through
`fs:read-image`), and folder sizes (`Space`, summed from the listing rather than
walked) all work; a few things are deliberately suspended or refused with the pane's
notice. Writes — save (F4), delete, rename, mkdir, copy in or out — are refused in
main (`ENOTSUP`) and guarded in the pane, because editing an archive is a whole-
archive rewrite and a phase of its own. A video inside an archive is not previewable
(the ranged `mc-media` stream serves a real file, not an entry) — `previewKindFor`
gives up the video answer while an image still previews. Git is not asked (nothing
inside an archive is in a work tree), no watcher is opened (there is no inotify for
it), the panel↔shell `cd` sync and the Alt+A/Alt+Enter path pastes are handled
specially, and a file inside an archive is not run or opened — reading it is a read
of its bytes, but starting or opening it needs it extracted first.

The terminal is the one thing made *visibly* unavailable rather than merely left
alone. A shell cannot be *inside* an archive, and a shell that silently sits in the
archive's parent while the pane shows the archive's contents reads as out of sync —
so while the active pane is inside an archive the terminal is **disabled**: the strip
keeps the shell's own prompt — its cwd path — under a light scrim, dimmed enough to
read as not in use but not so much that the path is lost, with the note saying so
centred over it as before, while input is refused at the source (`disableStdin` on the
xterm, so a keystroke produces nothing rather than being swallowed somewhere visible),
focus is handed to the panes, and the path pastes are skipped. `archiveMode` in `App.vue` is the
one signal; `TerminalPane`'s `disabled` prop acts on it. The shell itself is left
running — it is the workspace's, and killing it for a navigation would lose the
session — and is still anchored to the directory holding the archive
(`useWorkspace.shellTargetFor`) so it re-syncs to something real when the pane
leaves, which is what the pane's path changing re-runs.

## Targets: local, root and remote

Everything above this point describes code that exists. The target model below is
implemented — the relay in `relay/`, the registry in `src/main/relay/`, the target
API in `src/renderer/src/lib/targetApi.ts` — with the few divergences from the
first draft noted as they come up.

### A workspace is a connection

A workspace is one tab and one `user@host`: its two panes and its shell all belong
to the same connection, so there is only one filesystem in play. That is what lets
the panel ↔ shell `cd` sync keep its simple rule — the shell's cwd is the pane's
cwd because they are the same machine — and it is why the terminal opens on the
workspace's host rather than being told a host per pane. The tab carries the
`user@host`, so the panes need not: a pane's title stays a plain host path
(`/home/laci/x`), the way a real ssh session tells you where you are from the
prompt and the window, not from prefixing every path. A host is chosen when a
workspace is opened; a terminal is not a way to change hosts, because a
workspace's shell is inherently on its workspace's host.

### One protocol, three transports

The transport is the only thing that differs between a local, a root-local and a
remote target. Everything above it — the panes, the shell, the protocol — is one
codebase, so "manage files as root" and "manage files on another machine" are the
same feature reached three ways. `me@localhost` runs in main, as it does today.
`root@localhost` runs the relay as root, launched once through `pkexec` (polkit)
and speaking the protocol over the pipe: it is session-scoped, started on first
root use, dies with the app, and a restart is a fresh session that authenticates
again. The app itself never runs as root. `user@host` runs the same relay over an
ssh exec channel (`ssh -T host …`) as the ssh user. The protocol rides inside ssh
rather than beside it, so auth, host verification, encryption, jump hosts and the
user's own `~/.ssh/config` are the transport's business and not ours. (The first
draft put the local case on a unix socket; a `pkexec`-launched process on the
app's own pipes is the same boundary with less machinery, and it reuses the ssh
path's framing unchanged.)

Root-local is therefore the rehearsal for remote: the same framing, multiplexing,
pty streams and watch events, exercised over a local pipe with no network and no
deployment, before ssh enters the picture. A protocol that is wrong is found
there, cheaply. The relay is also installed on a remote automatically: on first
connect the app reads the remote `$HOME`, checks the relay's `--version`, and
uploads the built binary to `~/.monda/monda-relay` if it is missing or stale — so
a version bump carries the relay to every host.

### The connect is a labelled, determinate wait

A remote target's relay is installed on first connect (see "One protocol, three
transports"), and that is several real steps — contact the host, install the relay
if it is stale, start it, verify the protocol — so the workspace does not leave the
user looking at a blank list. Main reports each stage over `onProgress` as a
`RelayProgress`: the stage's label and how far through the connect it sits, 0..1.

A workspace is one connection, so its two panes come up together and each would
title itself with the same stage — the same label and the same fill, twice over.
While they connect, `App.vue` therefore draws a single bar across the whole pane
row, over both titles, with the stage stated once. (The pane titles' paths are not
worth reading yet anyway: the relay has not answered, so there is no home to show.)
It is the same `styles/connect.css` treatment as the picker's connecting row — a
hard-edged fill across the element's own background — so the wait is stated by the
chrome the user is already looking at rather than a thin strip beside it. There is
no spinner: a spinner says only that *something* is happening, while a moving fill
says how much.

This is an ssh wait only. `root@localhost` launches its relay locally and is up at
once, so a bar that crept there would be describing a wait that is not happening;
the panes show an ordinary busy listing instead. The stages are coarse and a stage
can take seconds, so even for ssh the fill does not only move when one arrives:
`useConnectFill` eases toward the stage the relay last reported but adds a floor to
every step, so the fill is always creeping and progress is visible *between* stages
rather than jumping and sitting still.

### The connection is long-lived; the protocol is its guest

The ssh master is kept up rather than redialled. `ControlMaster`/`ControlPersist`
share one TCP connection and one authentication across every terminal, pane and
workspace on that host, and keepalive keeps the master from idling out. The
protocol opens its own channel on that master: listings and file operations are
request/response on it, and watches are server-push (`fs:changed`) like the local
watcher, so a pane refreshes on an event and never polls a WAN link. A shell is a
separate pty channel on the same master, so a second terminal costs a channel,
not a login. When the master drops the channel dies: the app says so, then
reconnects by re-opening the master, re-subscribing the watchers and re-listing
once — a resync, not a reload.

`pty:state` cannot answer remotely, because `/proc/<pid>` belongs to the local
ssh process and not the remote shell. A remote shell's cwd has to come from the
remote side — OSC 7 from the prompt, or the relay reading its own `/proc` — and
until it does, the panel ↔ shell sync stays off for a remote target rather than
syncing to the wrong directory.

### Quick cd and the hide mode follow the connection

Both are one state for the whole app today — `quickCdDirs` in
`composables/useQuickCd`, and the module-level toggle in
`composables/useHideMode` — persisted to `userData/quick-cd.json` and
`userData/hide-mode.json`. Both become **per connection**: a bookmark is a folder
on a host, and `/home/laci/x` on the laptop and on the server are the same string
but not the same folder, so the lists and the remembered mode are keyed by target
(host and user, plus port or socket when that differs). The same goes for the
watchers main refcounts by directory: a directory watched on one host is not the
directory of the same name on another.

A target does not ride inside the location string. Archives already qualify a
place as `<archive>\0<inner>` and the app compares locations as strings, but a
target encoded the same way would make `isArchivePath` ambiguous, since a
target-qualified local path contains a NUL too. The target is therefore carried
beside the location, as its own field. The pane's own path-keyed maps stay safe
because a workspace has one target; only the stores that outlive a workspace —
the quick cd list, the remembered hide mode, main's watcher refcounts — are keyed
by the target as well as the path. The title still draws the readable path, as
`archiveDisplay` is the one place the archive split is read.

### The foreign pane, when the panes diverge

The model above keeps both panes on the workspace's host. A later step lets the
other pane point elsewhere — local or remote — and the rules that keep it honest
are: the foreign pane runs no commands, because the workspace's shell lives on the
workspace's host and typing a local path into a remote prompt (or running a file
from the wrong side) is the failure the shared connection exists to avoid; its
title draws `user@host` in the path, since the tab can only speak for the
workspace's host; the panel ↔ shell sync pushes only from the pane whose target
matches the shell's; and a copy across the two targets proxies the bytes through
the app rather than pretending the paths meet.

