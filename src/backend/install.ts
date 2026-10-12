// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
/** Versioned dsh-host payload discovery and the POSIX SSH bootstrap protocol. */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT_FILES = [
  'package.json',
  'cordis.patch.yml',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'INSTALL.md',
  'scripts/install.sh',
] as const

export interface DshHostPayloadFile {
  path: string
  mode: '644' | '755'
  data: Buffer
}

export interface DshHostPayload {
  version: string
  hash: string
  root: string
  files: readonly DshHostPayloadFile[]
  /** Deterministic npm-compatible package archive transferred over SSH. */
  archive: Buffer
}

/** Locate an installed dsh-host package, with sibling checkouts as a dev fallback. */
export function resolveDshHostPackageRoot(explicitRoot?: string): string {
  const candidates: string[] = []
  if (explicitRoot !== undefined) candidates.push(resolve(explicitRoot))
  try {
    candidates.push(dirname(fileURLToPath(import.meta.resolve('dsh-host/package.json'))))
  } catch {}
  const here = dirname(fileURLToPath(import.meta.url))
  candidates.push(resolve(here, '..', '..', 'dsh-host'))
  candidates.push(resolve(here, '..', '..', 'host'))
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'package.json')) && existsSync(resolve(candidate, 'lib', 'index.js'))) return candidate
  }
  throw new Error('dsh-ssh-workspace: dsh-host deployment payload is unavailable; install the dsh-host package beside dsh-ssh-workspace')
}

/** Read the exact built package files transferred during automatic installation. */
export function loadDshHostPayload(explicitRoot?: string): DshHostPayload {
  const root = resolveDshHostPackageRoot(explicitRoot)
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { name?: string; version?: string }
  if (manifest.name !== 'dsh-host' || typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`dsh-ssh-workspace: invalid dsh-host package at ${JSON.stringify(root)}`)
  }
  const paths = [...ROOT_FILES.filter(path => existsSync(resolve(root, path))), ...walkFiles(resolve(root, 'lib')).map(path => relative(root, path))]
    .map(toPosixPath)
    .sort()
  const files = paths.map(path => ({
    path,
    mode: path === 'scripts/install.sh' ? '755' as const : '644' as const,
    data: readFileSync(resolve(root, ...path.split('/'))),
  }))
  for (const required of ['package.json', 'cordis.patch.yml', 'scripts/install.sh', 'lib/index.js', 'lib/server.js', 'lib/startup.js']) {
    if (!files.some(file => file.path === required)) throw new Error(`dsh-ssh-workspace: dsh-host payload is missing ${required}`)
  }
  const archive = gzipSync(createPackageTar(files), { level: 9 })
  // RFC 1952's OS byte is informational. Normalize it so Windows, Linux, and
  // macOS clients derive the same deployment hash for identical package bytes.
  archive[9] = 255
  const hash = createHash('sha256').update(archive).digest('hex')
  return { version: manifest.version, hash, root, files, archive }
}

/** Encode the npm package for the already-open SSH stdin stream. */
export function encodePayloadArchive(payload: DshHostPayload): string {
  return `DSH_REMOTE_BACKEND_ARCHIVE ${payload.archive.toString('base64')}\n`
}

