# Keybindings

The panes' keys — everything below — are claimed by the window capture handler in
`App.vue`. Two checks run ahead of them and take the keyboard first: an
**expanded terminal** (`Ctrl+O`) owns it outright, and a full-screen **display**
owns `Tab` and `Escape`. While the terminal is collapsed, printable characters go
to the shell and the navigation keys still drive the panes.

## Panes

`Tab` switches panes, arrows/`Home`/`End`/`PgUp`/`PgDn` move the cursor
(`←`/`→` step the clip being previewed by ten seconds, and `Ctrl+J`/`Ctrl+L` by
a minute back/forward while `Ctrl+H`/`Ctrl+;` step it by ten minutes — all only
while the command line is empty; with anything typed there — or in an open search
box — the arrows are the line's own keys again and the Ctrl steps belong to the
shell, whose `Ctrl+H` is backspace, `Ctrl+L` clear-screen and `Ctrl+J`
accept-line; `Space` pauses or resumes the clip being watched there — the
display's, or the footer preview if none is up — and stays the shell's own space
when there is no clip to toggle),

`Enter` descends, or runs a file the user can run in the workspace's own shell —
the green name is a promise, and the shell is where it is kept, shown for as long
as the program runs — or opens anything else with the system default app, except
an image or a video, which it displays in the other pane instead (one there is
nothing in the app to decode is opened like any other file) — and a double-click
on a row is the same thing with the mouse (`activate` → `activateRow`),
`Ctrl+Enter` opens that same media as a full-screen display over the whole window
(a triple-click on the file's name is the mouse's half of the gesture; pressed
again it gives the window back, and `Escape` leaves the mode),

`F3` opens a regular file read-only in the Monaco viewer, `F4` opens it for
editing with Ctrl+S to save (a directory still descends on `F3`), and a file the
editor cannot show — a binary, or a read that fails — never opens it at all: the
pane says so in its notice, which `Escape` puts away,

`Insert` marks the current entry and moves down, `*` marks every file in the pane
— or unmarks them when they are all marked, so one key answers both, and only
files either way: a folder is marked by hand when it is wanted, since a key that
swept them up too would drag them into whatever transfer follows. "File" is every
row that is not a folder, so a symlink counts even when it dangles (a broken
`~/.steampath` is a `symlink` row, not a `file` one) while a link *to* a folder
is a folder like any other — claimed only while the command line holds nothing,
since a typed `*` is a glob for the shell,

a right press marks the row it lands on, on the *release* rather than on the way
down, and leaves the cursor where it was — the right button marks, the left one
is where the cursor goes — while dragging the held right button paints that same
mark across every row it sweeps over, the rows between its own reports filled in
as it goes (holding the left button and dragging instead moves the cursor from
row to row), and that same press *held* still on a row — or `Ctrl+right-click`,
or `Shift+F10`, or the keyboard's own menu key — opens the row's menu at the
pointer, the click, the sweep and the hold being told apart by time and by what
the pointer does rather than by a modifier,

`Ctrl+O` toggles the terminal, `Ctrl+R` re-lists the active pane,

`Ctrl+T` opens a new terminal — a fresh workspace (two panes at home plus a new
shell) at the right of the tab strip, focused — `Ctrl+W` closes the active one
(the last workspace is never closed), `Ctrl+PageDown`/`Ctrl+PageUp` step to the
next/previous workspace, `Shift+Ctrl+PageDown`/`Shift+Ctrl+PageUp` (or dragging a
tab) move the active workspace right/left in the strip,

`Ctrl+U` swaps the two panels (each keeps its cursor, marks and filter) — the
panes change columns in one frame, since the two are reordered in the row rather
than rebuilt, so the exchange is shown as copies of both of them travelling to
the other column, and nothing in a pane stops for it: a display among them goes
on playing as it changes column, and the columns keep the sizes they had, so the
divider does not move,

`Alt+S` starts an incremental search, `Alt+Enter` pastes the cursor entry's name
onto the command line followed by a space and `Alt+A` the directory holding it,
closed with a separator — the folder rather than the entry's own path, since the
line is where a command is typed and the folder is what one is handed, and closed
because that is how the shell reads a path as a folder it can go on completing
inside (both shell-quoted when they contain anything the shell would act on, so a
space or a `$` arrives as part of the one argument, and both typed into the shell's
own line
so its echo and history see a real command line),

`Alt+.` switches the hide mode off and on — a `.mchide` file in a folder lists
entries for it to leave out, and the mode is one remembered state for the whole
app, so the gesture is the panes' rather than the shell's: in a real terminal
`Alt+.` stays readline's yank-last-arg, as `Alt+S`, `Alt+A`, `Alt+Enter`,
`Ctrl+R` and `Shift+F10` stay the program's there too —

`F5` copies the marked entries (or the cursor row) into the other pane, `F6`
moves them there (both take a destination field naming a directory to act into,
but for a single entry a path that is not a directory is the entry's new name —
so `blah` -> `blah2` renames or copies to `blah2`, rather than making a `blah2`
folder and putting `blah` inside it, and a trailing separator, `blah2/`, asks for
a folder instead), `Shift+F6` renames the cursor row in place, `F7` makes a
directory in the pane being browsed — a dialog takes the name, which is a folder
name or a path, relative to that pane or absolute, and the cursor lands on the
new folder — and `F8` deletes them after confirmation.

`Backspace` never navigates: it belongs to the shell's line editor (or the search
box), so the `..` row is the way up.

## Which layer owns a key

The bottom strip is the active workspace's shell itself: the same xterm,
collapsed to a single visible line, so the prompt, font and echo are the shell's
own rather than a look-alike widget. `Ctrl+O` expands it into the full terminal,
which then owns the keyboard outright — and *outright* is the word: what
`onKeydown` claims below that check is gestures for a *pane* (its listing, the
row under its cursor, the mode it is in), which an expanded terminal has left no
room to be seen in, so they are all handed to whatever is running in it.

Midnight commander is what makes that matter, since the gesture and the program
want the same key: `Alt+S` (Search), `Alt+A` (PutCurrentPath), `Alt+Enter`
(PutCurrentSelected), `Ctrl+R` (Reread) and `Alt+.` (ShowHidden) are pane
gestures of ours *and* of mc's, and a plain shell's readline has `Ctrl+R` and
`Alt+.` of its own. Above that line is only the app's own chrome — the overlays,
`Ctrl+O`, the tab keys, and the `Escape` of a display that covers the whole
window.

While it is collapsed, printable characters go to the shell and navigation keys
still drive the panels; `Enter` runs the typed line, or activates the panel entry
when the line is empty. `Backspace` is left alone so it edits the line, and
reaching the parent is the `..` row's job.
