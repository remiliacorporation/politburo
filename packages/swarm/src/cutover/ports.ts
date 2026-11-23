export type Health = 'running' | 'stopped' | 'unknown'
export interface ProcessPort {
  start(tag: string): Promise<void>
  stop(tag: string): Promise<void>
  status(tag: string): Promise<Health>
}
export interface BridgePort {
  sync(tag: string): Promise<{ current: boolean; detail?: string }>
  status(tag: string): Promise<{ current: boolean; at?: string }>
}
export interface Ports { service: ProcessPort; oldLoop: ProcessPort; bridge: BridgePort; commandsLock?: string }
export interface Clock { now(): number }

export class CutoverError extends Error {
  readonly reason: string
  readonly headline: string
  constructor(reason: string, headline: string) {
    super(headline)
    this.reason = reason
    this.headline = headline
  }
}

export const currentTag = /^[a-z]{2,3}$/
export const newTag = /^[a-z]{3}$/
export function hasOnly(value: unknown, keys: string): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.split(' ').includes(key))
}
