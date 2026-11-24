#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Builds the Go relay into `resources/`. GOOS and GOARCH have no `go build`
 * flag — they are environment variables — and `VAR=value cmd` is not something
 * a Windows shell understands, so the cross-compiles live in one script rather
 * than in the npm scripts, which then read the same on every platform.
 *
 * The output names line up with what `electron-builder.yml` copies per platform
 * (`resources/monda-relay-<os>-<arch>`) and with what `relayBinaryPath()` looks
 * for in a dev run (`resources/monda-relay`). CGO is off: the relay's only
 * dependency, creack/pty, is pure Go on all three targets, so the cross-builds
 * need no C toolchain.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const relayDir = path.join(root, 'relay')
const outDir = path.join(root, 'resources')

const GOOS = { linux: 'linux', mac: 'darwin', win: 'windows' }
const GOARCH = { x64: 'amd64', arm64: 'arm64', ia32: '386' }

/** [target, arch, output name] */
const linux = [
  ['linux', 'x64', 'monda-relay-linux-x64'],
  ['linux', 'arm64', 'monda-relay-linux-arm64']
]
const mac = [
  ['mac', 'x64', 'monda-relay-mac-x64'],
  ['mac', 'arm64', 'monda-relay-mac-arm64']
]
const win = [['win', 'x64', 'monda-relay-win-x64']]

const hostTarget = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux'
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64'
const host = [[hostTarget, hostArch, process.platform === 'win32' ? 'monda-relay.exe' : 'monda-relay']]

const targets = { linux, mac, win, host, all: [...linux, ...mac, ...win] }

const which = process.argv[2] ?? 'host'
const list = targets[which]
if (!list) {
  console.error(`Unknown relay target "${which}" (expected ${Object.keys(targets).join(', ')})`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
for (const [os, arch, name] of list) {
  const result = spawnSync('go', ['build', '-o', path.join(outDir, name), '.'], {
    cwd: relayDir,
    stdio: 'inherit',
    env: { ...process.env, GOOS: GOOS[os], GOARCH: GOARCH[arch], CGO_ENABLED: '0' }
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  console.log(`built ${name} (${GOOS[os]}/${GOARCH[arch]})`)
}
