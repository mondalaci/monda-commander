import type * as MonacoApi from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/languages/features/css/css.worker?worker'
import htmlWorker from 'monaco-editor/languages/features/html/html.worker?worker'
import jsonWorker from 'monaco-editor/languages/features/json/json.worker?worker'
import tsWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker'

let pending: Promise<typeof MonacoApi> | null = null

/**
 * Load Monaco on first use. The editor and its bundled language services are a
 * large chunk that the panes never need, so it is imported dynamically rather
 * than at startup, and the promise is cached so opening a second file reuses
 * the same module instance.
 *
 * Monaco asks `MonacoEnvironment.getWorker` for every worker it needs — the
 * base editor worker plus one per rich language — and falls back to its own
 * `new URL(...)` construction only when that is absent. Answering it here with
 * Vite's `?worker` imports is what makes the workers bundle and load correctly
 * (the internal URLs point into `node_modules` and would not survive the
 * build). It must be installed before the first editor is created, which is why
 * it is set as part of resolving the import.
 */
export function loadMonaco(): Promise<typeof MonacoApi> {
  if (pending) return pending

  pending = import('monaco-editor').then((monaco) => {
    const environment = {
      getWorker(_moduleId: string, label: string): Worker {
        switch (label) {
          case 'json':
            return new jsonWorker()
          case 'css':
          case 'scss':
          case 'less':
            return new cssWorker()
          case 'html':
          case 'handlebars':
          case 'razor':
            return new htmlWorker()
          case 'typescript':
          case 'javascript':
            return new tsWorker()
          default:
            return new editorWorker()
        }
      }
    }
    ;(self as unknown as { MonacoEnvironment: typeof environment }).MonacoEnvironment = environment
    return monaco
  })

  return pending
}

const PLAINTEXT = 'plaintext'

/** The last segment of a path, lowercased. */
function baseName(target: string): string {
  return (target.split(/[\\/]/).pop() ?? '').toLowerCase()
}

/**
 * Best-effort language id for a filename, matching the `filenames` and
 * `extensions` the registered languages declare, or null when nothing claims
 * the name. Monaco would not guess on its own when the language is left
 * unspecified, and a wrong id would colour the file with the wrong tokenizer.
 */
function languageForName(monaco: typeof MonacoApi, target: string): string | null {
  const name = baseName(target)
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''

  for (const language of monaco.languages.getLanguages()) {
    if (language.filenames?.some((candidate) => candidate.toLowerCase() === name)) {
      return language.id
    }
    if (extension && language.extensions?.some((candidate) => candidate.toLowerCase() === extension)) {
      return language.id
    }
  }

  return null
}

/** Whether Monaco currently registers a language with this id. */
function isLanguageRegistered(monaco: typeof MonacoApi, id: string): boolean {
  return monaco.languages.getLanguages().some((language) => language.id === id)
}

/**
 * Names a tokenizer genuinely fits that Monaco's own registrations miss. The
 * shell is the one that matters most: Monaco declares `.sh` and `.bash` and no
 * filename at all, so every rc file a shell reads by name — the file a user is
 * most likely to open — would otherwise be left grey. Only names whose language
 * is certain are here: `.vimrc` and `.inputrc` are not shell, and Monaco has no
 * tokenizer for vim or readline anyway, so they stay plaintext rather than
 * borrow a neighbour. `.gitconfig` and `.editorconfig` are absent because
 * Monaco's own ini registration already claims them, and `.screenrc` is absent
 * because screen's config language is not the shell's.
 *
 * A key is matched against the basename in three shapes, which is what lets one
 * table hold dotfiles, extensions and compound names at once (see
 * `curatedNameMatches`):
 *
 *   - whole:        `bashrc`  matches `bashrc`;
 *   - dotted tail:  `.bashrc` matches `bash.bashrc` (`/etc/bash.bashrc` is both
 *                   a distribution's name for the file and a compound one), and
 *                   `.zsh` matches `script.zsh`, so a dotted key reads as an
 *                   extension Monaco does not declare;
 *   - bare head:    `dockerfile` matches `Dockerfile.dev`.
 *
 * Each rc name is listed twice on purpose — the dot is how a home directory
 * writes it, and its absence is how a distribution ships it (`/etc/profile`,
 * `/etc/zsh/zshrc`). Which name belongs to which shell is taken from GitHub's
 * Linguist, which is the reference list for it.
 */
