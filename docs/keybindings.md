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
while the command line is empty; with anything on it — typed, or put there by
readline itself (Up/Ctrl+P history recall, a completion, a yank), which the
terminal is asked about rather than the keystroke model — or in an open search
box, the arrows are the line's own keys again and the Ctrl steps belong to the
shell, whose `Ctrl+H` is backspace, `Ctrl+L` clear-screen and `Ctrl+J`
accept-line; `Space` pauses or resumes the clip being watched there — the
display's, or the footer preview if none is up — and with no clip it walks the
folder under the cursor, counting the total up in the row's size column as
subdirectories are traversed, and steps to the next row so a column of folders can
be sized in one pass — or, from the `..` row, sizes every folder in the listing
at once and leaves the cursor where it is; with none of that it stays the shell's
own space — a PDF under the cursor has no playhead, so `←`/`→` and the coarser Ctrl
steps turn it a page instead, `Space` not being claimed by it, and which page it is
on is shown in the footer beside its count; in the display a PDF is a scrollable
document, so a wheel over it scrolls it (across page boundaries) rather than turning
a page, a middle-button drag pans it — both ways, since a magnified page is wider
than the box as often as it is taller — and `Alt+W`/`Alt+P` fit it to the box's
width or to a whole page (a fit is a rule rather than a size, so its percentage is
the box's to decide — fit width being 100% by definition), and `Alt+=`/`Alt+-` step
the magnification to the next rung above or below the percentage shown, which then
stays that fraction of the pane however it is resized. The percentage is the page's
width against the pane's — the `%` label says so in its tooltip — so above 100% the
page is wider than the pane and scrolls sideways. The transport's fit buttons and its
`-`/percentage/`+` group are the same gestures, remembered across launches),

`Enter` descends, or runs a file the user can run in the workspace's own shell —
the green name is a promise, and the shell is where it is kept, shown for as long
as the program runs — or opens anything else with the system default app, except
an image, a video, a PDF or a 3D model, which it displays in the other pane instead
(one there is nothing in the app to render — for a model, a CAD document with no
FreeCAD to mesh it — is opened like any other file), and except an archive
(a `.zip`, a `.tar.gz`, a `.7z`, …), which it *descends into* as if it were a
directory — the pane title marks it with a chip carrying the archive's name, so
being inside `foo.zip` reads apart from being inside a folder merely named so, and
`..` at the archive's root leaves it for the folder holding it. Entering archives
needs 7z on the machine; without it an archive file is opened like any other — and
a double-click
on a row is the same thing with the mouse (`activate` → `activateRow`),
`Shift+Enter` hands the row to the system default application whatever the app
would have done with it — an image, a video, a PDF or a model that would have been
displayed, a runnable file that would have been started in the shell, an archive that would
have been walked into — while a folder still descends, since there is no default
application to force,
`Ctrl+Enter` opens that same media as a full-screen display over the whole window
(a triple-click is the mouse's half of the gesture — on the row in the listing, on
the tile in the wall, both being the file the pointer is over; pressed again it
gives the window back, and `Escape` leaves the mode),

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

`Ctrl+C` copies the *name* of the entry under the cursor to the clipboard, and
`Ctrl+Shift+C` its full path — the file manager's own pair, the second on
Explorer's "Copy as path". It is the panes' own while the panes are in front, and
it is claimed outright there: interrupting is the *terminal's* — `Ctrl+O` expands
it, and a `Ctrl+C` inside the expanded, focused terminal is still readline's own
SIGINT — so a `Ctrl+C` with the panes showing is always the copy, whatever the
command line is doing. A search box keeps the key, since it is a text field with
a selection of its own, and so does a selected PDF page — there `Ctrl+C` copies the
selected *text* (the app puts it on the clipboard itself), the row's own copy
standing aside for it. On such a page a double-click selects a word and a
triple-click the paragraph — and holding the button and dragging adds whole
paragraphs from there, the way they would in any text — rather than enlarging the
display (`Ctrl+Enter` still does that), and a key typed while a page holds the
keyboard is handed to the command line, so selecting text costs nothing afterwards
— the first character typed goes into the shell and returns the keyboard there). On
the `..` row, or below the last one, there is nothing
to copy and it does nothing. Inside an archive the path copy takes the readable
form the pane title shows (`foo.zip/dir/file`), because nothing in there is a
real path,

`Ctrl+U` swaps the two panels (each keeps its cursor, marks and filter) — the
panes change columns in one frame, since the two are reordered in the row rather
than rebuilt, so the exchange is shown as copies of both of them travelling to
the other column, and nothing in a pane stops for it: a display among them goes
on playing as it changes column, and the columns keep the sizes they had, so the
divider does not move,

`Alt+E` builds the active pane's columns: each column's label becomes a picker of
the column types — Name, Size, Modified, Mode, Mode (num) — beside a grip
and a remove button, and an add button sits in every gap, before each column and
after the last (the first type not already shown is what an add inserts, and its
picker opens at once). The grip drags the column to another place, so a column can
be re-ordered while it is being built; the name column is the one that cannot be
removed. The pane's own edit icon is pinned to the right edge of the header,
appearing on hover and toggling the same mode. The whole mode is the keyboard's
too: the arrows move between the columns (a highlight marks the one the keys act
on, and a click puts the same highlight on a column), `Home`/`End` jump to the
first and last, `Enter` opens the focused column's picker, `Insert` adds a column
after it, `Delete` drops it, and `Alt+Left`/`Alt+Right` re-order it. A type a
column already shows is greyed out in every other picker, since a column is shown
once; `Alt+E`, the icon, or `Escape` leaves the mode,

