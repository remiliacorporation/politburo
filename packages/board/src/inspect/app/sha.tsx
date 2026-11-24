import { shortSha } from './words.ts'

/** A commit's prefix, with its full value on hover. */
export function Sha({ value }: { value: string }) {
  const text = shortSha(value)
  return text === value ? value : <span title={value}>{text}</span>
}

/** Only labels that name commits get the commit treatment. */
export function LabelValue({ name, value }: { name: string; value: string }) {
  return name === 'head' || name === 'commit' ? <Sha value={value} /> : value
}
