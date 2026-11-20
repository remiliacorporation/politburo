import type { Method } from './protocol.ts'

/**
 * Bound writes never use a legacy route, even after positive discovery: that response and the
 * write can hit different versions of a board. None of these paths ends in a legacy route.
 */
export const boundTaskPaths = {
  createTask: '/tasks/create-bound',
  claimReadyTask: '/tasks/claim-bound',
  claimTask: '/tasks/:id/claim-bound',
} as const satisfies Partial<Record<Method, string>>
