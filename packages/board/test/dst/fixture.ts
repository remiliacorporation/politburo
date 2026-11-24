import { oidcTokens } from '../../src/access/index.ts'
import { http } from '../../src/backend-http/index.ts'
import { a2, type A2Options } from '../../src/server/a2.ts'
import { memoryBlob } from '../../src/server/blob.ts'
import { bearer, board, BOARD_URL, testAuth, testLocal } from '../harness.ts'

// Like testBoard, but forward engine options that mount on main doesn't know yet.
export function hostBoard(options: A2Options) {
  return board({
    backend: a2({ blob: memoryBlob(), ...options }),
    url: BOARD_URL,
    authenticate: oidcTokens({ ...testAuth, local: testLocal }),
  })
}

export function handle(host: { fetch(request: Request): Promise<Response> }, token: string) {
  return board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => host.fetch(new Request(input, init)), token) }) }).as(null)
}

/** Only expected refusals count as request outcomes. Don't hide transport or fixture failures. */
export async function outcome(call: () => Promise<unknown>, refused: readonly string[]) {
  try {
    await call()
    return 'ok'
  } catch (error) {
    const { code } = error as { code?: string }
    if (code && refused.includes(code)) return code
    throw error
  }
}