`Alt+T` cycles the active pane's view — the detail listing, a wall of thumbnails,
and back to the listing. The mode is the pane's own, like its sort and its
columns: it changes how the rows are drawn and nothing about which rows they are,
so the cursor, the marks, the transfers, the search and the row menu all go on
working. The wall draws each entry from its own picture where one can be had — an
image shrunk to a tile, a frame of a clip, a PDF's first page — and from its type
icon otherwise (a folder, a text file, a 3D model, a clip with no ffmpeg, anything
on a remote target). The pane title bar's own button is the same gesture by
pointer. While the wall is up the header is hidden (there are no columns to head)
and the arrows move the cursor by a cell: `←`/`→` step one entry and `↑`/`↓` a
whole row, rather than the clip's ten-second seek they are in the listing — the
clip's own seek stays with the display, the footer's transport and the coarser
Ctrl steps. `Ctrl+=` and `Ctrl+-` make the tiles larger or smaller and `Ctrl+0`
puts them back at their ordinary size: a few rungs of a ladder, animated, the model
tiles growing with their boxes (Ctrl being the chord every application uses for
zoom — a PDF *page*'s own fit and magnification stay on Alt+W/Alt+P/Alt+=/Alt+-).
`Alt+E` in the wall brings the listing back and opens the column
editor, since the columns it builds are the listing's,

`Alt+C` puts the quick cd directories in the pane in place of its listing — a list
of bookmarked folders, one path per row, with an incremental search opened with it
so the folders can be filtered by typing. The pane title bar's star button is the
same gesture by pointer: it toggles the mode, and, unlike the header's own controls,
it is still there while the mode is on, so it is also the way back. The
arrows/`PgUp`/`PgDn`/`Home`/`End`
move through what the filter leaves and `Enter` goes to it (the pane leaves the
list and loads that directory); `Left`/`Right` edit the query. The row menu is how
the list is built: on a folder row it offers `Add to quick cd` (and `Add this
folder to quick cd` on any other row, naming the pane's own folder), while on a row
*of the list* it offers `Move up`/`Move down` (`Alt+Up`/`Alt+Down`) and `Remove
from quick cd`. The list keeps the order you put it in — it is never sorted, so
those moves are how a folder is placed — and is one for the whole app, remembered
between launches; an empty one says so in the pane's notice.
`Escape` (or `Alt+C` again) gives the listing back exactly as it was, and `Tab`
still switches panes,

`Alt+S` starts an incremental search, `Alt+Enter` pastes the cursor entry's name
onto the command line followed by a space and `Alt+A` the directory holding it,
closed with a separator — the folder rather than the entry's own path, since the
line is where a command is typed and the folder is what one is handed, and closed
because that is how the shell reads a path as a folder it can go on completing
inside (both shell-quoted when they contain anything the shell would act on, so a
space or a `$` arrives as part of the one argument, and both typed into the shell's
own line
so its echo and history see a real command line),

`Alt+O` points the *other* pane at what the cursor is on — a directory entry
loads that directory there (the `..` row loads the parent), and a file loads the
folder holding it, which is the pane's own — and then steps the cursor on, so a
column of folders can be walked into the other pane one key at a time. The pane
being browsed is not left; only the other one moves. It is midnight commander's
PanelOtherCd, and mc running in the expanded terminal keeps its own,

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
new folder — and `F8` deletes them after confirmation, leaving the cursor on the
row just before the one that went (the `..` row when that was the first entry). A
file removed from under the cursor some other way — another program, a command at
the prompt, the other pane — lands it on the closest row before it all the same.

`Escape` stops the size walks: a folder walk is the only thing still working in
the background, so it is taken back before the pane's notice is dismissed.

`Backspace` never navigates: it belongs to the shell's line editor (or the search
box), so the `..` row is the way up.

## Which layer owns a key

The bottom strip is the active workspace's shell itself: the same xterm,
collapsed to a single visible line, so the prompt, font and echo are the shell's
own rather than a look-alike widget. While the active pane is inside an archive the
strip is **disabled** — the prompt stays visible under a light scrim, a centred note
says it is unavailable, and it takes no input — since a shell cannot be inside an
archive; the panes keep the keyboard instead. `Ctrl+O` expands it into the full terminal, which then owns the keyboard outright — and *outright* is the word: what
`onKeydown` claims below that check is gestures for a *pane* (its listing, the
row under its cursor, the mode it is in), which an expanded terminal has left no
room to be seen in, so they are all handed to whatever is running in it.

Midnight commander is what makes that matter, since the gesture and the program
want the same key: `Alt+S` (Search), `Alt+A` (PutCurrentPath), `Alt+Enter`
(PutCurrentSelected), `Alt+O` (PanelOtherCd), `Alt+T` (ChangeListingFormat),
`Ctrl+R` (Reread) and `Alt+.`
(ShowHidden) are pane
gestures of ours *and* of mc's, and a plain shell's readline has `Ctrl+R`,
`Alt+.`, `Alt+T` (transpose-words) and `Alt+C` (capitalize-word) of its own.
Above that line is only the
app's own chrome — the overlays,
`Ctrl+O`, the tab keys, and the `Escape` of a display that covers the whole
window.

While it is collapsed, printable characters go to the shell and navigation keys
still drive the panels; `Enter` runs the typed line, or activates the panel entry
when the line is empty. `Backspace` is left alone so it edits the line, and
reaching the parent is the `..` row's job.
