// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
import { AhpErrorCodes, SUPPORTED_PROTOCOL_VERSIONS } from '@microsoft/agent-host-protocol'
import { RpcError } from '@microsoft/agent-host-protocol/client'

/**
 * Protocols newer than the published client package that this plugin has
 * exercised end-to-end for the Resource and Terminal surface it consumes.
 *
 * Keep this list deliberately small. A future protocol is added only after
 * the transparent filesystem, subprocess and PTY integration suite passes
 * against a real Agent Host. Once the SDK publishes that protocol, the Set
 * below de-duplicates it automatically.
 */
export const VALIDATED_FORWARD_PROTOCOL_VERSIONS = ['0.8.0'] as const

/** Single source of truth for every initialize handshake and diagnostic. */
export const DSH_AHP_PROTOCOL_VERSIONS = Object.freeze([
  ...new Set([
    ...VALIDATED_FORWARD_PROTOCOL_VERSIONS,
    ...SUPPORTED_PROTOCOL_VERSIONS,
  ]),
])

export interface AhpProtocolMismatch {
  offeredVersions: readonly string[]
  serverVersions: string[]
}

/** Extract a negotiated-version rejection without coupling callers to RPC internals. */
export function ahpProtocolMismatch(
  error: unknown,
  offeredVersions: readonly string[] = DSH_AHP_PROTOCOL_VERSIONS,
): AhpProtocolMismatch | undefined {
  if (!(error instanceof RpcError) || error.code !== AhpErrorCodes.UnsupportedProtocolVersion) return undefined
  const data = typeof error.data === 'object' && error.data !== null
    ? error.data as { supportedVersions?: unknown }
    : undefined
  const serverVersions = Array.isArray(data?.supportedVersions)
    ? data.supportedVersions.filter((value): value is string => typeof value === 'string')
    : []
  return { offeredVersions, serverVersions }
}

export function formatAhpProtocolMismatch(mismatch: AhpProtocolMismatch): string {
  const offered = mismatch.offeredVersions.join(', ') || 'none'
  const server = mismatch.serverVersions.join(', ') || 'unknown'
  return `client offered [${offered}], Agent Host accepts [${server}]`
}
