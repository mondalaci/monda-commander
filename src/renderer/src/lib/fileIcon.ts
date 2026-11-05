import type { PaneEntry } from '@renderer/composables/useDirectory'

export interface FileIcon {
  /** Inner markup for a 24x24 viewBox, drawn with the current color. */
  body: string
  color: string
  /** Solid fill instead of the default stroked outline. */
  filled?: boolean
}

const FILE_OUTLINE =
  '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'

const ICONS = {
  parent: {
    color: '#8a8a8a',
    body: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>'
  },
  folder: {
    color: '#519aba',
    filled: true,
    body: '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/>'
  },
  text: {
    color: '#b0b0b0',
    body: `${FILE_OUTLINE}<path d="M9 13h6"/><path d="M9 16.5h6"/>`
  },
  code: {
    color: '#e2c08d',
    body: '<path d="m8.5 8.5-4 3.5 4 3.5"/><path d="m15.5 8.5 4 3.5-4 3.5"/><path d="m13.5 6.5-3 11"/>'
  },
  image: {
    color: '#a074c4',
    body: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m21 15-4.5-4.5L5.5 20"/>'
  },
  audio: {
    color: '#ee8b54',
    body: '<path d="M9 17V6l10-2v11"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/>'
  },
  video: {
    color: '#e06c75',
    body: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9.5 5 2.5-5 2.5z"/>'
  },
  archive: {
    color: '#e2b93d',
    body: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>'
  },
  pdf: {
    color: '#e05252',
    body: `${FILE_OUTLINE}<path d="M8.5 17v-4.5h1.4a1.4 1.4 0 0 1 0 2.8H8.5"/><path d="M13.5 17v-4.5h1.2a2.25 2.25 0 0 1 0 4.5z"/>`
  },
  doc: {
    color: '#2b7cd3',
    body: `${FILE_OUTLINE}<path d="M9 12.5h6"/><path d="M9 15.5h4"/>`
  },
  sheet: {
    color: '#217346',
    body: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18"/><path d="M3 15h18"/><path d="M9.5 4v16"/><path d="M15 4v16"/>'
  },
  slides: {
    color: '#d24726',
    body: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4"/><path d="M8.5 20h7"/>'
  },
  markdown: {
    color: '#6a9fb5',
    body: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 15.5V9l3 4 3-4v6.5"/><path d="M17.5 9v6.5"/><path d="m15.5 13.5 2 2 2-2"/>'
  },
  json: {
    color: '#cbcb41',
    body: '<path d="M8 4c-1.8 0-2 1.4-2 2.5v2C6 9.6 5.5 10.5 4 10.5c1.5 0 2 .9 2 2v2c0 1.1.2 2.5 2 2.5"/><path d="M16 4c1.8 0 2 1.4 2 2.5v2c0 1.1.5 2 2 2-1.5 0-2 .9-2 2v2c0 1.1-.2 2.5-2 2.5"/>'
  },
  config: {
    color: '#9c859b',
    body: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>'
  },
  font: {
    color: '#e05252',
    body: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>'
  },
  exec: {
    color: '#d19a66',
    body: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"/>'
  },
  terminal: {
    color: '#89e051',
    body: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3"/><path d="M12.5 15H17"/>'
  },
  database: {
    color: '#a074c4',
    body: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>'
  },
  lock: {
    color: '#e2b93d',
    body: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>'
  },
  git: {
    color: '#f14e32',
    body: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 8.2v7.6"/><path d="M6 12a5 5 0 0 0 5 5h2a5 5 0 0 0 5-5v-.8"/>'
  },
  plug: {
    color: '#8a8a8a',
    body: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>'
  },
  device: {
    color: '#8a8a8a',
    body: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="8" cy="12" r="1.2"/><path d="M12 12h6"/>'
  },
  symlink: {
    color: '#1177bb',
    body: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="m9.5 15.5 5-5"/><path d="M12.5 10.5h2.5V13"/>'
  },
  threeD: {
    color: '#66c2cd',
    body: '<path d="M12 3 3 7.5v9L12 21l9-4.5v-9z"/><path d="M3 7.5 12 12l9-4.5"/><path d="M12 12v9"/>'
  },
  notebook: {
    color: '#eb9a4d',
    body: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8.5 3v18"/><path d="M12 8.5h5"/><path d="M12 12.5h5"/>'
  },
  book: {
    color: '#a9b665',
    body: '<path d="M12 6.5C10.5 5 8.5 4.5 4 4.5v13c4.5 0 6.5.5 8 2 1.5-1.5 3.5-2 8-2v-13c-4.5 0-6.5.5-8 2z"/><path d="M12 6.5v13"/>'
  },
  subtitle: {
    color: '#c9a26e',
    body: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M7 9.5h6"/><path d="M7 12.5h10"/><path d="M9 20.5l3-3.5"/>'
  },
  torrent: {
    color: '#4a9e5c',
    body: '<path d="M7 16a4 4 0 0 1 .8-7.9 5.5 5.5 0 0 1 10.4 1.4A3.5 3.5 0 0 1 17.5 16"/><path d="M12 11.5v8"/><path d="m9 16.5 3 3 3-3"/>'
  },
  calendar: {
    color: '#d16d9e',
    body: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18"/><path d="M8 3v4"/><path d="M16 3v4"/><circle cx="8" cy="14" r=".8"/><circle cx="12" cy="14" r=".8"/><circle cx="16" cy="14" r=".8"/>'
  },
  contact: {
    color: '#7aa2f7',
    body: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.5 16.5a4 4 0 0 1 7 0"/><path d="M14.5 10h3.5"/><path d="M14.5 13h3.5"/>'
  },
  diff: {
    color: '#7f849c',
    body: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 13v4"/><path d="M6 15h4"/><path d="M14 15h4"/>'
  }
} satisfies Record<string, FileIcon>

