import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BOARD_URL, testBoard } from './harness.ts'

const docs = new URL('../docs/', import.meta.url)
const page = (path: string) => readFileSync(new URL(path, docs), 'utf8')

/** The first ts code block under a `## heading`. */
function snippet(markdown: string, heading: string): string {
  const section = markdown.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0] ?? ''
  const code = /```ts[^\n]*\n([\s\S]*?)```/.exec(section)?.[1]
  if (!code) throw new Error(`no ts snippet under "## ${heading}"`)
  return code
}

it('documents the task completion body as published in OpenAPI', async () => {
  const response = await testBoard().fetch(new Request(`${BOARD_URL}/openapi.json`))
  const { paths } = await response.json()
  const schema = paths['/tasks/{id}/complete'].post.requestBody.content['application/json'].schema
  const fields = Object.keys(schema.properties).map((name) => schema.required.includes(name) ? name : `${name}?`)
  const row = page('04-reference/03-http.md').split('\n').find((line) => line.startsWith('| POST | `/tasks/:id/complete` |'))
  const documented = row?.match(/`\{\s*([^}]+)\}`/)?.[1]?.split(',').map((field) => field.trim())
  expect(documented?.sort()).toEqual(fields.sort())
})

describe('the docs show the short way to sync with Vercel Connect', () => {
  const pages = [
    ['index.md', 'Sync Slack and GitHub'],
    ['02-sync/01-overview.md', 'Configure it'],
    ['02-sync/03-slack.md', 'Configure it'],
    ['02-sync/04-github.md', 'Configure it'],
  ] as const

  it.each(pages)('%s "%s" passes connectors, not hand-built adapters', (path, heading) => {
    const code = snippet(page(path), heading)
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]!)
    // A connector name is enough: board builds the adapter, the client, and sign-in.
    expect(imports.filter((from) => !from.startsWith('@vercel/board') && !from.startsWith('experimental-a2'))).toEqual([])
    expect(code).not.toMatch(/withBotToken|client:|botUserId/)
    expect(code).toMatch(/(slack|github)\('(slack|github)\/acme'/)
  })
})
