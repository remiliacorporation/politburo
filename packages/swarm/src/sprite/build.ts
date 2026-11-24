import { createHash } from 'node:crypto'
import { closeSync, constants, openSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const fileMarkers = new Set(['pi-auth-ensure', 'pi-task', 'sprite-start', 'sprite-watch', 'sprite-stop'])
const gzMarkers = new Set(['codex-cursor-fallback.ts', 'cursor-provider.patched.ts', 'models-store.json'])
const shebang = '#!/bin/bash\n'
const version = 11

function readSpriteFile(directory: string, name: string): Buffer {
  // Marker names are basenames. Do not follow links to files outside sprite/.
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function buildSetup(): { text: string; version: 11; hash: string } {
  const packageRoot = realpathSync(new URL('../../', import.meta.url))
  const spriteDirectory = realpathSync(new URL('../../sprite/', import.meta.url))
  if (spriteDirectory !== join(packageRoot, 'sprite')) {
    throw new Error('sprite directory resolves outside its expected package path')
  }
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const template = utf8.decode(readSpriteFile(spriteDirectory, 'setup.sh.in'))
  if (!template.startsWith(shebang)) throw new Error('setup template must start with #!/bin/bash')

  // Consume the marker line's newline for helpers, which supply their own.
  const body = template.slice(shebang.length).replace(
    /^@@file:([a-zA-Z0-9][a-zA-Z0-9_.-]*)@@\n|@@gz:([a-zA-Z0-9][a-zA-Z0-9_.-]*)@@|@@(?:file|gz):[^\r\n]*?@@|@@/gm,
    (marker, file: string | undefined, gz: string | undefined) => {
      if (file !== undefined && fileMarkers.has(file)) {
        const text = utf8.decode(readSpriteFile(spriteDirectory, file))
        if (!text.endsWith('\n')) throw new Error(`${file} must end with a newline`)
        if (text.split('\n').includes('TOOLEOF')) {
          throw new Error(`${file} contains a TOOLEOF heredoc delimiter`)
        }
        return text
      }
      if (gz !== undefined && gzMarkers.has(gz)) {
        return gzipSync(readSpriteFile(spriteDirectory, gz)).toString('base64')
      }
      throw new Error(`unknown setup template marker ${marker.trimEnd()}`)
    },
  )
  const hash = createHash('sha256').update(body).digest('hex')
  return { text: `${shebang}# politburo-setup v${version} sha256:${hash}\n${body}`, version, hash }
}
