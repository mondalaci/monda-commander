/**
 * The name a bundled external tool is looked up under on `PATH`.
 *
 * Windows launches a program by its extension, and Node's `execFile` without a
 * shell does not apply `PATHEXT`, so the default names carry `.exe` there — a
 * bare `7z` would be reported missing even when `7z.exe` is installed. An
 * `MC_*` override is taken exactly as given: it is a name or path the user
 * chose, and it is theirs to get right.
 */
export function externalBinary(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name
}
