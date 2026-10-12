// Derived from Yan-Zero/dsh-remote-ssh; modified by ahian-lee. See NOTICE.
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'

const url = process.argv[2]
if (!url) throw new Error('usage: node scripts/probe.mjs <ws-url>')
const transport = await WebSocketTransport.connect(url)
const client = new AhpClient(transport, { requestTimeoutMs: 10_000 })
client.connect()
try {
  const init = await client.initialize({
    clientId: 'dsh-ssh-workspace-probe',
    protocolVersions: ['0.8.0', '0.7.0', '0.6.0', '0.5.0', '0.4.0'],
    initialSubscriptions: ['ahp-root://'],
  })
  console.log(JSON.stringify({
    protocolVersion: init.protocolVersion,
    defaultDirectory: init.defaultDirectory,
    snapshots: init.snapshots.map(snapshot => snapshot.resource),
  }, null, 2))
  if (init.defaultDirectory) {
    await client.resourceRequest({ uri: init.defaultDirectory, read: true, write: true })
    const resolved = await client.resourceResolve({ uri: init.defaultDirectory })
    console.log(JSON.stringify({ resolved }, null, 2))
  }
} finally {
  await client.shutdown()
}
