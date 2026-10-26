import { execFile } from 'node:child_process'
import { watch as watchPath, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ipcMain, webContents } from 'electron'
import type { FsError, GitChangeEvent, GitStatus, Result } from '@shared/types'
import { parseStatus } from '../gitStatus'

/**
 * Git is asked, not reimplemented. `status` is index-parse, tree-walk and lstat
 * work that git does in C with the index v4 format, `core.untrackedCache` and
 * `core.fsmonitor` behind it — measured against `isomorphic-git` on this machine
 * the binary answers in 10ms where the JavaScript one takes 380ms on the same
 * 9,409-file work tree, and the gap widens on a repository where the user has
 * enabled those caches. Forking it also costs 0.7ms, which is not what a status
 * read is spending its time on, and it keeps the answer git's own: renames are
 * detected, conflicts have a vocabulary, worktrees and submodules are understood,
 * and every one of those stays right as the user's git, gitattributes and
 * configuration change. Nothing here needs a native module either, so no
 * `electron-rebuild` and no second libgit2 in the package.
 */
const GIT = process.env['MC_GIT'] ?? 'git'

/** How long a single git call may take before it is killed, in milliseconds. */
const TIMEOUT_MS = 5000

/**
 * `execFile`'s default ceiling is 1 MiB, and a status read is exactly the call
 * that outgrows it: a work tree with tens of thousands of changed paths prints
 * far more than that, and the read would fail with `ENOBUFS` rather than
 * truncate. 64 MiB is far past any plausible listing.
 */
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * A status read must not write to the repository it is reading. Without this git
 * refreshes the index in place as a side effect, which races the user's own git
 * and every editor open on the same work tree — and rewrites the very file our
 * watcher is watching, for a notification about nothing. `LC_ALL=C` keeps the
 * header lines parseable; `GIT_TERMINAL_PROMPT` keeps a credential prompt from
 * ever holding a call open.
 */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C'
}

// git reads a repository out of any of these if the shell that launched the app
// happened to have one set — and `npm run dev` is launched from a shell — which
// would quietly make every pane report that one repository's status. The
// directory each call is pointed at is the only thing meant to decide.
delete GIT_ENV['GIT_DIR']
delete GIT_ENV['GIT_WORK_TREE']
delete GIT_ENV['GIT_INDEX_FILE']
delete GIT_ENV['GIT_COMMON_DIR']

const STATUS_ARGS = [
  '--no-optional-locks',
  'status',
  '--porcelain=v2',
  '--branch',
  // A wholly untracked directory is reported as one `/`-suffixed entry rather
  // than as each file inside it: cheaper, and the listing rolls it up as a folder
  // anyway. A directory that holds tracked files still lists them individually,
  // which is what a row marker needs.
  '--untracked-files=normal',
  '-z'
]

const REPO_ARGS = [
  'rev-parse',
  '--show-toplevel',
  '--absolute-git-dir',
  '--path-format=absolute',
  '--git-common-dir'
]

const run = promisify(execFile)

async function git(args: string[]): Promise<string> {
  const { stdout } = await run(GIT, args, {
    env: GIT_ENV,
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    encoding: 'utf8'
  })
  return stdout
}

/**
 * Whether a `git` binary can be run at all, asked once and remembered. A machine
 * without git is not an error to report — the panes simply show no mark, the way
 * a machine without ffmpeg has no transcode.
 */
let availableProbe: Promise<boolean> | null = null

function gitAvailable(): Promise<boolean> {
  availableProbe ??= git(['--version']).then(
    () => true,
    () => false
  )
  return availableProbe
}

function notARepo(): Result<GitStatus> {
  return { ok: false, error: { code: 'ENOTREPO', message: 'Not a git repository' } }
}

function toGitError(error: unknown): FsError {
  const err = error as { code?: number | string; message?: string }
  // `execFile` reports a non-zero exit as a numeric `code`, and git exits 128
  // with "not a git repository" for the one failure that is not a failure.
  if (err.code === 128) return { code: 'ENOTREPO', message: 'Not a git repository' }
  if (typeof err.code === 'string') {
    return { code: err.code, message: err.message ?? 'git failed' }
  }
  return { code: 'EGIT', message: err.message ?? 'git failed' }
}

