import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import * as TuiAdapter from '../src/profiles/tui.ts'
import * as WebAdapter from '../src/profiles/web.ts'

describe('optional front-door adapters', () => {
  it('activates both adapter entries without either front-door service', async () => {
    const ctx = new Context()
    ctx.provide('remoteSshManager', {} as never)

    const web = ctx.plugin(WebAdapter)
    const tui = ctx.plugin(TuiAdapter)
    await web.await()
    await tui.await()
    expect(ctx.get('webServer')).toBeUndefined()
    expect(ctx.get('tuiWorkspaces')).toBeUndefined()

    await ctx.fiber.dispose()
  })

  it('registers the TUI provider when its generic registry appears later', async () => {
    const ctx = new Context()
    const providerRegistrations: unknown[] = []
    ctx.provide('remoteSshManager', {
      snapshot: () => ({ workspaces: [] }),
    } as never)
    await ctx.plugin(TuiAdapter)

    ctx.provide('tuiWorkspaces', {
      register: (provider: unknown) => {
        providerRegistrations.push(provider)
        return () => {}
      },
    } as never)
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(providerRegistrations).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
