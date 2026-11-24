import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { parseConfigText } from '../config/load.ts'
import { validRepo } from './types.ts'

export type WorkItemLinks = {
  id: string
  repo: string
  branches: string[]
  prs: number[]
  trackerItems: { source: 'github' | 'linear' | 'beads'; ref: string }[]
}

export interface WorkItems {
  get(id: string): Promise<WorkItemLinks | undefined>
}

export class WorkItemsFileError extends Error {
  readonly unreadable: boolean

  constructor(unreadable = false) {
    super(unreadable ? 'cannot read work file' : 'invalid work file')
    this.unreadable = unreadable
  }
}

function hasFields(value: unknown, ...fields: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
}

const nonempty = (value: unknown): value is string => typeof value === 'string' &&
  value.trim().length > 0 && value.isWellFormed() && !/[\x00-\x1f\x7f-\x9f]/u.test(value)

const validBranch = (value: unknown): boolean => nonempty(value) &&
  value !== 'HEAD' && !value.startsWith('-') && !value.endsWith('.') &&
  !/[ ~^:?*\[\\]|\.\.|@\{/u.test(value) &&
  value.split('/').every((part) => part && !part.startsWith('.') && !part.endsWith('.lock'))

function validItem(item: unknown): item is WorkItemLinks {
  return hasFields(item, 'id', 'repo', 'branches', 'prs', 'trackerItems') &&
    nonempty(item.id) && typeof item.repo === 'string' && validRepo(item.repo) &&
    Array.isArray(item.branches) && item.branches.every(validBranch) &&
    Array.isArray(item.prs) && item.prs.every((pr) => Number.isSafeInteger(pr) && pr > 0) &&
    Array.isArray(item.trackerItems) && item.trackerItems.every((link: unknown) =>
      hasFields(link, 'source', 'ref') &&
      (link.source === 'github' || link.source === 'linear' || link.source === 'beads') && nonempty(link.ref))
}

const maxWorkBytes = 1024 * 1024

async function readWorkFile(path: string): Promise<string> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > maxWorkBytes) throw new WorkItemsFileError()
    // Do not follow a replacement symlink or block on a replacement FIFO.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await file.stat()
      if (!opened.isFile() || opened.size > maxWorkBytes) throw new WorkItemsFileError()
      const buffer = Buffer.alloc(maxWorkBytes + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
        if (bytesRead === 0) return buffer.toString('utf8', 0, size)
        size += bytesRead
      }
      throw new WorkItemsFileError()
    } finally {
      await file.close()
    }
  } catch (error) {
    if (error instanceof WorkItemsFileError) throw error
    throw new WorkItemsFileError(true)
  }
}

// Local stub until the WP-401 work board supplies explicit links.
export function workItemsFromFile(path: string): WorkItems {
  return {
    async get(id) {
      const text = await readWorkFile(path)
      let data: unknown
      try {
        data = JSON.parse(text) // Keep the work file JSON-only.
        parseConfigText(text) // JSON.parse alone silently accepts duplicate keys.
      } catch { throw new WorkItemsFileError() }
      if (!hasFields(data, 'items') || !Array.isArray(data.items)) throw new WorkItemsFileError()
      const items = new Map<string, WorkItemLinks>()
      for (const item of data.items) {
        if (!validItem(item) || items.has(item.id.toLowerCase())) throw new WorkItemsFileError()
        items.set(item.id.toLowerCase(), item)
      }
      return items.get(id.toLowerCase())
    },
  }
}