/** Build the remote installer/launcher that never uses VS Code Server or AHP. */
export function buildDshBackendCommand(remotePort: number): string {
  if (!Number.isSafeInteger(remotePort) || remotePort < 0 || remotePort > 65535) {
    throw new Error(`dsh-ssh-workspace: invalid Backend port ${String(remotePort)}`)
  }
  return [
    'set -eu',
    'install_root="$HOME/.dsh-host"',
    'state_dir="$install_root/remote-ssh"',
    'hash_file="$state_dir/package-hash"',
    'lock_dir="$state_dir/install.lock"',
    'mkdir -p "$state_dir"',
    'chmod 700 "$install_root" "$state_dir" 2>/dev/null || true',
    'IFS=" " read -r attach_tag requested_hash attach_extra',
    'if [ "$attach_tag" != DSH_REMOTE_BACKEND_ATTACH ] || [ -n "${attach_extra:-}" ]; then printf \'dsh-ssh-workspace: invalid Backend attach request\\n\' >&2; exit 2; fi',
    'case "$requested_hash" in *[!0-9a-f]*|"") printf \'dsh-ssh-workspace: invalid Backend package hash\\n\' >&2; exit 2;; esac',
    'lock_owned=0',
    'upload_dir=""',
    'release_lock() { if [ "$lock_owned" = 1 ]; then rm -f "$lock_dir/owner"; rmdir "$lock_dir" 2>/dev/null || true; lock_owned=0; fi; }',
    'cleanup() { if [ -n "$upload_dir" ]; then rm -rf "$upload_dir"; fi; release_lock; }',
    'trap cleanup EXIT HUP INT TERM',
    'lock_attempts=0',
    'while ! mkdir "$lock_dir" 2>/dev/null; do',
    '  if [ "$lock_attempts" = 0 ]; then printf \'DSH_REMOTE_BACKEND_PROGRESS waiting-host\\n\'; fi',
    '  lock_owner="$(cat "$lock_dir/owner" 2>/dev/null || true)"',
    '  case "$lock_owner" in *[!0-9]*|"") if [ "$lock_attempts" -lt 5 ]; then lock_live=1; else lock_live=0; fi;; *) if kill -0 "$lock_owner" 2>/dev/null; then lock_live=1; else lock_live=0; fi;; esac',
    '  if [ "$lock_live" = 0 ]; then rm -f "$lock_dir/owner"; rmdir "$lock_dir" 2>/dev/null || true; continue; fi',
    '  lock_attempts=$((lock_attempts + 1))',
    '  if [ "$lock_attempts" -ge 600 ]; then printf \'dsh-ssh-workspace: timed out waiting for Host installation lock\\n\' >&2; exit 1; fi',
    '  sleep 1',
    'done',
    'lock_owned=1',
    'printf \'%s\\n\' "$$" > "$lock_dir/owner"',
    'chmod 600 "$lock_dir/owner"',
    'printf \'DSH_REMOTE_BACKEND_PROGRESS checking-host\\n\'',
    'dsh_host="$install_root/bin/dsh-host"',
    'replace_backend=0',
    'current_hash="$(cat "$hash_file" 2>/dev/null || true)"',
    'if [ -x "$dsh_host" ] && [ "$current_hash" = "$requested_hash" ]; then',
    '  printf \'DSH_REMOTE_BACKEND_PROGRESS reusing-host\\n\'',
    '  printf \'DSH_REMOTE_BACKEND_PAYLOAD CURRENT\\n\'',
    'else',
    '  command -v base64 >/dev/null 2>&1 || { printf \'dsh-ssh-workspace: base64 is required to install dsh-host\\n\' >&2; exit 127; }',
    '  upload_dir="$(mktemp -d "$state_dir/upload.XXXXXX")"',
    '  printf \'DSH_REMOTE_BACKEND_PAYLOAD REQUIRED\\n\'',
    '  IFS=" " read -r archive_kind encoded_archive archive_extra',
    '  if [ "$archive_kind" != DSH_REMOTE_BACKEND_ARCHIVE ] || [ -n "${archive_extra:-}" ]; then printf \'dsh-ssh-workspace: invalid Backend package record\\n\' >&2; exit 2; fi',
    '  package_archive="$upload_dir/dsh-host.tgz"',
    '  printf \'%s\' "$encoded_archive" | base64 -d > "$package_archive"',
    '  actual_hash="$(sha256sum "$package_archive" | awk \'{ print $1 }\')"',
    '  [ "$actual_hash" = "$requested_hash" ] || { printf \'dsh-ssh-workspace: Backend package hash mismatch\\n\' >&2; exit 2; }',
    '  printf \'DSH_REMOTE_BACKEND_PROGRESS installing-host\\n\'',
    '  install_script="$upload_dir/install.sh"',
    '  tar -xOzf "$package_archive" package/scripts/install.sh > "$install_script"',
    '  chmod 700 "$install_script"',
    '  DSH_HOST_START=0 DSH_HOST_PACKAGE="$package_archive" sh "$install_script"',
    '  rm -rf "$upload_dir"',
    '  upload_dir=""',
    '  replace_backend=1',
    'fi',
    'if [ ! -x "$dsh_host" ]; then printf \'dsh-ssh-workspace: dsh-host installation did not create a launcher\\n\' >&2; exit 127; fi',
    'endpoint_dir="$install_root/instances/dsh-ssh-workspace"',
    'endpoint="$endpoint_dir/endpoint.json"',
    'mkdir -p "$endpoint_dir"',
    'printf \'DSH_REMOTE_BACKEND_PROGRESS starting-host\\n\'',
    `if [ "$replace_backend" = 1 ]; then "$dsh_host" --instance dsh-ssh-workspace --port ${String(remotePort)} --endpoint-file "$endpoint" --startup-timeout 600 --replace; else "$dsh_host" --instance dsh-ssh-workspace --port ${String(remotePort)} --endpoint-file "$endpoint" --startup-timeout 600; fi`,
    'if [ "$replace_backend" = 1 ]; then',
    '  hash_tmp="$state_dir/package-hash.$$"',
    '  printf \'%s\\n\' "$requested_hash" > "$hash_tmp"',
    '  chmod 600 "$hash_tmp"',
    '  mv "$hash_tmp" "$hash_file"',
    'fi',
    'dsh_node="$install_root/runtime/current/bin/node"',
    'if [ ! -x "$dsh_node" ]; then printf \'dsh-ssh-workspace: private Node.js for dsh-host is missing\\n\' >&2; exit 127; fi',
    'ready_port="$("$dsh_node" -e \'const fs=require("fs");const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(String(e.port))\' "$endpoint")"',
    'case "$ready_port" in *[!0-9]*|"") printf \'dsh-ssh-workspace: invalid dsh-host endpoint port\\n\' >&2; exit 1;; esac',
    'token_file="$("$dsh_node" -e \'const fs=require("fs");const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(e.tokenFile)\' "$endpoint")"',
    'token="$(tr -d \'\\r\\n\' < "$token_file")"',
    'case "$token" in *[!0-9a-fA-F]*|"") printf \'dsh-ssh-workspace: invalid dsh-host connection token\\n\' >&2; exit 1;; esac',
    'release_lock',
    'printf \'DSH_REMOTE_BACKEND_READY %s %s\\n\' "$ready_port" "$token"',
    'while IFS= read -r dsh_control; do [ "$dsh_control" = stop ] && exit 0; done',
  ].join('\n')
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(path))
    else if (entry.isFile() && statSync(path).isFile()) files.push(path)
  }
  return files
}

