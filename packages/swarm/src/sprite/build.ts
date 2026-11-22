import { createHash } from 'node:crypto'
import { closeSync, constants, openSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const spriteDirectory = new URL('../../sprite/', import.meta.url)
const shebang = '#!/bin/bash\n'
const version = 11

function readSpriteFile(name: string): Buffer {
  // Marker names are basenames. Do not follow links to files outside sprite/.
  const fd = openSync(new URL(name, spriteDirectory), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function buildSetup(): { text: string; version: 11; hash: string } {
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const template = utf8.decode(readSpriteFile('setup.sh.in'))
  if (!template.startsWith(shebang)) throw new Error('setup template must start with #!/bin/bash')

  // Consume the marker line's newline for helpers, which supply their own.
  const body = template.slice(shebang.length).replace(
    /^@@file:([a-zA-Z0-9][a-zA-Z0-9_.-]*)@@\n|@@gz:([a-zA-Z0-9][a-zA-Z0-9_.-]*)@@|@@/gm,
    (_marker, file: string | undefined, gz: string | undefined) => {
      if (file !== undefined) {
        const text = utf8.decode(readSpriteFile(file))
        if (!text.endsWith('\n')) throw new Error(`${file} must end with a newline`)
        if (text.split('\n').includes('TOOLEOF')) {
          throw new Error(`${file} contains a TOOLEOF heredoc delimiter`)
        }
        return text
      }
      if (gz !== undefined) return gzipSync(readSpriteFile(gz)).toString('base64')
      throw new Error('unknown setup template marker')
    },
  )
  const hash = createHash('sha256').update(body).digest('hex')
  return { text: `${shebang}# politburo-setup v${version} sha256:${hash}\n${body}`, version, hash }
}
