// The projection of landed rows used by the spike. Optional fields cover the held
// work-evidence and staged-work revisions without depending on their reducers.
export type Fact = {
  type: string
  id?: string
  principal?: string
  epoch?: number
  round?: number
  until?: number
  needs?: string[]
  waiting?: boolean
  work?: string
  to?: string
}
export type Batch = { at: number; facts: Fact[] }
type Lease = { epoch: number | undefined; until: number }

function updateLease(leases: Map<string, Lease>, fact: Fact) {
  const { id, type, until, epoch } = fact
  if (id === undefined) return
  if (type === 'task.claimed' || type === 'task.renewed') leases.set(id, { epoch, until: until! })
  if (['task.released', 'task.expired', 'task.completed', 'task.failed', 'task.canceled', 'task.blocked',
    'task.parked', 'task.attention_requested', 'task.stage_changed'].includes(type)) leases.delete(id)
}

export function leasesIn(history: readonly Batch[]) {
  const leases = new Map<string, Lease>()
  for (const { facts } of history) for (const fact of facts) updateLease(leases, fact)
  return [...leases.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, lease]) => lease)
}

export function checkLeases(history: readonly Batch[]) {
  const violations: string[] = []
  const leases = new Map<string, Lease>()
  for (const { at, facts } of history) {
    // A takeover's task.expired must not hide a live lease in the same append.
    const beforeBatch = new Map(leases)
    for (const fact of facts) {
      const { id, type, epoch, round } = fact
      if (id === undefined) continue
      if (['task.renewed', 'task.work_submitted', 'task.released', 'task.completed'].includes(type)) {
        const lease = leases.get(id)
        const proof = type === 'task.work_submitted' ? round : epoch
        if (!lease || proof !== lease.epoch || at >= lease.until)
          violations.push(`I1 ${type} #${id} proof ${proof} landed at ${at}; prior epoch/until ${lease?.epoch}/${lease?.until}`)
      }
      if (type === 'task.claimed' && [beforeBatch.get(id), leases.get(id)].some((lease) => lease && at < lease.until))
        violations.push(`I2 ${type} #${id} landed while a prior lease was live at ${at}`)
      updateLease(leases, fact)
    }
  }
  return violations
}

export function checkPrerequisites(history: readonly Batch[]) {
  const violations: string[] = []
  const tasks = new Map<string, { needs: string[]; state: string; stage?: string }>()
  for (const [batch, { facts }] of history.entries()) {
    for (const { id, type, needs, work, to, waiting } of facts) {
      if (id === undefined) continue
      if (type === 'task.created') {
        tasks.set(id, { needs: needs!, state: work || needs!.length ? 'waiting' : 'ready', ...(work ? { stage: work } : {}) })
      }
      const task = tasks.get(id)
      if (!task) continue
      const canClaim = () => !task.stage || task.stage === 'scoped' || task.stage === 'repair'
      const start = () => canClaim() && !task.needs.length ? 'ready' : 'waiting'
      switch (type) {
        case 'task.needs_changed':
          task.needs = needs!
          if (task.state === 'waiting' || task.state === 'ready') task.state = start()
          break
        case 'task.stage_changed':
          task.stage = to!
          task.state = to === 'done' ? 'completed' : start()
          break
        case 'task.ready': task.state = 'ready'; break
        case 'task.claimed': task.state = 'claimed'; break
        case 'task.completed': task.state = 'completed'; break
        case 'task.released':
        case 'task.expired':
        case 'task.reopened': task.state = waiting ? 'waiting' : 'ready'; break
        case 'task.failed':
        case 'task.canceled':
        case 'task.blocked': task.state = type; break
      }
    }
    // An atomic reopen can also make dependents wait, so check only after the batch.
    for (const [id, task] of tasks) {
      const unfinished = task.needs.filter((need) => tasks.get(need)?.state !== 'completed')
      if (task.state === 'ready' && unfinished.length)
        violations.push(`I4 #${id} is ready with unfinished prerequisites (${unfinished.join(', ')}) after batch ${batch + 1}`)
    }
  }
  return violations
}

type Saved = { epoch: number; token: string; until: string }

/** The only other operation in this fixture is a drop with an older proof. */
export function checkSavedClaim(putCompleted: boolean, saved: Saved, recovered: Saved | null) {
  return putCompleted && (recovered?.epoch !== saved.epoch || recovered.token !== saved.token || recovered.until !== saved.until)
    ? ['I5 successful put(B) was lost or replaced after stale drop(A)'] : []
}
