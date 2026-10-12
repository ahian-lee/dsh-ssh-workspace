import { AhpErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol'
import { RpcError } from '@microsoft/agent-host-protocol/client'
import { describe, expect, it } from 'vitest'
import {
  ahpProtocolMismatch,
  DSH_AHP_PROTOCOL_VERSIONS,
  formatAhpProtocolMismatch,
  VALIDATED_FORWARD_PROTOCOL_VERSIONS,
} from '../src/transport/ahp-compat.ts'

describe('AHP compatibility policy', () => {
  it('combines SDK-declared and explicitly validated forward protocols without duplicates', () => {
    expect(DSH_AHP_PROTOCOL_VERSIONS[0]).toBe(VALIDATED_FORWARD_PROTOCOL_VERSIONS[0])
    expect(DSH_AHP_PROTOCOL_VERSIONS).toEqual([...new Set(DSH_AHP_PROTOCOL_VERSIONS)])
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) expect(DSH_AHP_PROTOCOL_VERSIONS).toContain(version)
  })

  it('extracts the server compatibility range from a negotiation rejection', () => {
    const error = new RpcError(AhpErrorCodes.UnsupportedProtocolVersion, 'incompatible', {
      supportedVersions: ['^0.9.0'],
    })
    const mismatch = ahpProtocolMismatch(error)
    expect(mismatch?.serverVersions).toEqual(['^0.9.0'])
    expect(formatAhpProtocolMismatch(mismatch!)).toContain('^0.9.0')
  })
})
