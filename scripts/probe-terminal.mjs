import { randomUUID } from 'node:crypto'
import { ActionType } from '@microsoft/agent-host-protocol'
import { AhpClient } from '@microsoft/agent-host-protocol/client'
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws'

const url = process.argv[2]
const transport = await WebSocketTransport.connect(url)
const client = new AhpClient(transport, { requestTimeoutMs: 10_000 })
const clientId = 'dsh-terminal-probe'
const uri = `ahp-terminal:/${randomUUID()}`
client.connect()
await client.initialize({clientId, protocolVersions:['0.8.0'], initialSubscriptions:['ahp-root://']})
try {
  await client.request('createTerminal', {
    channel: uri,
    claim: {kind:'client', clientId},
    name: 'dsh probe',
    cwd: 'file:///e%3A/source/ai/dsh/remote-ssh',
    cols: 100,
    rows: 30,
  })
  const {result, subscription} = await client.subscribe(uri)
  console.log('SNAPSHOT', JSON.stringify(result.snapshot.state))
  client.dispatch(uri, {type: ActionType.TerminalInput, data: 'printf "DSH_AHP_HELLO\\n"\r'})
  const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exitCode = 2 }, 10_000)
  for await (const event of subscription) {
    if (event.type !== 'action') continue
    console.log('ACTION', JSON.stringify(event.params.action))
    const type = event.params.action.type
    if (type === ActionType.TerminalCommandFinished) break
  }
  clearTimeout(timeout)
  await subscription.close()
} finally {
  await client.request('disposeTerminal', {channel: uri}).catch(() => {})
  await client.shutdown()
}
