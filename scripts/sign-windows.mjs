import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Windows code signing, through Azure Key Vault — the same service and the same
 * credentials as the UHK Agent release (`~/projects/agent`), so no new
 * certificate has to be bought or kept.
 *
 * electron-builder calls this once per executable and installer it produces
 * (`win.signtoolOptions.sign` names this file), handing each one's path in
 * `configuration.path`. It is deliberately a no-op when the credentials are
 * absent: a fork, a pull request from a fork, or a machine without the secrets
 * then builds an *unsigned* installer — which Windows will warn about — rather
 * than failing the build outright.
 *
 * Signing is serialized and spaced out. AzureSignTool is flaky when several
 * invocations overlap, so the signer runs one file at a time with a gap between
 * them (the same throttle the Agent release uses, and for the same reason).
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/** The gap between two signing invocations, in milliseconds. */
const SIGN_GAP_MS = 2000

/** How many times a failed signature is retried before the build is failed. */
const SIGN_ATTEMPTS = 5

/**
 * Where AzureSignTool is. An `AZURE_SIGN_TOOL` path wins; otherwise a copy kept
 * beside this file (as the Agent repo does) is used, and failing that the
 * `azuresigntool` dotnet tool on `PATH` — which is what CI installs
 * (`dotnet tool install --global AzureSignTool`).
 */
function signToolPath() {
  const configured = process.env.AZURE_SIGN_TOOL
  if (configured) return configured
  const local = path.join(here, 'AzureSignTool.exe')
  if (existsSync(local)) return local
  return 'azuresigntool'
}

/** Serializes signing: each file waits for the previous one plus the gap. */
let queue = Promise.resolve()

function enqueue(task) {
  const run = queue.then(async () => {
    await task()
    await new Promise((resolve) => setTimeout(resolve, SIGN_GAP_MS))
  })
  // A failed signature must not poison the chain for the files that follow.
  queue = run.catch(() => {})
  return run
}

function azureSign(filePath) {
  const {
    AZURE_KEY_VAULT_TENANT_ID,
    AZURE_KEY_VAULT_CLIENT_ID,
    AZURE_KEY_VAULT_SECRET,
    AZURE_KEY_VAULT_URL,
    AZURE_KEY_VAULT_CERTIFICATE
  } = process.env

  const command = [
    `"${signToolPath()}"`,
    'sign',
    `-kvu ${AZURE_KEY_VAULT_URL}`,
    `-kvi ${AZURE_KEY_VAULT_CLIENT_ID}`,
    `-kvt ${AZURE_KEY_VAULT_TENANT_ID}`,
    `-kvs ${AZURE_KEY_VAULT_SECRET}`,
    `-kvc ${AZURE_KEY_VAULT_CERTIFICATE}`,
    '-tr http://timestamp.identrust.com',
    '-v',
    `"${filePath}"`
  ].join(' ')

  return new Promise((resolve, reject) => {
    exec(command, { shell: 'powershell.exe' }, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      if (stderr) {
        reject(new Error(String(stderr)))
        return
      }
      if (String(stdout).includes('Signing completed successfully')) {
        resolve()
        return
      }
      reject(new Error(String(stdout)))
    })
  })
}

export default async function sign(configuration) {
  if (!process.env.AZURE_KEY_VAULT_URL) {
    console.log('Skipping Windows code signing: AZURE_KEY_VAULT_URL is not set')
    return
  }

  const filePath = configuration.path
  await enqueue(async () => {
    let lastError
    for (let attempt = 1; attempt <= SIGN_ATTEMPTS; attempt += 1) {
      try {
        console.log(`Signing ${filePath} (attempt ${attempt}/${SIGN_ATTEMPTS})`)
        await azureSign(filePath)
        return
      } catch (error) {
        lastError = error
        console.error(`Signing ${filePath} failed:`, error)
        await new Promise((resolve) => setTimeout(resolve, SIGN_GAP_MS))
      }
    }
    throw lastError
  })
}
