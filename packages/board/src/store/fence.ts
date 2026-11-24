/**
 * Serializes grant and invite appends with staged writes that depend on them.
 * All writers must share this store's fence. It does not lock a SQLite file
 * against other store objects or processes.
 */
export type AccessFence = {
  access<T>(write: () => Promise<T>): Promise<T>
  guarded<T>(read: () => Promise<number>, expected: number, write: () => Promise<T>): Promise<T>
}

export function createAccessFence(): AccessFence {
  let tail = Promise.resolve()
  function access<T>(write: () => Promise<T>): Promise<T> {
    const result = tail.then(write)
    tail = result.then(() => {}, () => {})
    return result
  }
  return {
    access,
    guarded: (read, expected, write) => access(async () => {
      // Position reads never take the lock. Only the appends need to hold it.
      if (await read() !== expected)
        throw Object.assign(new Error('access moved on while a write read it'), { code: 'LAST_INDEX_MISMATCH' })
      return write()
    }),
  }
}