function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}

function createPackageTar(files: readonly DshHostPayloadFile[]): Buffer {
  const records: Buffer[] = []
  for (const file of files) {
    const name = `package/${file.path}`
    if (Buffer.byteLength(name) > 100) throw new Error(`dsh-ssh-workspace: dsh-host package path is too long for ustar: ${name}`)
    const header = Buffer.alloc(512)
    writeTarString(header, 0, 100, name)
    writeTarOctal(header, 100, 8, Number.parseInt(file.mode, 8))
    writeTarOctal(header, 108, 8, 0)
    writeTarOctal(header, 116, 8, 0)
    writeTarOctal(header, 124, 12, file.data.length)
    writeTarOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    writeTarString(header, 257, 6, 'ustar')
    writeTarString(header, 263, 2, '00')
    writeTarString(header, 265, 32, 'dsh-host')
    writeTarString(header, 297, 32, 'dsh-host')
    const checksum = header.reduce((sum, value) => sum + value, 0)
    const checksumText = checksum.toString(8).padStart(6, '0')
    header.write(checksumText, 148, 6, 'ascii')
    header[154] = 0
    header[155] = 0x20
    records.push(header, file.data)
    const remainder = file.data.length % 512
    if (remainder !== 0) records.push(Buffer.alloc(512 - remainder))
  }
  records.push(Buffer.alloc(1024))
  return Buffer.concat(records)
}

function writeTarString(target: Buffer, offset: number, length: number, value: string): void {
  const data = Buffer.from(value, 'utf8')
  if (data.length > length) throw new Error(`dsh-ssh-workspace: tar field is too long: ${value}`)
  data.copy(target, offset)
}

function writeTarOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  if (text.length >= length) throw new Error(`dsh-ssh-workspace: tar value exceeds field: ${String(value)}`)
  target.write(text, offset, length - 1, 'ascii')
  target[offset + length - 1] = 0
}
