import { Context } from '@deepseek-ai/cordis'
import RemoteSshRuntime from '../lib/index.js'
import RemoteSshFileSystem from '../lib/fs.js'

const directUrl = process.argv[2]
const remoteWorkspace = process.argv[3]
if (!directUrl || !remoteWorkspace) {
  throw new Error('usage: node scripts/integration-live.mjs <ws-url> <remote-posix-workspace>')
}
const ctx = new Context()
await ctx.plugin(RemoteSshRuntime, {
  sshTarget: 'direct-test',
  remoteWorkspace,
  localWorkspace: new URL('../.tmp/local-alias', import.meta.url).pathname.replace(/^\/(.:)/, '$1'),
  remoteRuntimeRoot: `${remoteWorkspace}/.runtime`,
  directUrl,
})
await ctx.plugin(RemoteSshFileSystem, { diffBasisMaxBytes: 1024 * 1024, maxReadBytes: 1024 * 1024 })
try {
  const seed = await ctx.fs.resolve('seed.txt')
  const seedText = await ctx.fs.readText(seed)
  const target = await ctx.fs.resolve('created-by-ahp.txt')
  const created = await ctx.fs.writeText(target, 'alpha\n', { kind: 'createIfAbsent' })
  const edited = await ctx.fs.editText(target, {
    oldString: 'alpha', newString: 'beta', replaceAll: false,
  }, { version: created.version })
  console.log(JSON.stringify({
    protocolVersion: (await ctx.remoteSsh.getConnection()).protocolVersion,
    seedText,
    target: ctx.fs.processPath(target),
    edited: edited.after,
  }, null, 2))
} finally {
  await (await ctx.remoteSsh.getConnection()).client.shutdown()
}
