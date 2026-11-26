// A small PNG reader for the inspector's icons. It decodes the files a game ships
// (8-bit gray, RGB, indexed, or RGBA, not interlaced) into pixels. It is not a
// general image library.

export type Raster = { width: number; height: number; rgba: Uint8Array }

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
const MAX_EDGE = 4096

/** The image in `bytes`, or null when it is not a PNG this reader draws. */
export async function decodePng(bytes: Uint8Array): Promise<Raster | null> {
  if (bytes.length < 8 || SIG.some((byte, i) => bytes[i] !== byte)) return null
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  let at = 8
  while (at + 12 <= bytes.length) {
    const length = readU32(bytes, at)
    const type = latin(bytes, at + 4, 4)
    const dataAt = at + 8
    const next = dataAt + length + 4
    if (length < 0 || next > bytes.length) return null
    const data = bytes.subarray(dataAt, dataAt + length)
    if (type === 'IHDR') {
      if (length !== 13) return null
      width = readU32(bytes, dataAt)
      height = readU32(bytes, dataAt + 4)
      bitDepth = bytes[dataAt + 8]!
      colorType = bytes[dataAt + 9]!
      if (bytes[dataAt + 10] !== 0 || bytes[dataAt + 11] !== 0 || bytes[dataAt + 12] !== 0) return null
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'tRNS') {
      trns = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    at = next
  }
  if (width < 1 || height < 1 || width > MAX_EDGE || height > MAX_EDGE || bitDepth !== 8) return null
  const channels = channelsOf(colorType)
  if (channels === null || (colorType === 3 && palette === null)) return null
  const inflated = await inflate(concat(idat))
  if (inflated === null) return null
  const raw = unfilter(inflated, width, height, channels)
  if (raw === null) return null
  return { width, height, rgba: toRgba(raw, width, height, colorType, palette, trns) }
}

function channelsOf(colorType: number): number | null {
  if (colorType === 0) return 1
  if (colorType === 2) return 3
  if (colorType === 3) return 1
  if (colorType === 4) return 2
  if (colorType === 6) return 4
  return null
}

function unfilter(data: Uint8Array, width: number, height: number, channels: number): Uint8Array | null {
  const stride = width * channels
  const row = stride + 1
  if (data.length < row * height) return null
  const out = new Uint8Array(stride * height)
  const prior = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = data[y * row]!
    const source = data.subarray(y * row + 1, y * row + 1 + stride)
    const dest = out.subarray(y * stride, (y + 1) * stride)
    if (filter === 0) dest.set(source)
    else if (filter === 1) {
      for (let i = 0; i < stride; i++) dest[i] = (source[i]! + (i >= channels ? dest[i - channels]! : 0)) & 255
    } else if (filter === 2) {
      for (let i = 0; i < stride; i++) dest[i] = (source[i]! + prior[i]!) & 255
    } else if (filter === 3) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? dest[i - channels]! : 0
        dest[i] = (source[i]! + ((left + prior[i]!) >> 1)) & 255
      }
    } else if (filter === 4) {
      for (let i = 0; i < stride; i++) {
        const left = i >= channels ? dest[i - channels]! : 0
        const upLeft = i >= channels ? prior[i - channels]! : 0
        dest[i] = (source[i]! + paeth(left, prior[i]!, upLeft)) & 255
      }
    } else return null
    prior.set(dest)
  }
  return out
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

function toRgba(raw: Uint8Array, width: number, height: number, colorType: number, palette: Uint8Array | null, trns: Uint8Array | null): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0, pixel = 0; pixel < width * height; pixel++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 255
    if (colorType === 6) {
      r = raw[i]!
      g = raw[i + 1]!
      b = raw[i + 2]!
      a = raw[i + 3]!
      i += 4
    } else if (colorType === 2) {
      r = raw[i]!
      g = raw[i + 1]!
      b = raw[i + 2]!
      if (trns && trns.length >= 6 && r === trns[1] && g === trns[3] && b === trns[5]) a = 0
      i += 3
    } else if (colorType === 0) {
      r = g = b = raw[i]!
      if (trns && trns.length >= 2 && r === trns[1]) a = 0
      i += 1
    } else if (colorType === 4) {
      r = g = b = raw[i]!
      a = raw[i + 1]!
      i += 2
    } else {
      const index = raw[i]!
      const at = index * 3
      r = palette![at] ?? 0
      g = palette![at + 1] ?? 0
      b = palette![at + 2] ?? 0
      if (trns && index < trns.length) a = trns[index]!
      i += 1
    }
    const out = pixel * 4
    rgba[out] = r
    rgba[out + 1] = g
    rgba[out + 2] = b
    rgba[out + 3] = a
  }
  return rgba
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length === 0) return null
  try {
    const stream = new DecompressionStream('deflate')
    const writer = stream.writable.getWriter()
    const reader = stream.readable.getReader()
    const writing = writer.write(bytes.slice()).then(() => writer.close())
    const chunks: Uint8Array[] = []
    let size = 0
    const cap = MAX_EDGE * MAX_EDGE * 4
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    await writing
    return concat(chunks)
  } catch {
    return null
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let size = 0
  for (const part of parts) size += part.byteLength
  const out = new Uint8Array(size)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
}

function latin(bytes: Uint8Array, at: number, length: number): string {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[at + i]!)
  return text
}