const FILENAME_LANGUAGES: Record<string, string> = {
  // Shells read these by name.
  '.bashrc': 'shell',
  bashrc: 'shell',
  '.bash_profile': 'shell',
  bash_profile: 'shell',
  '.bash_login': 'shell',
  bash_login: 'shell',
  '.bash_logout': 'shell',
  bash_logout: 'shell',
  '.bash_aliases': 'shell',
  bash_aliases: 'shell',
  '.bash_completion': 'shell',
  bash_completion: 'shell',
  '.profile': 'shell',
  profile: 'shell',
  '.zshrc': 'shell',
  zshrc: 'shell',
  '.zprofile': 'shell',
  zprofile: 'shell',
  '.zshenv': 'shell',
  zshenv: 'shell',
  '.zlogin': 'shell',
  zlogin: 'shell',
  '.zlogout': 'shell',
  zlogout: 'shell',
  '.kshrc': 'shell',
  kshrc: 'shell',
  '.cshrc': 'shell',
  cshrc: 'shell',
  '.tcshrc': 'shell',
  tcshrc: 'shell',
  '.login': 'shell',
  '.logout': 'shell',
  // `login` and `logout` are deliberately not listed bare the way Linguist lists
  // them: the bare-head rule would then claim `/etc/login.defs`, which is not
  // shell.
  '.xinitrc': 'shell',
  xinitrc: 'shell',
  '.xsession': 'shell',
  xsession: 'shell',
  '.xprofile': 'shell',
  '.envrc': 'shell',
  '.tmux.conf': 'shell',
  'tmux.conf': 'shell',
  // Names that are extensions in all but spelling: Monaco's shell declares
  // `.sh` and `.bash` and stops there.
  '.zsh': 'shell',
  '.ksh': 'shell',
  '.bats': 'shell',
  '.sh.in': 'shell',
  '.zsh-theme': 'shell',
  // Scripts that are shell by construction.
  pkgbuild: 'shell',
  gradlew: 'shell',
  mvnw: 'shell',
  // INI-shaped configs Monaco's ini registration does not name.
  '.npmrc': 'ini',
  '.yarnrc': 'ini',
  '.flake8': 'ini',
  '.pylintrc': 'ini',
  pylintrc: 'ini',
  '.coveragerc': 'ini',
  '.buckconfig': 'ini',
  '.gitreview': 'ini',
  '.cfg': 'ini',
  '.cnf': 'ini',
  hosts: 'ini',
  // Systemd units and desktop entries are `[Section]` and `Key=Value`, which is
  // exactly what the ini tokenizer reads.
  '.service': 'ini',
  '.socket': 'ini',
  '.timer': 'ini',
  '.mount': 'ini',
  '.target': 'ini',
  '.network': 'ini',
  '.desktop': 'ini',
  '.url': 'ini',
  // Extensionless prose GitHub already renders as markdown.
  readme: 'markdown',
  license: 'markdown',
  copying: 'markdown',
  changelog: 'markdown',
  contributing: 'markdown',
  authors: 'markdown',
  news: 'markdown',
  notice: 'markdown',
  todo: 'markdown',
  install: 'markdown',
  // Container manifests Monaco claims only as the bare name `Dockerfile` and as
  // the `.dockerfile` extension.
  dockerfile: 'dockerfile',
  containerfile: 'dockerfile'
}

/**
 * The curated table's entries longest key first, so the most specific one wins a
 * compound name: `foo.zsh-theme` is `.zsh-theme` rather than the `.zsh` inside it.
 */
const CURATED_ENTRIES = Object.entries(FILENAME_LANGUAGES).sort(([a], [b]) => b.length - a.length)

/**
 * Whether a basename is claimed by a curated key, in any of the table's three
 * shapes: the whole name, the dotted tail of a compound name (a key that begins
 * with a dot also matches an extension's place, so `.zsh` claims `run.zsh`), or
 * the bare head of one (`Dockerfile` claims `Dockerfile.dev`).
 */
function curatedNameMatches(name: string, key: string): boolean {
  if (name === key) return true
  return key.startsWith('.') ? name.endsWith(key) : name.startsWith(`${key}.`)
}

/**
 * The language a curated name asks for, or null when nothing in the table
 * claims it. A key whose language this Monaco no longer ships is skipped rather
 * than returned, and a shorter key is still tried after it.
 */
function languageForCuratedName(monaco: typeof MonacoApi, target: string): string | null {
  const name = baseName(target)
  for (const [key, id] of CURATED_ENTRIES) {
    if (!curatedNameMatches(name, key)) continue
    if (isLanguageRegistered(monaco, id)) return id
  }
  return null
}

/**
 * How the interpreters a shebang names map onto the languages Monaco has. Only
 * names with a tokenizer that actually fits are here: an interpreter Monaco
 * cannot colour (`awk`, `expect`, `fish`) is left plaintext rather than handed
 * to whichever tokenizer looks closest, for the same reason a wrong extension
 * would be — a script full of the wrong colours reads worse than none.
 */
