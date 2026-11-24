export class RegistryError extends Error {
  field: string

  constructor(field: string, message: string) {
    super(message)
    this.name = 'RegistryError'
    this.field = field
  }
}

export function principalOf(email: string): { id: string; userId: string } {
  const invalid = () => new RegistryError('email', 'must name an unambiguous board user')
  if (typeof email !== 'string' || !/^[a-z0-9][a-z0-9._-]*@[a-z0-9._-]+$/.test(email)) throw invalid()
  const userId = email.replace('@', '.at.')
  // Count overlapping separators too: x.at@y and x@at.y would collide.
  if (userId.length > 200 || userId.indexOf('.at.') !== userId.lastIndexOf('.at.')) throw invalid()
  return { id: `cloudflare:person:${userId}`, userId }
}