interface RepoInfo {
  root: string
  /** This work tree's own git directory: the one holding its `index` and `HEAD`. */
  gitDir: string
  /** The shared one, where `refs` live — the same directory outside a worktree. */
  commonDir: string
}

/**
 * Which work tree a directory belongs to, remembered per directory. Only the
 * positive answers are cached: "not a repository" is re-asked every time, so a
 * `git init` behind the app's back is noticed on the next listing rather than
 * being denied for as long as the app runs. A positive answer cannot go stale in
 * a way that matters — a work tree's root is not a thing that moves.
 */
const repos = new Map<string, RepoInfo>()

async function resolveRepo(dir: string): Promise<RepoInfo | null> {
  const cached = repos.get(dir)
  if (cached !== undefined) return cached

  try {
    const stdout = await git(['-C', dir, ...REPO_ARGS])
    const [root, gitDir, commonDir] = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (!root || !gitDir) return null

    const info: RepoInfo = { root, gitDir, commonDir: commonDir || gitDir }
    repos.set(dir, info)
    return info
  } catch {
    return null
  }
}

/**
 * A read a moment ago is worth reusing: both panes refresh together, and a
 * directory change reaches the renderer twice (once as the listing's own
 * notification, once as git's), so the same repository would otherwise be read
 * two or three times to answer the same question. The window is short enough
 * that nothing a user can see is stale behind it, and every write we hear about
 * drops the entry outright.
 */
const FRESH_MS = 200

const statusCache = new Map<string, { at: number; result: Result<GitStatus> }>()
const statusInFlight = new Map<string, Promise<Result<GitStatus>>>()

async function readStatus(repo: RepoInfo): Promise<Result<GitStatus>> {
  try {
    const stdout = await git(['-C', repo.root, ...STATUS_ARGS])
    const result: Result<GitStatus> = { ok: true, data: parseStatus(stdout, repo.root) }
    statusCache.set(repo.root, { at: Date.now(), result })
    return result
  } catch (error) {
    return { ok: false, error: toGitError(error) }
  }
}

async function statusFor(dir: string): Promise<Result<GitStatus>> {
  if (!(await gitAvailable())) return notARepo()

  const repo = await resolveRepo(dir)
  if (!repo) return notARepo()

  const cached = statusCache.get(repo.root)
  if (cached !== undefined && Date.now() - cached.at < FRESH_MS) return cached.result

  // Two panes asking at once share one status read rather than starting two.
  const inFlight = statusInFlight.get(repo.root)
  if (inFlight !== undefined) return inFlight

  const promise = readStatus(repo).finally(() => statusInFlight.delete(repo.root))
  statusInFlight.set(repo.root, promise)
  return promise
}

/**
 * The debounce the directory watch uses, to the same purpose: one action — a
 * `git switch`, which rewrites the index, HEAD and half the work tree — is a
 * burst of events, and each notification costs a status read.
 */
const DEBOUNCE_MS = 200
const MAX_WAIT_MS = 750

interface RepoWatch {
  watchers: FSWatcher[]
  /** Per-webContents subscription count, exactly as the directory watch has. */
  refs: Map<number, number>
}

const watchedRepos = new Map<string, RepoWatch>()
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; startedAt: number }>()
const hooked = new Set<number>()

function closeRepo(root: string): void {
  const entry = watchedRepos.get(root)
  if (!entry) return
  watchedRepos.delete(root)

  const timer = pending.get(root)
  if (timer !== undefined) {
    clearTimeout(timer.timer)
    pending.delete(root)
  }

  for (const watcher of entry.watchers) {
    try {
      watcher.close()
    } catch {
      // Already closed.
    }
  }
}

