/**
 * Extensions a pane will play in its status bar, mapped to the MIME type its
 * stream must carry. Only containers Chromium's audio stack decodes are listed,
 * so a name here is a file the element can play as it stands — no transcoding
 * step, no external player. A container Chromium has nothing for (an AIFF, a
 * WMA) stays an ordinary file, and Enter opens it with the system's own player.
 */
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  wave: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  weba: 'audio/webm',
  flac: 'audio/flac'
}

function extensionOf(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot <= 0 || dot === lower.length - 1) return null
  return lower.slice(dot + 1)
}

/**
 * The MIME type for a name Chromium can play as audio on its own, or null.
 * Shared so the renderer decides what to play with the same map main serves by
 * — a mismatch would mean a status bar asking for a stream main then refuses.
 */
export function audioMimeFor(name: string): string | null {
  const extension = extensionOf(name)
  return extension === null ? null : (AUDIO_MIME[extension] ?? null)
}