const INTERPRETER_LANGUAGES: Record<string, string> = {
  sh: 'shell',
  bash: 'shell',
  dash: 'shell',
  ash: 'shell',
  ksh: 'shell',
  mksh: 'shell',
  pdksh: 'shell',
  zsh: 'shell',
  python: 'python',
  ruby: 'ruby',
  perl: 'perl',
  php: 'php',
  lua: 'lua',
  node: 'javascript',
  nodejs: 'javascript',
  deno: 'javascript',
  bun: 'javascript',
  'ts-node': 'typescript',
  tsx: 'typescript',
  tclsh: 'tcl',
  wish: 'tcl',
  rscript: 'r',
  julia: 'julia',
  swift: 'swift',
  elixir: 'elixir',
  powershell: 'powershell',
  pwsh: 'powershell',
  coffee: 'coffee',
  scala: 'scala'
}

/** The last segment of a path, lowercased, without a Windows `.exe`. */
function commandName(word: string): string {
  const base = (word.split(/[\\/]/).pop() ?? '').toLowerCase()
  return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/** The `env` options whose value is the word after them rather than attached. */
const ENV_VALUE_OPTIONS = new Set(['-u', '-C', '--unset', '--chdir', '--argv0'])

/**
 * The interpreter a script's first line names, if it opens with a shebang —
 * `python` for `#!/usr/bin/env python3`. The `/usr/bin/env` hop is followed
 * (its own options skipped, the assignments it accepts as well, so
 * `#!/usr/bin/env VAR=x python3` still reaches python), since a script that does
 * not want to hard-code a path is written that way, and a version suffix is
 * dropped (`python3.11` is python, `php8` is php).
 */
function shebangInterpreter(text: string): string | null {
  // Only the first line matters, and only its head: a shebang is short, and the
  // kernel reads no more of the file than this either. A byte-order mark is not
  // part of it, but it is what a file saved that way actually starts with.
  const head = text.slice(0, 256).replace(/^\uFEFF/, '')
  const first = head.split('\n', 1)[0]?.trim() ?? ''
  if (!first.startsWith('#!')) return null

  const words = first.slice(2).trim().split(/\s+/).filter(Boolean)
  let index = 0
  if (commandName(words[0] ?? '') === 'env') {
    index = 1
    let word = words[index]
    while (word !== undefined) {
      // `env` takes options and then `VAR=value` assignments before the program,
      // and a shebang may use either: `#!/usr/bin/env VAR=x python3`,
      // `#!/usr/bin/env -S deno run`. A lone option (`-i`), one carrying its
      // value (`--unset=Foo`) and an assignment are one word; `-u VAR` is two.
      if (ENV_VALUE_OPTIONS.has(word)) index += 2
      else if (word.startsWith('-') || word.includes('=')) index += 1
      else break
      word = words[index]
    }
  }

  const command = commandName(words[index] ?? '')
  return command ? command.replace(/\d+(\.\d+)*$/, '') : null
}

/**
 * The language a shebang asks for, or null when it names nothing Monaco can
 * colour. Checked against the registered languages as well as the table: an id
 * a future Monaco no longer ships would be plaintext rather than a model with a
 * language that does not exist.
 */
function languageForShebang(monaco: typeof MonacoApi, text: string): string | null {
  const interpreter = shebangInterpreter(text)
  if (interpreter === null) return null

  const id = INTERPRETER_LANGUAGES[interpreter]
  if (id === undefined) return null

  return isLanguageRegistered(monaco, id) ? id : null
}

/**
 * Best-effort language id for the file about to be shown: its name first, and
 * its shebang when the name says nothing.
 *
 * An extension or a known filename is the deliberate signal — `foo.py` is
 * python however it starts — whether Monaco declares it or the curated table
 * does (`.bashrc` is shell, and `bash.bashrc` is too, since a compound name is
 * matched at its dot boundary), and a name another language claims keeps
 * winning. The fallback is no signal at all, and the file it leaves grey is
 * exactly the extensionless script (`manage`, `configure`, a `run` in a crate),
 * whose first line states its language outright. Since the viewer is handed the
 * file's text anyway, that line costs nothing to read, and this can only add
 * colour.
 */
export function languageFor(
  monaco: typeof MonacoApi,
  target: string,
  text = ''
): string {
  const named = languageForName(monaco, target)
  if (named !== null && named !== PLAINTEXT) return named
  return languageForCuratedName(monaco, target) ?? languageForShebang(monaco, text) ?? PLAINTEXT
}