function notify(root: string): void {
  const entry = watchedRepos.get(root)
  if (!entry) return

  const payload: GitChangeEvent = { root }
  for (const id of entry.refs.keys()) {
    const target = webContents.fromId(id)
    if (target && !target.isDestroyed()) target.send('git:changed', payload)
  }
}

function fire(root: string): void {
  pending.delete(root)
  notify(root)
}

function scheduleNotify(root: string): void {
  const now = Date.now()
  const existing = pending.get(root)

  if (existing) {
    clearTimeout(existing.timer)
    const elapsed = now - existing.startedAt
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - elapsed))
    existing.timer = setTimeout(() => fire(root), delay)
    return
  }

  pending.set(root, { startedAt: now, timer: setTimeout(() => fire(root), DEBOUNCE_MS) })
}

function watchTargets(repo: RepoInfo): string[] {
  // The work tree's own git directory carries `index` and `HEAD`, which is what a
  // stage, a commit and a checkout touch; the shared one carries the refs, and
  // `refs/heads` is where a branch ref is rewritten without either of those
  // moving. Watching a directory is not recursive, so each is named.
  return [...new Set([repo.gitDir, repo.commonDir, join(repo.commonDir, 'refs', 'heads')])]
}

function addRepoRef(root: string, repo: RepoInfo, owner: number): void {
  let entry = watchedRepos.get(root)

  if (!entry) {
    const watchers: FSWatcher[] = []
    for (const target of watchTargets(repo)) {
      try {
        watchers.push(watchPath(target, { persistent: false }, () => scheduleNotify(root)))
      } catch {
        // A directory that is not there is simply not watched; the panes still
        // read the status they asked for.
      }
    }
    if (watchers.length === 0) return

    entry = { watchers, refs: new Map() }
    watchedRepos.set(root, entry)
  }

  entry.refs.set(owner, (entry.refs.get(owner) ?? 0) + 1)
}

function releaseRepoRef(root: string, owner: number): void {
  const entry = watchedRepos.get(root)
  if (!entry) return

  const count = (entry.refs.get(owner) ?? 0) - 1
  if (count > 0) entry.refs.set(owner, count)
  else entry.refs.delete(owner)

  if (entry.refs.size === 0) closeRepo(root)
}

function hookOwner(owner: number): void {
  if (hooked.has(owner)) return
  const target = webContents.fromId(owner)
  if (!target) return

  hooked.add(owner)
  target.once('destroyed', () => {
    hooked.delete(owner)
    for (const root of [...watchedRepos.keys()]) {
      const entry = watchedRepos.get(root)
      if (!entry || !entry.refs.has(owner)) continue
      entry.refs.delete(owner)
      if (entry.refs.size === 0) closeRepo(root)
    }
  })
}

/**
 * A directory the app already watches changed on disk, and it is inside a known
 * work tree — so that repository's answer is now wrong, whether or not the pane
 * looking at it is the pane that changed. The cache entry goes, and every pane
 * watching that work tree is told, which is what keeps the *other* pane's markers
 * honest when a file is edited in one of them.
 */
export function noteDirectoryChanged(dir: string): void {
  const repo = repos.get(dir)
  if (!repo) return

  statusCache.delete(repo.root)
  scheduleNotify(repo.root)
}

export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_event, dir: string): Promise<Result<GitStatus>> => {
    if (typeof dir !== 'string' || dir.length === 0) return Promise.resolve(notARepo())
    return statusFor(dir)
  })

  ipcMain.handle('git:watch', async (event, root: string) => {
    if (typeof root !== 'string' || root.length === 0) return
    if (!(await gitAvailable())) return
    const repo = await resolveRepo(root)
    if (!repo) return
    hookOwner(event.sender.id)
    addRepoRef(repo.root, repo, event.sender.id)
  })

  ipcMain.handle('git:unwatch', async (event, root: string) => {
    if (typeof root !== 'string' || root.length === 0) return
    const repo = await resolveRepo(root)
    if (!repo) return
    releaseRepoRef(repo.root, event.sender.id)
  })
}

export function closeAllGitWatchers(): void {
  for (const root of [...watchedRepos.keys()]) closeRepo(root)
}