type IconName = keyof typeof ICONS

const EXTENSION_ICONS: Record<string, IconName> = {
  js: 'code',
  mjs: 'code',
  cjs: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  mts: 'code',
  cts: 'code',
  vue: 'code',
  svelte: 'code',
  py: 'code',
  pyw: 'code',
  rb: 'code',
  php: 'code',
  java: 'code',
  kt: 'code',
  kts: 'code',
  scala: 'code',
  groovy: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  cxx: 'code',
  hpp: 'code',
  hh: 'code',
  hxx: 'code',
  cs: 'code',
  go: 'code',
  rs: 'code',
  swift: 'code',
  dart: 'code',
  lua: 'code',
  pl: 'code',
  pm: 'code',
  r: 'code',
  html: 'code',
  htm: 'code',
  xhtml: 'code',
  xml: 'code',
  xsl: 'code',
  css: 'code',
  scss: 'code',
  sass: 'code',
  less: 'code',
  styl: 'code',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  ini: 'config',
  cfg: 'config',
  conf: 'config',
  properties: 'config',
  env: 'config',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  rst: 'markdown',
  txt: 'text',
  text: 'text',
  log: 'text',
  sh: 'terminal',
  bash: 'terminal',
  zsh: 'terminal',
  fish: 'terminal',
  ksh: 'terminal',
  bat: 'terminal',
  cmd: 'terminal',
  ps1: 'terminal',
  sql: 'database',
  db: 'database',
  sqlite: 'database',
  sqlite3: 'database',
  mdb: 'database',
  lock: 'lock',
  pem: 'lock',
  key: 'lock',
  crt: 'lock',
  cer: 'lock',
  pub: 'lock',
  asc: 'lock',
  gpg: 'lock',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  ico: 'image',
  tif: 'image',
  tiff: 'image',
  avif: 'image',
  heic: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  flac: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio',
  opus: 'audio',
  mp4: 'video',
  mkv: 'video',
  mov: 'video',
  avi: 'video',
  webm: 'video',
  wmv: 'video',
  flv: 'video',
  m4v: 'video',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  '7z': 'archive',
  rar: 'archive',
  lz: 'archive',
  lzma: 'archive',
  deb: 'archive',
  rpm: 'archive',
  jar: 'archive',
  war: 'archive',
  iso: 'archive',
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  rtf: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  ttf: 'font',
  otf: 'font',
  woff: 'font',
  woff2: 'font',
  eot: 'font',
  exe: 'exec',
  dll: 'exec',
  so: 'exec',
  o: 'exec',
  a: 'exec',
  bin: 'exec',
  dylib: 'exec',
  class: 'exec',
  pyc: 'exec',
  wasm: 'exec',
  stp: 'threeD',
  step: 'threeD',
  stpz: 'threeD',
  stl: 'threeD',
  fcstd: 'threeD',
  obj: 'threeD',
  mtl: 'threeD',
  iges: 'threeD',
  igs: 'threeD',
  fbx: 'threeD',
  dae: 'threeD',
  '3ds': 'threeD',
  blend: 'threeD',
  blend1: 'threeD',
  dwg: 'threeD',
  dxf: 'threeD',
  dwf: 'threeD',
  scad: 'threeD',
  '3mf': 'threeD',
  gltf: 'threeD',
  glb: 'threeD',
  ply: 'threeD',
  wrl: 'threeD',
  vrml: 'threeD',
  x3d: 'threeD',
  prt: 'threeD',
  sldprt: 'threeD',
  sldasm: 'threeD',
  catpart: 'threeD',
  catproduct: 'threeD',
  ipt: 'threeD',
  iam: 'threeD',
  f3d: 'threeD',
  skp: 'threeD',
  abc: 'threeD',
  amf: 'threeD',
  u3d: 'threeD',
  ipynb: 'notebook',
  qmd: 'notebook',
  rmd: 'notebook',
  nb: 'notebook',
  epub: 'book',
  mobi: 'book',
  azw: 'book',
  azw3: 'book',
  fb2: 'book',
  djvu: 'book',
  cbz: 'book',
  cbr: 'book',
  srt: 'subtitle',
  vtt: 'subtitle',
  ass: 'subtitle',
  ssa: 'subtitle',
  sub: 'subtitle',
  sbv: 'subtitle',
  torrent: 'torrent',
  ics: 'calendar',
  ical: 'calendar',
  vcf: 'contact',
  vcard: 'contact',
  diff: 'diff',
  patch: 'diff',
  zig: 'code',
  nim: 'code',
  sol: 'code',
  ex: 'code',
  exs: 'code',
  erl: 'code',
  hrl: 'code',
  clj: 'code',
  cljs: 'code',
  cljc: 'code',
  edn: 'code',
  fs: 'code',
  fsx: 'code',
  fsi: 'code',
  vb: 'code',
  pas: 'code',
  f90: 'code',
  f95: 'code',
  f03: 'code',
  asm: 'code',
  s: 'code',
  m: 'code',
  mm: 'code',
  tcl: 'code',
  awk: 'code',
  el: 'code',
  lisp: 'code',
  scm: 'code',
  rkt: 'code',
  hs: 'code',
  lhs: 'code',
  ml: 'code',
  mli: 'code',
  jl: 'code',
  cr: 'code',
  proto: 'code',
  graphql: 'code',
  gql: 'code',
  hbs: 'code',
  mustache: 'code',
  ejs: 'code',
  pug: 'code',
  jade: 'code',
  njk: 'code',
  tex: 'doc',
  latex: 'doc',
  bib: 'doc',
  sty: 'doc',
  cls: 'doc',
  info: 'doc',
  nix: 'config',
  tf: 'config',
  tfvars: 'config',
  hcl: 'config',
  cmake: 'config',
  gradle: 'config',
  bazel: 'config',
  bzl: 'config',
  mk: 'config',
  ttc: 'font',
  otc: 'font',
  aiff: 'audio',
  aif: 'audio',
  wma: 'audio',
  m4b: 'audio',
  oga: 'audio',
  cab: 'archive',
  ar: 'archive',
  cpio: 'archive',
  pak: 'archive',
  whl: 'archive',
  apk: 'archive',
  aar: 'archive',
  ear: 'archive',
  xpi: 'archive',
  crx: 'archive',
  ipa: 'archive',
  vsix: 'archive',
  nupkg: 'archive',
  msi: 'archive',
  dmg: 'archive',
  pkg: 'archive',
  snap: 'archive',
  appimage: 'archive',
  img: 'archive'
}

