import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'board')

export const INVITE_SECRET = /^vbi_[A-Za-z0-9_-]{43}$/
export const JOIN_TOKEN = /^vbj_[A-Za-z0-9_-]{43}$/

/** The complete board URL is the key, not just its host. Never use a credential over remote HTTP. */
export function canonicalJoinUrl(given: string): string | null {
  const url = given.trim()
  if (!/^https?:\/\/[^/]+/i.test(url) || /[\\?#\s\p{Cc}]/u.test(url) || url.split('/')[2]?.includes('@')) return null
  try {
    const parsed = new URL(url)
    const loopback = parsed.hostname === 'localhost' || parsed.hostname === '[::1]' || /^127\.(\d{1,3}\.){2}\d{1,3}$/.test(parsed.hostname)
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null
    return parsed.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

const joinedDir = () => join(configDir(), 'joined')
const joinedFile = (dir: string, url: string) => join(dir, `${createHash('sha256').update(url).digest('hex')}.json`)
const privateMode = (mode: number) => process.platform === 'win32' || (mode & 0o077) === 0

export async function savedJoinToken(given: string): Promise<string | null> {
  const url = canonicalJoinUrl(given)
  if (url === null) return null
  const dir = joinedDir()
  const file = joinedFile(dir, url)
  try {
    const directory = await lstat(dir)
    if (!directory.isDirectory() || !privateMode(directory.mode)) return null
    const info = await lstat(file)
    if (!info.isFile() || !privateMode(info.mode)) return null
    const saved = JSON.parse(await readFile(file, 'utf8')) as { url?: string; token?: unknown }
    return saved.url === url && typeof saved.token === 'string' && JOIN_TOKEN.test(saved.token) ? saved.token : null
  } catch {
    return null
  }
}

/** Stage in the private directory before consuming the invite. A failed save leaves any old token intact. */
export async function prepareJoinCredential(url: string) {
  const dir = joinedDir()
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || !privateMode(info.mode)) throw new Error('joined credential directory is not private')
  const temp = join(dir, `${randomUUID()}.tmp`)
  const file = await open(temp, 'wx', 0o600)
  const discard = async () => {
    await file.close().catch(() => {})
    await unlink(temp).catch(() => {})
  }
  await file.chmod(0o600).catch(async (error: unknown) => {
    await discard()
    throw error
  })
  return {
    async save(token: string) {
      await file.writeFile(`${JSON.stringify({ url, token })}\n`, 'utf8')
      await file.close()
      await rename(temp, joinedFile(dir, url))
    },
    discard,
  }
}
