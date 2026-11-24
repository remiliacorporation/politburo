import type { Method } from '../api/protocol.ts'
import { RedeemInviteBody } from '../api/routes.ts'
import type { Backend, SelfCaller } from './backend.ts'
import { badRequest, HttpError, json, notFound } from './errors.ts'
import { readCapped } from './routing.ts'

export const CONTROL = new Set<Method>(['status', 'pause', 'resume'])
export const noInvites = () => new HttpError(501, 'no_invites', 'this board keeps no invites')
export const SECRET_RESPONSE = { 'cache-control': 'no-store' }

/** Joined credentials only work at the public mount itself, not at aliases or deeper mounts. */
export const atAudience = (at: string, audience: string) => URL.parse(audience)?.href.replace(/\/+$/, '') === at

/** Redeeming the invite proves admission; neither headers nor an existing login can name the new principal. */
export async function redeem(
  request: Request,
  at: string,
  injected: boolean,
  backend: Backend,
  OWN: SelfCaller,
  ownUrl: () => string | null,
  audienceOf: (at: string) => string,
): Promise<Response> {
  if (!backend.redeemInvite) throw noInvites()
  // http() forwards only the secret; its remote board binds the bearer to its own mount.
  const audience = injected ? (backend.keeps ? ownUrl() : at) : audienceOf(at)
  if (audience === null)
    throw new HttpError(500, 'no_board_url', 'this board needs a public URL to redeem an invite in-process', {
      hint: 'Pass board({ url }) with the URL people reach it at.',
    })
  if (!injected && !atAudience(at, audience)) throw notFound('this is not the public board mount')
  const invalid = () => badRequest('send an invite secret in the request body', 'invalid_invite')
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder().decode(await readCapped(request, 1024)))
  } catch {
    throw invalid()
  }
  const parsed = RedeemInviteBody.safeParse(body)
  if (!parsed.success) throw invalid()
  try {
    return json(await backend.redeemInvite(OWN, { ...parsed.data, audience }, request.signal), 201, SECRET_RESPONSE)
  } catch (error) {
    if (error instanceof HttpError) throw error
    // A failure on a secret-bearing request must not log the input or serialize a raw exception.
    throw new HttpError(500, 'internal', 'could not redeem the invite')
  }
}
