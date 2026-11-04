import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { RelayProgress } from '@shared/api'
import type { Target } from '@shared/target'
import { RELAY_VERSION, relayBinaryPath } from './paths'

/**
 * A remote target is only useful if its relay is there and the same version as
 * the app's, so the connection bootstraps it: one ssh round trip reads `$HOME`
 * and checks the installed relay's `--version`, and a mismatch or a missing file
 * uploads the built binary to `~/.monda/monda-relay` before the real connection
 * opens.
 *
 * A failure is never hidden: an unreachable host, a refused key or a read-only
 * home comes back as the ssh error, which the pane shows, rather than as a
 * connection that silently has nothing in it.
 */

/**
 * The short reason ssh failed, not its whole transcript. ssh repeats its askpass
 * noise and "Permission denied, please try again." several times before the line
 * that actually says why, so the raw stderr is a mouthful; this names the cause in
 * a few words.
 */
function sshReason(stderr: string): string {
  const text = stderr.replace(/\s+/g, ' ').trim()
  if (/permission denied/i.test(text)) return 'Permission denied — the key was rejected'
  if (/could not resolve hostname/i.test(text)) return 'Could not resolve the hostname'
  if (/connection refused/i.test(text)) return 'Connection refused'
  if (/host key verification failed/i.test(text)) return 'Host key verification failed'
  if (/timed out|timeout/i.test(text)) return 'Timed out'
  if (text === '') return 'ssh failed'
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function sshArgs(target: Target, command: string): string[] {
  const port = target.port ? ['-p', String(target.port)] : []
  return [
    '-T',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    ...port,
    `${target.user}@${target.host}`,
    command
  ]
}

interface SshResult {
  code: number
  stdout: string
  stderr: string
}

function sshRun(target: Target, command: string, stdin?: Buffer): Promise<SshResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', sshArgs(target, command), {
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
    if (stdin && child.stdin) {
      child.stdin.write(stdin)
      child.stdin.end()
    }
  })
}

export async function ensureRemoteRelay(
  target: Target,
  onProgress?: (progress: RelayProgress) => void
): Promise<void> {
  const binary = relayBinaryPath()
  if (!existsSync(binary)) {
    throw new Error('The relay binary is missing — run `npm run build:relay`')
  }

  onProgress?.({ phase: `Contacting ${target.host}…`, value: 0.3 })
  const home = await sshRun(target, 'printf %s "$HOME"')
  if (home.code !== 0 || home.stdout.trim() === '') {
    throw new Error(`Could not reach ${target.user}@${target.host}: ${sshReason(home.stderr)}`)
  }
  const remotePath =
    target.relayPath && target.relayPath.startsWith('/')
      ? target.relayPath
      : `${home.stdout.trim()}/.monda/monda-relay`

  const check = await sshRun(target, `${quote(remotePath)} --version`)
  if (check.code === 0 && check.stdout.includes(`version ${RELAY_VERSION}`)) return

  onProgress?.({ phase: 'Installing relay…', value: 0.55 })
  const dir = remotePath.slice(0, remotePath.lastIndexOf('/'))
  const quotedPath = quote(remotePath)
  const upload = `mkdir -p ${quote(dir)} && cat > ${quotedPath}.tmp && chmod +x ${quotedPath}.tmp && mv ${quotedPath}.tmp ${quotedPath}`
  const result = await sshRun(target, upload, readFileSync(binary))
  if (result.code !== 0) {
    throw new Error(
      `Could not install the relay on ${target.user}@${target.host}: ${sshReason(result.stderr)}`
    )
  }
}
