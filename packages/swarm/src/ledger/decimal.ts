function parse(value: string) {
  const [integer, fraction = ''] = value.split('.')
  return { unscaled: BigInt(integer + fraction), scale: fraction.length }
}

function format(unscaled: bigint, scale: number): string {
  if (unscaled === 0n) return '0'
  if (scale === 0) return unscaled.toString()
  const sign = unscaled < 0n ? '-' : ''
  const digits = (unscaled < 0n ? -unscaled : unscaled).toString().padStart(scale + 1, '0')
  const fraction = digits.slice(-scale).replace(/0+$/, '')
  return sign + digits.slice(0, -scale) + (fraction ? `.${fraction}` : '')
}

export function addDecimal(a: string, b: string): string {
  const x = parse(a)
  const y = parse(b)
  const scale = Math.max(x.scale, y.scale)
  return format(x.unscaled * 10n ** BigInt(scale - x.scale) + y.unscaled * 10n ** BigInt(scale - y.scale), scale)
}

export function sumDecimals(values: readonly string[]): string {
  return values.reduce(addDecimal, '0')
}
