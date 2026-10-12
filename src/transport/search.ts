// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { registerHooks } from 'node:module'
import { posix } from 'node:path'
import type { LoadFnOutput, ModuleSource } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { RemoteSshManager } from '../routing/manager.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteSshSearchHook: object
  }
}

const SEARCH_PACKAGE = '@deepseek-ai/dsh-tool-fs-search'
const HOOK_SYMBOL_NAME = 'dsh-ssh-workspace.search-path-parser'
const HOOK_SYMBOL = Symbol.for(HOOK_SYMBOL_NAME)
const FUNCTION_START = /function toWorkdirRelative\(path,\s*workdir\)\s*\{/
const FUNCTION_HOOK = `\n\tconst remotePath = globalThis[Symbol.for(${JSON.stringify(HOOK_SYMBOL_NAME)})]?.(path, workdir);\n\tif (remotePath !== void 0) return remotePath;`

type SearchPathHook = (path: string, workdir: string) => string | undefined
type HookGlobal = typeof globalThis & { [HOOK_SYMBOL]?: SearchPathHook }

export const name = 'dsh-ssh-workspace-search'
export const inject = ['remoteSshManager', 'loader']

/** Inject one remote-aware branch into the stock parser before its module loads. */
export function apply(ctx: Context): void {
  const target = globalThis as HookGlobal
  const previous = target[HOOK_SYMBOL]
  const hook: SearchPathHook = (path, workdir) => remoteAbsolutePath(ctx.remoteSshManager, path, workdir)
  target[HOOK_SYMBOL] = hook

  const moduleHooks = registerHooks({
    load(url, context, nextLoad): LoadFnOutput {
      const loaded = nextLoad(url, context)
      if (!isSearchParserModule(url) || loaded.source === undefined) return loaded
      return { ...loaded, source: injectSearchPathHook(sourceText(loaded.source)) }
    },
  })
  for (const url of ctx.loader.internal?.loadCache.keys() ?? []) {
    if (!isSearchPackageModule(url)) continue
    ctx.loader.internal?.loadCache.delete(url)
  }
  ctx.provide('remoteSshSearchHook', {})

  ctx.effect(() => () => {
    moduleHooks.deregister()
    if (target[HOOK_SYMBOL] !== hook) return
    if (previous === undefined) delete target[HOOK_SYMBOL]
    else target[HOOK_SYMBOL] = previous
  }, 'Remote SSH search parser hook')
}

/** Source transform is deliberately one insertion at the stock path parser entry. */
export function injectSearchPathHook(source: string): string {
  if (source.includes(HOOK_SYMBOL_NAME)) return source
  if (!FUNCTION_START.test(source)) {
    throw new Error('dsh-ssh-workspace: stock search path parser signature changed')
  }
  return source.replace(FUNCTION_START, match => match + FUNCTION_HOOK)
}

/** Return an absolute POSIX path for remote results; leave local paths to stock behavior. */
export function remoteAbsolutePath(
  manager: RemoteSshManager,
  path: string,
  workdir: string,
): string | undefined {
  const route = manager.route(undefined, workdir)
  if (route.kind !== 'remote') return undefined
  const remoteWorkdir = route.mapper.toRemotePath(workdir, route.aliasPath)
  return posix.resolve(remoteWorkdir, path)
}

function sourceText(source: ModuleSource): string {
  if (typeof source === 'string') return source
  if (source instanceof ArrayBuffer) return Buffer.from(source).toString('utf8')
  return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
}

function normalizedModuleUrl(url: string): string {
  const decoded = decodeURIComponent(url).replaceAll('\\', '/')
  const query = decoded.indexOf('?')
  return query === -1 ? decoded : decoded.slice(0, query)
}

function isSearchParserModule(url: string): boolean {
  const decoded = normalizedModuleUrl(url)
  return decoded.endsWith(`/${SEARCH_PACKAGE}/lib/index.js`)
    || decoded.endsWith('/packages/fs/tool-fs-search/lib/index.js')
    || decoded.endsWith('/packages/fs/tool-fs-search/src/search-core.ts')
}

function isSearchPackageModule(url: string): boolean {
  const decoded = normalizedModuleUrl(url)
  return decoded.includes(`/${SEARCH_PACKAGE}/`)
    || decoded.includes('/packages/fs/tool-fs-search/')
}

export default apply