const FILENAME_ICONS: Record<string, IconName> = {
  dockerfile: 'config',
  'docker-compose.yml': 'config',
  '.dockerignore': 'config',
  makefile: 'config',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  'cargo.toml': 'config',
  'cargo.lock': 'lock',
  'go.mod': 'config',
  'go.sum': 'lock',
  'package-lock.json': 'lock',
  'yarn.lock': 'lock',
  'pnpm-lock.yaml': 'lock',
  license: 'lock',
  licence: 'lock',
  copying: 'lock',
  '.bashrc': 'config',
  '.zshrc': 'config',
  '.profile': 'config',
  '.bash_profile': 'config',
  '.inputrc': 'config',
  '.npmrc': 'config',
  '.editorconfig': 'config',
  '.prettierrc': 'config',
  'cmakelists.txt': 'config',
  gemfile: 'config',
  rakefile: 'config',
  procfile: 'config',
  vagrantfile: 'config',
  jenkinsfile: 'config',
  pkgbuild: 'config'
}

function iconNameFor(name: string): IconName | null {
  const lower = name.toLowerCase()

  const exact = FILENAME_ICONS[lower]
  if (exact) return exact

  if (lower === '.env' || lower.startsWith('.env.')) return 'config'

  const dot = lower.lastIndexOf('.')
  if (dot > 0 && dot < lower.length - 1) {
    const match = EXTENSION_ICONS[lower.slice(dot + 1)]
    if (match) return match
  }

  return null
}

function iconByName(name: string): FileIcon {
  const match = iconNameFor(name)
  return match ? ICONS[match] : ICONS.text
}

/**
 * Whether the table recognizes this name at all — its filename, or the text
 * after its last dot. An answer of `false` is not "a text file": it is a name
 * the table has nothing to say about, which is what a compiled binary with no
 * extension is (`lib/executable.ts` asks, to tell a program from a file of a
 * kind that is merely executable).
 */
export function isKnownName(name: string): boolean {
  return iconNameFor(name) !== null
}

export function iconForEntry(entry: PaneEntry): FileIcon {
  if (entry.isParent) return ICONS.parent

  switch (entry.kind) {
    case 'directory':
      return ICONS.folder
    case 'symlink':
      return ICONS.symlink
    case 'socket':
    case 'fifo':
      return ICONS.plug
    case 'device':
      return ICONS.device
    case 'unknown':
      return ICONS.text
    default:
      return iconByName(entry.name)
  }
}
