// Modified by ahian-lee for dsh-ssh-workspace; see NOTICE and CHANGELOG.md.
export type ChannelMethodOverride = (
  delegate: Record<PropertyKey, unknown>,
  ...args: unknown[]
) => unknown

/**
 * Identity-stable proxy for React/useSyncExternalStore consumers. Switching
 * the delegate rebinds subscriptions and emits one invalidation without
 * remounting the terminal UI.
 */
export class SwitchableChannel {
  readonly proxy: object

  private delegate: Record<PropertyKey, unknown>
  private readonly local: Record<PropertyKey, unknown>
  private readonly overrides: Readonly<Record<string, ChannelMethodOverride>>
  private readonly listeners = new Set<() => void>()
  private unsubscribeDelegate: (() => void) | undefined
  private readonly methodCache = new Map<PropertyKey, unknown>()

  constructor(local: object, overrides: Readonly<Record<string, ChannelMethodOverride>> = {}) {
    this.local = local as Record<PropertyKey, unknown>
    this.delegate = this.local
    this.overrides = overrides
    const subscribe = (listener: () => void): (() => void) => this.subscribe(listener)
    this.proxy = new Proxy({}, {
      get: (_target, property) => {
        if (property === 'subscribe') return subscribe
        const override = typeof property === 'string' ? this.overrides[property] : undefined
        if (override !== undefined) {
          let cached = this.methodCache.get(property)
          if (cached === undefined) {
            cached = (...args: unknown[]) => override(this.delegate, ...args)
            this.methodCache.set(property, cached)
          }
          return cached
        }
        const value = Reflect.get(this.delegate, property, this.delegate)
        if (typeof value !== 'function') return value
        let cached = this.methodCache.get(property)
        if (cached === undefined) {
          cached = (...args: unknown[]) => {
            const current = Reflect.get(this.delegate, property, this.delegate)
            if (typeof current !== 'function') throw new TypeError(`channel member ${String(property)} is not callable`)
            return Reflect.apply(current, this.delegate, args)
          }
          this.methodCache.set(property, cached)
        }
        return cached
      },
      set: (_target, property, value) => Reflect.set(this.delegate, property, value, this.delegate),
      has: (_target, property) => property === 'subscribe' || Reflect.has(this.delegate, property),
      ownKeys: () => Reflect.ownKeys(this.delegate),
      getOwnPropertyDescriptor: (_target, property) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(this.delegate, property)
        return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
      },
    })
  }

  get current(): object {
    return this.delegate
  }

  get localChannel(): object {
    return this.local
  }

  switchTo(channel: object): void {
    const next = channel as Record<PropertyKey, unknown>
    if (next === this.delegate) return
    this.unsubscribeDelegate?.()
    this.unsubscribeDelegate = undefined
    this.delegate = next
    this.methodCache.clear()
    this.bindDelegate()
    this.emit()
  }

  restoreLocal(): void {
    this.switchTo(this.local)
  }

  dispose(): void {
    this.unsubscribeDelegate?.()
    this.unsubscribeDelegate = undefined
    this.listeners.clear()
    this.methodCache.clear()
  }

  private subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    this.bindDelegate()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unsubscribeDelegate?.()
        this.unsubscribeDelegate = undefined
      }
    }
  }

  private bindDelegate(): void {
    if (this.unsubscribeDelegate !== undefined || this.listeners.size === 0) return
    const subscribe = Reflect.get(this.delegate, 'subscribe', this.delegate)
    if (typeof subscribe !== 'function') return
    const dispose = Reflect.apply(subscribe, this.delegate, [() => this.emit()]) as unknown
    if (typeof dispose === 'function') this.unsubscribeDelegate = dispose as () => void
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
