import { readFile, realpath } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { beadsAdapter } from './adapter.ts'
import { fixtureRunner } from './fixture.ts'
import { bdRunner, beadId } from './run.ts'
import { renderQueue } from './view.ts'

const usage = 'usage: swarm trackers beads queue --epic ID --store-name NAME (--dir DIR | --fixture FILE) [--bd PATH] [--json]'

function printError(headline: string) {
  const safe = headline.replace(/[\x00-\x1f\x7f-\x9f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  })
  console.error(`error: ${safe}`)
}

function misuse(headline: string): number {
  printError(headline)
  console.error(usage)
  return 2
}

function help(): number {
  console.log(usage)
  return 0
}

async function readFixture(path: string) {
  const text = await readFile(path, 'utf8').catch(() => {
    throw new Error('cannot read the fixture file')
  })
  try {
    return fixtureRunner(JSON.parse(text))
  } catch {
    throw new Error('invalid bd fixture')
  }
}

export async function runTrackers(args: string[]): Promise<number> {
  const [tracker, action, ...flags] = args
  if (tracker === '--help' && action === undefined) return help()
  if (tracker === undefined) return misuse('missing tracker')
  if (tracker !== 'beads') return misuse('unknown tracker')
  if (action === '--help' && flags.length === 0) return help()
  if (action === undefined) return misuse('missing beads command')
  if (action !== 'queue') return misuse('unknown beads command')

  let values
  try {
    ;({ values } = parseArgs({
      args: flags,
      strict: true,
      options: {
        epic: { type: 'string' },
        'store-name': { type: 'string' },
        dir: { type: 'string' },
        fixture: { type: 'string' },
        bd: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    }))
  } catch {
    return misuse('invalid arguments')
  }

  const { epic, 'store-name': store, dir, fixture, bd } = values
  if (values.help) return help()
  if (!epic) return misuse('missing --epic')
  if (!beadId.test(epic)) return misuse('invalid epic id')
  if (store === undefined) return misuse('missing --store-name')
  if (!/^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(store) || /^(?:sk-|ghp-|github-pat-|xox[a-z]-|AKIA)/i.test(store)) {
    return misuse('invalid store name')
  }
  if ((dir === undefined) === (fixture === undefined)) return misuse('specify exactly one of --dir and --fixture')
  if (dir === '' || fixture === '' || bd === '') return misuse('empty path')

  try {
    const storeDir = dir === undefined ? undefined : await realpath(dir).catch(() => {
      throw new Error('cannot open the store directory')
    })
    const live = storeDir === undefined ? undefined : bdRunner({ dir: storeDir, bin: bd ?? 'bd' })
    let queue
    try {
      const run = live ?? await readFixture(fixture!)
      queue = await beadsAdapter({ run, store }).scan({ epic })
    } finally {
      await live?.close()
    }
    process.stdout.write(values.json ? `${JSON.stringify({ queue })}\n` : renderQueue(queue))
    return 0
  } catch (error) {
    printError(error instanceof Error ? error.message : 'queue scan failed')
    return 1
  }
}
