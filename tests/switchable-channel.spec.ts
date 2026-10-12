import { describe, expect, it, vi } from 'vitest'
import { SwitchableChannel } from '../src/tui/switchable-channel.ts'

function channel(id: string) {
  const listeners = new Set<() => void>()
  return {
    id,
    value: 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    bump() {
      this.value += 1
      for (const listener of listeners) listener()
      return this.value
    },
  }
}

describe('switchable TUI channel', () => {
  it('keeps one proxy identity while rebinding state and subscriptions', () => {
    const local = channel('local')
    const remote = channel('remote')
    const switched = new SwitchableChannel(local)
    const proxy = switched.proxy as typeof local
    const notify = vi.fn()
    const unsubscribe = proxy.subscribe(notify)

    expect(proxy.id).toBe('local')
    expect(proxy.bump()).toBe(1)
    expect(notify).toHaveBeenCalledTimes(1)

    switched.switchTo(remote)
    expect(proxy.id).toBe('remote')
    expect(notify).toHaveBeenCalledTimes(2)
    local.bump()
    expect(notify).toHaveBeenCalledTimes(2)
    remote.bump()
    expect(notify).toHaveBeenCalledTimes(3)

    switched.restoreLocal()
    expect(proxy.id).toBe('local')
    unsubscribe()
    switched.dispose()
  })

  it('can intercept a control method without changing ordinary delegation', async () => {
    const local = {
      id: 'local',
      subscribe: () => () => {},
      switchWorkspace: vi.fn(async (_target: unknown) => false),
    }
    const override = vi.fn(async (_target: unknown) => true)
    const switched = new SwitchableChannel(local, {
      switchWorkspace: (_delegate, target) => override(target),
    })
    const proxy = switched.proxy as typeof local

    await expect(proxy.switchWorkspace({ uri: 'remote' })).resolves.toBe(true)
    expect(override).toHaveBeenCalledWith({ uri: 'remote' })
    expect(local.switchWorkspace).not.toHaveBeenCalled()
  })
})
