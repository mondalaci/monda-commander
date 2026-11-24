# Porting to macOS and Windows

The app is Linux-first today: `electron-builder.yml` has only a `linux` target and
the only packaging script is `dist:linux`. The stack itself is portable —
Electron, Vue, Tailwind, xterm, Monaco, three.js, node-pty (N-API, with a ConPTY
backend) all run on macOS and Windows — so what stands between here and a
`.dmg`/`.exe` is build config plus a handful of genuinely Linux-shaped code paths.

The shape of the work is the same on both platforms: **introduce a thin platform
layer, let each OS supply its own pieces, and let a feature that cannot be ported
degrade gracefully** the way the app already does for a missing `7z`, `ffmpeg` or
poppler. Nothing here changes the app's design; the reasoning it rests on is in
[`design.md`](design.md).

The four places where "port it" becomes "rethink it":

1. **The relay daemon** (`relay/`) — POSIX: a unix-domain socket, `Setsid`, and
   `syscall` statfs.
2. **The shell-integration layer** — bash/POSIX: the injected `cd`, `printf`
   erase-echo, `history -d`.
3. **The `/proc` reads** — cwd and foreground-process-group (`tpgid`).
4. **The Ctrl-first key model** — `isPlainCtrl` keys off `ctrlKey` and expects
   Cmd on macOS.

---

## Phase 0 — build and packaging (both platforms)

**Done:** `electron-builder.yml` carries `mac` (`dmg` + `zip`) and `win`
(`nsis`) targets beside `linux`, each picking its own relay binary from
`resources/monda-relay-${os}-${arch}`; `scripts/build-relay.mjs` cross-compiles
the relay (`build:relay:linux|mac|win|all`) without relying on a POSIX shell's
`VAR=value cmd`; `package.json` has `dist:mac` / `dist:win`; and
`relayBinaryPath()` names the packaged binary `monda-relay.exe` on Windows. A
`electron-builder --linux --dir` run confirms the `${os}`/`${arch}` macro
resolves and the right relay lands in `resources/`.

Cross-compiling the relay for macOS also turned up one real bug: `rawMode`
(`relay/fs.go`) returned `stat.Mode` directly, and **Darwin's `Stat_t.Mode` is a
`uint16` where Linux's is a `uint32`**, so it now casts to `uint32`. With that,
`build:relay:mac` produces both Mach-O slices.

