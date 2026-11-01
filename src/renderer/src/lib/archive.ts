import { ref } from 'vue'

/**
 * Whether main can read archives. Asked once at startup, like the transcoding
 * answer, so a cursor landing on a `.zip` already knows whether Enter means
 * "enter it" or "open it with the system". False until the answer is in — which
 * is also the answer without 7z — so the fallback is always safe.
 */
export const archiveSupported = ref(false)

export async function loadArchiveSupport(): Promise<void> {
  archiveSupported.value = await window.mc.fs.canArchive()
}