**Still to do:** real `.icns`/`.ico` (electron-builder converts the existing
512×512 `resources/icon.png` for now), and signing — see [Signing](#appendix-signing).
`dist:win` packages (verified with `--win --dir -c.npmRebuild=false`, which
produced `release/win-unpacked` with `resources/monda-relay.exe`); the relay's
Windows port that used to block it is done — see the Windows track below.

**CI:** `.github/workflows/ci.yml` runs on `main` and on pull requests. A
`checks` job typechecks, cross-compiles the relay for all five targets and vets
it for linux/darwin/windows; a `package` matrix then runs `dist:linux`,
`dist:mac --arm64 --x64` and `dist:win` on native runners and uploads the
installers. Node is pinned by `.nvmrc` (22) and Go by `relay/go.mod`. Nothing is
signed — that is where signing and notarization would be added. The linux leg of
that pipeline has been run end to end locally (a real `.AppImage` and `.deb`);
the macOS and Windows legs have not run anywhere yet, and are the first real
build on those platforms.

| File | Change |
|---|---|
| `package.json` | Add `dist:mac`, `dist:win`. Make `build:relay` produce per-OS binaries (`GOOS=darwin\|windows GOARCH=amd64,arm64`) into `resources/monda-relay-<os>-<arch>`; keep `dist:linux` as it is. |
| `electron-builder.yml` | Add `mac:` (`dmg` + `zip`, `category`, `hardenedRuntime`, `entitlements`, notarization) and `win:` (`nsis` + `portable`, `.ico`). Add a top-level `icon`, and per-platform `extraResources` that select the right relay binary (electron-builder's `${os}`/`${arch}` file macros). |
| `build/` (new) | `icon.icns`, `icon.ico` — electron-builder's default `buildResources` directory. |
| signing | macOS: a Developer ID certificate + notarization. Windows: an OV/EV certificate for a clean SmartScreen experience — unsigned builds work but warn. See [Signing](#appendix-signing) below. |

One thing the per-platform relay does **not** yet solve: `deploy.ts` uploads the
*local* build's relay to a remote host, so a macOS or Windows client connecting
to a Linux target would ship the wrong binary. A remote relay has to be built for
the *remote's* OS/arch; that is a `deploy.ts` change, tracked with the Windows
work below.

`asarUnpack` for node-pty is already correct (it ships macOS and Windows
prebuilds), and `npmRebuild` is on.

**Note on where a build can run:** a signed, notarized macOS artifact must be
built on macOS. A Windows NSIS installer *can* be built from Linux (electron-builder
uses wine + mono), but a real Windows runner is cleaner. This is the reason the
plan keeps per-platform CI in view rather than a single `dist:all`.

---

## Phase 1 — the shared platform layer (needed by both)

New modules, so the OS-specific bits stop being inline `if`s:

- `src/shared/platform.ts` — `isMac` / `isWindows`, and the **primary-modifier**
  helper (`isPrimary(event)` = Cmd on macOS, Ctrl elsewhere) that the key model
  will read.
- `src/main/platform/proc.ts` — `readProcessCwd(pid)` and `isShellAtPrompt(pid)`
  behind one interface (today at `src/main/ipc/pty.ts:37` and `:51`).
- `src/main/platform/mount.ts` — the filesystem and mount point for disk usage.
- `src/main/platform/elevate.ts` — how the `root` target launches the relay.
- `src/main/platform/shell.ts` — the default shell and the injected-line strings.

**One cross-platform win already taken:** the app's disk usage no longer reads
`/proc/self/mountinfo` — `mountPointFor` (`src/main/ipc/fs.ts`) now finds the
mount point by walking up while `stat.dev` is unchanged, so it answers the same
way on Linux, macOS and Windows. The relay's `syscall.Statfs_t`
(`relay/fs.go:787`) is still Linux/POSIX and belongs to Phase 3, where dropping
it also removes one of its two Windows compile blockers.

The degradations this layer makes explicit (the app disables, it never guesses):

| Feature | Linux | macOS | Windows |
|---|---|---|---|
| cwd sync + command injection (`isShellAtPrompt`) | full | cwd via `libproc`/`lsof`, **idle detection stays off** → injection disabled in v1 | **off** (no cheap cwd or `tpgid`) |
| `root` target | `pkexec` | needs an `osascript` shim | **off** in v1 |

---

## macOS track

**Done:** the window chrome (`titleBarStyle: 'hiddenInset'` + `trafficLightPosition`
on darwin, in place of `frame: false`; `TitleBar.vue` hides its own buttons and
pads a `pl-20` gutter for the lights), the platform surface (`window.mc.platform`,
read once in `src/renderer/src/lib/platform.ts`), the primary-modifier key model
(every `Ctrl+…` in [`keybindings.md`](keybindings.md) is `Cmd+…` on macOS, through
`isPlainPrimary` / `isPrimaryShift` / `hasPrimary`), the darwin-only application
menu (app / Edit / View / Window), and the `disable-accelerated-video-decode`
switch gated to Linux.

The menu omits the roles whose accelerators are the app's own keys: no
`View>Reload` (`Cmd+R` re-lists a pane), no `File>Close`/`Window>Close`
(`Cmd+W` closes a workspace) and no View zoom (`Cmd+=`/`Cmd+-`/`Cmd+0` size the
wall's tiles). Two standard accelerators do still shadow an app chord, left to the
menu deliberately: `Edit>Copy`/`Cut` own `Cmd+C`/`Cmd+X`, and the app menu's Hide
owns `Cmd+H` — so the panes' copy-name, transfer-cancel and the ten-minute-back
video seek are unavailable on macOS. (A macOS menu accelerator fires *and* lets
the renderer's `keydown` through, so `Cmd+C` in a text field copies the selection
while in a pane it copies nothing; that is why they are left to the menu rather
than fought over.) The fix, if it is wanted, is main-side `before-input-event`
interception routed back to the renderer; it is not done.

**Still to do:**

| Item | Change |
|---|---|
| `src/main/relay/registry.ts:216` | `pkexec` → an `osascript … with administrator privileges` shim. **Non-trivial**, because `do shell script` has no duplex stdio; reasonable to defer and hide the `root` target on macOS in v1. |
| `src/main/platform/proc.ts` | cwd via `lsof -a -p <pid> -d cwd -Fn` (present on macOS) or a small libproc native addon; leave idle detection off. |
| verification | the traffic-light position and the key model are the two things only a real macOS run settles (per [`verifying.md`](verifying.md), the user drives it). |

Already portable on macOS, untouched: `shellQuote` and the workspace `cd`
injection (zsh runs `printf` fine; the `history -d` half is guarded by
`$BASH_VERSION`, so it simply skips), `shell.openPath` / `showItemInFolder`, the
exec-bit runnable rule, the POSIX mode columns, node-pty, and the whole relay
protocol (a unix socket and `Setsid` are fine on Darwin).

---

## Windows track (the heavy lift)

**The relay now compiles for Windows — done and verified.** `GOOS=windows go
build` failed at exactly four places (`syscall.Stat_t`, `syscall.Statfs_t`,
`syscall.Statfs` in `relay/fs.go`; `syscall.SysProcAttr.Setsid` in
`relay/server.go`), and the platform-specific halves now live behind build tags:

- `relay/process_unix.go` / `relay/process_windows.go` — `detachProcessGroup`
  (`Setsid` on Unix; `CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS` on Windows) and
  `terminateProcess` (`SIGTERM`; `Kill` on Windows, which has no `SIGTERM`).
- `relay/stat_unix.go` / `relay/stat_windows.go` — `rawMode`, `filesystemSpace`
  (`statfs`; `GetDiskFreeSpaceExW` via `kernel32` on Windows) and `mountPointFor`
  (`/proc/self/mountinfo`; the volume root, `C:\`, on Windows).
- `relay/main.go` — `HelloInfo.Platform` is `runtime.GOOS`, not hard-coded
  `"linux"`.

**The daemon transport needed no change.** Go's `net` package supports `unix`
sockets on Windows 10 build 17063+ (AF_UNIX), so `--server`/`--connect` keep their
unix socket and `MONDA_RELAY_SOCK` still overrides its path — no named pipe, no
new dependency. `relay/pty.go` and `relay/fs.go` compile for Windows untouched
(creack/pty drives ConPTY; `syscall.WaitStatus` exists on Windows).

`go vet` is clean for both `linux` and `windows`, and all five relay targets
build (`build:relay:all`). An `electron-builder --win --dir` run then produced
`release/win-unpacked` with `resources/monda-relay.exe` (a valid PE32+).

**Packaging caveat (verified):** cross-building Windows from Linux trips
`npmRebuild: true` — node-gyp cannot cross-compile node-pty from source. With
`-c.npmRebuild=false` it packages fine, because node-pty ships `win32-x64`/`win32-arm64`
prebuilds and its loader falls through to them. On a real Windows machine the
default is fine (given VS Build Tools) or `npmRebuild: false` avoids needing them.
This was not changed in the committed config, so **`dist:win` wants a Windows
runner or `-c.npmRebuild=false`.**

**The runtime layer is in — done.** The app now steps aside, on Windows only,
wherever a POSIX assumption would be wrong, and the relay starts the right shell:

- `relay/shell_unix.go` / `relay/shell_windows.go` — `defaultShell` is `$SHELL`
  or bash on Unix, `%COMSPEC%` (cmd.exe) or PowerShell on Windows, matching the
  app's own local shell (`ipc/pty.ts`).
- `src/renderer/src/lib/platform.ts` — `isWindows` joins `isMac`.
- `useDirectory.ts` — `COLUMN_TYPES` drops the two mode columns on Windows (NTFS
  has no Unix mode bits, so they would read blank); the default `columnOrder`
  never named one, so nothing else changes.
- `lib/executable.ts` — `isRunnable` is extension-only on Windows (no exec bit),
  and `shouldExecute` is false there: running a file means typing a POSIX-quoted
  path into the shell, so `Enter` on a program hands it to the system handler
  instead (as Explorer's double-click does).
- `useWorkspace.ts` — the panel→shell `cd` injection (POSIX `cd … && printf …;
  history -d …`) is skipped on Windows.
- `App.vue` — `Alt+Enter` / `Alt+A` (which shell-quote an entry onto the command
  line) are left unclaimed on Windows.
- `src/main/relay/registry.ts` — the `root` target is offered **only on Linux**,
  the one platform whose launch (`pkexec`) exists; macOS would need the
  `osascript` shim below.
- `src/main/platform/binaries.ts` — the default `PATH` names for `7z`, `ffmpeg`,
  `ffprobe`, `pdftocairo`, `pdfinfo`, `pdftotext`, `freecadcmd` and `git` carry
  `.exe` on Windows, where Node's `execFile` does not apply `PATHEXT` (`MC_*`
  overrides are taken verbatim).
- `src/main/index.ts` — `app.setAppUserModelId('com.monda.commander')` on
  Windows, so the taskbar groups the app under its `appId`.

`src/main/ipc/pty.ts` needed nothing: `readProcessCwd` / `isShellAtPrompt` were
already Linux-only and return null/false elsewhere, which is exactly the
"injection disabled" degradation the renderer now agrees with.

**Still to do:**

| File | Change |
|---|---|
| `src/main/relay/deploy.ts` | Uploads the *local* build's relay to a remote host, so a Windows or macOS client talking to a Linux target ships the wrong binary. The remote relay has to be built for the *remote's* OS/arch — either ship every relay in `extraResources` (≈4 MB each) or fetch the matching one; both are design decisions of their own. |
| verification | the Windows runtime layer is code-only here — it needs a real Windows run (per [`verifying.md`](verifying.md), the user drives it). |
| signing | An OV/EV certificate for a clean SmartScreen experience. |

---

## Sequencing

1. **Phase 0** — unsigned installers for all three platforms. *~1 day.*
2. **Phase 1** — platform layer plus graceful degradation, no new features. *~2–3 days.*
3. **Phase 2 (macOS)** — menu, Cmd keys, traffic lights, `osascript` root, cwd via
   lsof, notarization. *~3–5 days.*
4. **Phase 3 (Windows)** — **done**: the relay compiles and packages, and the
   runtime layer steps aside from the POSIX assumptions (see the Windows track).
   What is left is `deploy.ts`'s remote-relay platform and signing.

## Verification

Per [`verifying.md`](verifying.md), the visual and interactive testing is the
user's; the build-level checks are:

- Per platform: `npm run typecheck` → `electron-vite build` → `electron-builder --<os>`.
- Relay cross-compile: `GOOS=darwin|windows GOARCH=amd64,arm64 go build`.

A smoke checklist worth adding to `verifying.md` for each new platform: window
controls / traffic lights, primary-modifier shortcuts, terminal open and resize, a
local pty and a remote ssh relay, a folder size walk, the disk-usage tooltip,
open/reveal, and the graceful "feature off" notices (`root` target, injection,
mode columns).

## Risks and unknowns

- **macOS idle detection** (`tpgid`) has no clean portable equivalent. Injection
  stays Linux-only unless the app moves to shell-integration prompt marks
  (OSC 133), which is a real project of its own.
- **Windows `root` elevation** and the **bash/POSIX shell-integration layer** are
  the two places where "port it" becomes "rethink it".
- **Notarization** needs an Apple Developer account; **Windows signing** needs a
  certificate. Both are outside the codebase.

---

## Appendix: signing

**Wired, but the secrets are not in place.** The mechanism is committed; the
credential *values* are GitHub secrets, which are write-only — `gh secret list`
shows names, never values, and no API can read them — so they have to be added to
`mondalaci/monda-commander` by hand (the nine names are listed at the end).

What is wired:

- **macOS** — `build/entitlements.mac.plist` (JIT, unsigned executable memory,
  dyld env, library validation for node-pty; deliberately **no** USB, which the
  Agent plist carries for its keyboard), and `mac.hardenedRuntime` /
  `entitlements` / `entitlementsInherit` in `electron-builder.yml`. The Developer
  ID certificate is `scripts/certs/mac-cert.p12.enc` (the same file the Agent
  repo keeps, copied here); CI decrypts it with `CERT_KEY`/`CERT_IV` and points
  `CSC_LINK` at it. Notarization runs automatically once `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` are set.
- **Windows** — `scripts/sign-windows.mjs` (Azure Key Vault, the same service the
  Agent release uses) is named by `win.signtoolOptions.sign`, with
  `signingHashAlgorithms: [sha256]` so each file is signed once rather than twice
  (the default would add a SHA-1 pass). CI installs AzureSignTool as a dotnet
  tool. The module **no-ops when `AZURE_KEY_VAULT_URL` is unset**, so a fork or a
  build without the secrets is unsigned rather than broken — which is how the
  linux and windows `--dir` builds here were verified.
- **`CSC_IDENTITY_AUTO_DISCOVERY: 'false'`** in CI, so signing is the decrypted
  `.p12` or nothing — never whatever identity a machine happens to have.

Both halves are untested with real credentials: nothing here has been signed or
notarized yet.

### Which keys, and the caveat

Can the credentials already used for `~/projects/agent` sign Monda Commander?
**Yes, for both platforms — because they are organisation/team-scoped, not
app-scoped** — with three caveats.

### macOS

Agent signs with a **Developer ID Application** certificate (`scripts/release.mjs`,
team id `CMXCBCFHDG`), stored encrypted in the repo as
`scripts/certs/mac-cert.p12.enc` and decrypted at release time with the
`CERT_KEY` / `CERT_IV` environment variables. Notarization uses the `APPLE_ID` /
`APPLE_APP_SPECIFIC_PASSWORD` GitHub secrets plus `APPLE_TEAM_ID`.

A Developer ID certificate is issued to a team, not to an application, so the
**same certificate can sign any number of apps**. Reuse means decrypting the same
`.p12` and notarizing with the same Apple account.

Caveats:

- **Publisher identity.** The signed app is presented as published by the
  certificate's organisation (Ultimate Gadget Laboratories Kft.). If Monda
  Commander is distributed under a different name or as a personal project, that
  is a branding/legal decision, and the cert should belong to whoever distributes
  the app.
- **Entitlements must be re-reviewed.** Agent's `entitlements.mac.plist` carries
  `com.apple.security.device.usb` (for the UHK keyboard), which Monda Commander
  does not need — drop it. Monda Commander likely *does* need the other four
  (`allow-jit`, `allow-unsigned-executable-memory`, `allow-dyld-environment-variables`,
  `disable-library-validation`) for Electron, node-pty and Monaco's workers. Copy
  the file, then tailor it.
- **Secrets live in CI**, not the repo. Reuse means copying the GitHub secrets
  into the new repository — better as organisation-level secrets shared by both.

### Windows

Agent signs through **Azure Key Vault / Trusted Signing** (`AZURE_KEY_VAULT_*`
secrets), with `publisherName: 'ULTIMATE GADGET LABORATORIES KFT.'`, not a `.pfx`
in the repo. Key Vault certificates are likewise organisation-scoped, so the same
credential can sign Monda Commander — provided it is the same legal entity — and
needs the same Azure secrets.

### Summary

| Platform | Credential | App-scoped? | Reusable | Watch out for |
|---|---|---|---|---|
| macOS | Developer ID cert (encrypted `.p12`) + Apple ID | no (team-scoped) | yes | publisher identity; entitlements (drop USB) |
| Windows | Azure Key Vault cert | no (org-scoped) | yes | publisher name; Azure secrets in the new CI |

### The nine secrets

`gh secret list -R UltimateHackingKeyboard/agent` shows exactly these, and they
are the set `mondalaci/monda-commander` needs (values cannot be read, so each has
to be re-entered — `gh secret set <NAME> -R mondalaci/monda-commander` prompts for
the value without it touching a shell history):

| Secret | For |
|---|---|
| `CERT_KEY`, `CERT_IV` | decrypting `scripts/certs/mac-cert.p12.enc` |
| `APPLE_ID`, `APPLE_ID_PASS` | notarization (`APPLE_APP_SPECIFIC_PASSWORD` in the env) |
| `AZURE_KEY_VAULT_URL` | Windows signing, and the switch that enables it |
| `AZURE_KEY_VAULT_CLIENT_ID`, `AZURE_KEY_VAULT_TENANT_ID`, `AZURE_KEY_VAULT_SECRET`, `AZURE_KEY_VAULT_CERTIFICATE` | Windows signing |

`APPLE_TEAM_ID` is written in the workflow rather than stored, because it is not
a secret (it is in every signed app).

