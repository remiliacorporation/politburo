import { cp, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { vb as vbInProcess } from '../src/cli/embedded.ts'
import { env, tmp, url, useBoard, vb } from './cli-harness.ts'
import { asProfile, bo, claimOn, claimsDir, create, deployment, events, failure, ok, start, state, task, until } from './cli-tasks-harness.ts'
import { bearer, board, localBoard, personToken } from './harness.ts'
import { serve } from './http.ts'

useBoard()

describe("vb tasks, with the claim it keeps", () => {
  it('keeps a claim for the profile that took it, between commands: only this user reads it, and a run as anyone else holds none', async () => {
    const id = await create('held', 'a long migration')
    const mine = asProfile('Migrator')
    await ok(['tasks', 'claim', id, '--lease', '5m'], mine)

    // One file, for this board, task, and profile, that only this user reads. Its name says nothing.
    const [stored] = await claimOn(id)
    expect(stored).toMatchObject({ board: url, task: id, profile: 'migrator', epoch: 1 })
    expect(stored!.name).toMatch(/^[0-9a-f]{32}\.json$/)
    expect(stored!.name).not.toContain(stored!.token)
    expect((await stat(join(claimsDir(), stored!.name))).mode & 0o777).toBe(0o600)
    expect((await stat(claimsDir())).mode & 0o777).toBe(0o700)

    // A run as another profile on this machine, and one as yourself, hold nothing: each is another actor, and is told how to claim.
    for (const [other, who] of [[asProfile('reviewer'), 'reviewer'], [{}, 'yourself']] as const) {
      const refused = await vb(['tasks', 'complete', id, 'not mine'], other)
      expect(refused).toMatchObject({ code: 1, stdout: '' })
      expect(refused.stderr).toBe(`error: You hold no claim on task #${id} as ${who}.\n\n  Claim it:\n    vb tasks claim ${id}\n`)
    }
    expect(failure(await vb(['tasks', 'renew', id, '--json'], asProfile('reviewer')))).toMatchObject({ reason: 'claim_not_held', next: [{ argv: ['vb', 'tasks', 'claim', id] }] })
    // Named with --as, the profile is in the way out too, so the claim it takes is the one the next command finds.
    expect(failure(await vb(['tasks', 'renew', id, '--as', 'reviewer', '--json']))).toMatchObject({
      reason: 'claim_not_held',
      message: `You hold no claim on task #${id} as reviewer.`,
      next: [{ argv: ['vb', 'tasks', 'claim', id, '--as', 'reviewer'] }],
    })
    expect(await state(id)).toBe('claimed')

    // The profile that claimed it renews and settles it, each a process of its own, however the run names it:
    // the environment's or --as's, in any case, since an actor's profile is lowercase.
    expect(await ok(['tasks', 'renew', id, '--lease', '10m', '--as', 'migrator'])).toBe(`#${id}  yours for 10m  a long migration\n`)
    expect((await claimOn(id))[0]).toMatchObject({ epoch: 1, token: stored!.token })
    expect(Date.parse((await claimOn(id))[0]!.until)).toBeGreaterThan(Date.parse(stored!.until))
    expect(await ok(['tasks', 'complete', id, 'migrated'], mine)).toBe(`completed ${id}\n`)
    // Settled, the claim is over, and so is its file.
    expect(await claimOn(id)).toEqual([])
    expect((await vb(['tasks', 'release', id], mine)).stderr).toBe(`error: You hold no claim on task #${id} as migrator. It's completed already.\n\n  See where it stands:\n    vb read ${id}\n`)
  }, 60_000)

  it('forgets a claim the board says is lost, and says how to take the task again', async () => {
    const id = await create('lost', 'rotate the keys')
    const mine = asProfile('rotator')
    await ok(['tasks', 'claim', id], mine)
    // Its owner cancels it from another terminal: the claim ended, and the run that holds it doesn't know yet.
    expect(await ok(['tasks', 'cancel', id, 'superseded'])).toBe(`canceled ${id}\n`)
    expect(await claimOn(id)).toHaveLength(1)

    // The same profile, named with --as this time: the way out claims as it too.
    const lost = await vb(['tasks', 'complete', id, 'rotated', '--as', 'rotator'])
    expect(lost).toMatchObject({ code: 1, stdout: '' })
    expect(lost.stderr).toMatch(
      new RegExp(`^error: Lost the claim on task #${id}\\. Its lease ran out, or the task moved on\\.\\n  [^\\n]+\\n\\n  See where it stands:\\n    vb read ${id}\\n  Or claim it again:\\n    vb tasks claim ${id} --as rotator\\n$`),
    )
    expect(await claimOn(id)).toEqual([])
    expect(failure(await vb(['tasks', 'complete', id, '--json'], mine)).reason).toBe('claim_not_held')
    expect((await task(id)).task).toMatchObject({ state: 'canceled', reason: 'superseded', result: null })
  }, 60_000)

  it('releases, fails, and reopens a task, each a line, and --json says what happened to it', async () => {
    const id = await create('settle', 'flaky tests')
    await ok(['tasks', 'claim', id])
    expect(await ok(['tasks', 'release', id])).toBe(`released ${id}\n`)
    expect(await state(id)).toBe('ready')
    expect(await claimOn(id)).toEqual([])

    await ok(['tasks', 'claim', id])
    expect(await vb(['tasks', 'fail', id])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing why it failed, in a line\.\n/) })
    expect(await state(id)).toBe('claimed')
    const failed = JSON.parse(await ok(['tasks', 'fail', id, 'the tests need a database', '--json'])) as { task: MessageView; outcome: string }
    expect(failed).toMatchObject({ outcome: 'failed', task: { id, task: { state: 'failed', reason: 'the tests need a database' } } })
    expect(await claimOn(id)).toEqual([])

    expect(await ok(['tasks', 'reopen', id])).toBe(`reopened ${id}\n`)
    expect(await state(id)).toBe('ready')
    // Reopening what isn't failed changes nothing, and says so.
    expect(await ok(['tasks', 'reopen', id])).toBe(`${id} wasn't failed\n`)
    expect(JSON.parse(await ok(['tasks', 'reopen', id, '--json']))).toMatchObject({ outcome: 'unchanged', task: { task: { state: 'ready' } } })

    await ok(['tasks', 'claim', id])
    expect(JSON.parse(await ok(['tasks', 'complete', id, 'green on the third run', '--json']))).toMatchObject({ outcome: 'completed', task: { task: { state: 'completed', result: 'green on the third run' } } })
    const finished = await vb(['tasks', 'claim', id])
    expect(finished.stderr).toMatch(new RegExp(`^error: Can't claim task #${id}\\. It's finished\\.\\n  [^\\n]+\\n\\n  See how it ended:\\n    vb read ${id}\\n$`))
    expect((await vb(['tasks', 'complete', id, 'one', 'two'])).code).toBe(2)
  }, 60_000)

  it("holds a task for a person, with the claim that holds it or as its owner, and lifts the hold", async () => {
    const id = await create('holds', 'deploy to prod')
    await ok(['tasks', 'claim', id])
    expect(await ok(['tasks', 'block', id, 'approve the prod deploy?', '--kind', 'awaiting_approval'])).toBe(`blocked ${id}\n`)
    expect((await task(id)).task).toMatchObject({ state: 'blocked', claim: null, blocked: { kind: 'awaiting_approval', reason: 'approve the prod deploy?' } })
    // The hold ended the claim, so the CLI keeps none.
    expect(await claimOn(id)).toEqual([])

    const blocked = await vb(['tasks', 'claim', id], await bo())
    expect(blocked.stderr).toMatch(new RegExp(`^error: Can't claim task #${id}\\. It's held for a person\\.\\n  [^\\n]+\\n\\n  See what it's held for:\\n    vb read ${id}\\n  Or, as its owner, lift the hold:\\n    vb tasks unblock ${id}\\n$`))
    // Completing it without a claim says the hold comes first, as a claim would be refused.
    expect(await vb(['tasks', 'complete', id, 'deployed'])).toEqual({
      code: 1,
      stdout: '',
      stderr: `error: You hold no claim on task #${id} as yourself. It's held for a person: claim it once the hold lifts.\n\n  As its owner, lift the hold, then claim it:\n    vb tasks unblock ${id}\n  See where it stands:\n    vb read ${id}\n`,
    })
    expect(await ok(['tasks', 'unblock', id])).toBe(`unblocked ${id}\n`)
    expect(await ok(['tasks', 'unblock', id])).toBe(`${id} wasn't blocked\n`)

    // Unclaimed, its owner holds it; while Bo holds it, only Bo's claim does.
    expect(JSON.parse(await ok(['tasks', 'block', id, 'not this week', '--json']))).toMatchObject({ outcome: 'blocked', task: { task: { blocked: { kind: null, reason: 'not this week' } } } })
    await ok(['tasks', 'unblock', id])
    await ok(['tasks', 'claim', id], await bo())
    const held = await vb(['tasks', 'block', id, 'wait'])
    expect(held).toMatchObject({ code: 1, stderr: expect.stringMatching(new RegExp(`^error: Can't block task #${id}\\. Someone holds it\\.\\n`)) })
    // One that waits for a task says so, as a claim of it would be refused until that completes.
    const after = await create('holds', 'smoke test prod', ['--needs', id])
    expect(await vb(['tasks', 'complete', after, 'passed'])).toEqual({
      code: 1,
      stdout: '',
      stderr: `error: You hold no claim on task #${after} as yourself. It waits for what it needs (#${id}): claim it once those complete.\n\n  See what it waits for:\n    vb read ${after}\n`,
    })
    expect(failure(await vb(['tasks', 'claim', after, '--json'])).reason).toBe('task_waiting')
    // Once it's finished, there's no claim to take.
    await ok(['tasks', 'complete', id, 'deployed'], await bo())
    expect(failure(await vb(['tasks', 'complete', id, 'deployed', '--json']))).toMatchObject({ reason: 'claim_not_held', message: `You hold no claim on task #${id} as yourself. It's completed already.`, next: [{ argv: ['vb', 'read', id] }] })
    expect(await vb(['tasks', 'block', id])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing what you need from a person, in a line\.\n/) })
  }, 60_000)

  it('suggests unpark for a parked task and unblock for a plain hold', async () => {
    const id = await create('parked', 'deploy to prod', ['--as', 'worker'])
    await ok(['tasks', 'block', id, 'waiting for approval', '--as', 'worker'])
    const held = await vb(['tasks', 'claim', id])
    expect(held.code).toBe(1)
    expect(held.stderr).toContain(`error: Can't claim task #${id}. It's held for a person.\n`)
    expect(held.stderr).toContain(`    vb tasks unblock ${id}\n`)
    expect(held.stderr).not.toContain('vb tasks unpark')

    const elsewhere = { BOARD_URL: 'http://env.invalid/api/board' }
    const heldWithFlags = await vb(['tasks', 'claim', id, '--url', url, '--as', 'worker', '--json'], elsewhere)
    expect(heldWithFlags).toMatchObject({ code: 1, stdout: '' })
    const hold = failure(heldWithFlags)
    expect(hold).toMatchObject({ reason: 'task_blocked', next: [
      { argv: ['vb', 'read', id, '--url', url, '--as', 'worker'] },
      { argv: ['vb', 'tasks', 'unblock', id, '--url', url, '--as', 'worker'] },
    ] })
    expect(await ok(hold.next![1]!.argv.slice(1), elsewhere)).toBe(`unblocked ${id}\n`)

    await ok(['tasks', 'park', id, 'deployment freeze'])
    const parked = await vb(['tasks', 'claim', id])
    expect(parked).toMatchObject({ code: 1, stdout: '' })
    const [headline, , ...recovery] = parked.stderr.split('\n')
    expect([headline, ...recovery]).toEqual([
      `error: Can't claim task #${id}. It's parked.`,
      '',
      "  See what it's held for:",
      `    vb read ${id}`,
      '  Or, as an operator, lift the park:',
      `    vb tasks unpark ${id} 'resume work'`,
      '',
    ])

    const refused = failure(await vb(['tasks', 'claim', id, '--url', url, '--as', 'worker', '--json'], elsewhere))
    expect(refused).toMatchObject({ reason: 'task_blocked', next: [
      { argv: ['vb', 'read', id, '--url', url, '--as', 'worker'] },
      { argv: ['vb', 'tasks', 'unpark', id, 'resume work', '--url', url] },
    ] })
    const notHeld = await vb(['tasks', 'complete', id, '--url', url, '--as', 'worker', '--json'], elsewhere)
    expect(notHeld).toMatchObject({ code: 1, stdout: '' })
    expect(failure(notHeld)).toMatchObject({ reason: 'claim_not_held', message: expect.stringContaining("It's parked"), next: [
      { argv: ['vb', 'read', id, '--url', url, '--as', 'worker'] },
      { argv: ['vb', 'tasks', 'unpark', id, 'resume work', '--url', url] },
    ] })
    expect((await task(id)).task).toMatchObject({ state: 'blocked', parked: { reason: 'deployment freeze' } })
    // The suggested write still reaches the selected board, but unpark must act as a person, without --as.
    expect(await ok(refused.next![1]!.argv.slice(1), elsewhere)).toBe(`unparked ${id}\n`)
  }, 60_000)

  it.each(['complete', 'claim'])('follows the unpark recovery after tasks %s with BOARD_PROFILE set', async (verb) => {
    const id = await create('parked', 'deploy to prod')
    await ok(['tasks', 'park', id, 'deployment freeze'])

    const worker = asProfile('worker')
    const refused = await vb(['tasks', verb, id, '--json'], worker)
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    const { reason, next } = failure(refused)
    expect(reason).toBe(verb === 'complete' ? 'claim_not_held' : 'task_blocked')
    const recovery = next?.find(({ argv }) => argv.includes('unpark'))
    expect(recovery).toBeDefined()

    const terminal = await vb(['tasks', verb, id], worker)
    expect(terminal).toMatchObject({
      code: 1,
      stdout: '',
      stderr: expect.stringContaining(`  ${recovery!.when}:\n    ${recovery!.command}\n`),
    })
    // Follow the terminal suggestion in the same shell, unsetting the profile only if told to.
    if (/\bBOARD_PROFILE unset\b|\bunset BOARD_PROFILE\b|\bwithout BOARD_PROFILE\b/.test(recovery!.when)) delete worker.BOARD_PROFILE
    expect(await ok(recovery!.argv.slice(1), worker)).toBe(`unparked ${id}\n`)
    expect(await state(id)).toBe('ready')
  }, 60_000)

  it('keeps --scope in the unpark suggestion', async () => {
    const id = await create('parked', 'deploy to prod')
    await ok(['tasks', 'park', id, 'deployment freeze'])

    // --scope selects a Vercel board in the standalone CLI. Use the local board handle for the refusal.
    const team = board({ backend: http(url, { fetch: bearer(fetch, env.BOARD_TOKEN!) }) })
    const refused = await vbInProcess(team, ['tasks', 'claim', id, '--scope', 'acme', '--as', 'worker', '--json'])
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    expect(failure(refused)).toMatchObject({ reason: 'task_blocked', next: [
      { argv: ['vb', 'read', id, '--scope', 'acme', '--as', 'worker'] },
      { argv: ['vb', 'tasks', 'unpark', id, 'resume work', '--scope', 'acme'] },
    ] })
  })

  it('suggests only a read when a hold is lifted after the claim refusal', async ({ onTestFinished }) => {
    const team = localBoard({ url: undefined })
    let id: string
    const server = await serve(async (request) => {
      if (request.method === 'GET' && new URL(request.url).pathname === `/api/board/messages/${id}`) {
        // Lift the hold before the board answers the CLI's follow-up read.
        const lifted = await team.fetch(new Request(new URL(`/api/board/tasks/${id}/unblock`, request.url), { method: 'POST', headers: request.headers }))
        if (!lifted.ok) return lifted
      }
      return team.fetch(request)
    })
    onTestFinished(async () => {
      await server.close()
      await team.close()
    })
    const board = `${server.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    id = await create('held', 'deploy to prod', ['--as', 'worker'], as)
    await ok(['tasks', 'block', id, 'waiting for approval', '--as', 'worker'], as)

    const refused = await vb(['tasks', 'claim', id, '--url', board, '--as', 'worker', '--json'], as)
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    const error = failure(refused)
    expect({ reason: error.reason, message: error.message, next: error.next?.map(({ when, argv }) => ({ when, argv })) }).toEqual({
      reason: 'task_blocked',
      message: `Can't claim task #${id}. It was held, and the hold is lifted now. Try again.`,
      next: [{ when: 'See where it stands', argv: ['vb', 'read', id, '--url', board, '--as', 'worker'] }],
    })
  })

  it(
    'does not suggest retrying unblock when the park is lifted',
    async ({ onTestFinished }) => {
      const team = localBoard({ url: undefined })
      let id: string
      let unblockRefused = false
      const server = await serve(async (request) => {
        const { method } = request
        const path = new URL(request.url).pathname
        if (method === 'POST' && path === `/api/board/tasks/${id}/unblock`) {
          const response = await team.fetch(request)
          unblockRefused = response.status === 409
          return response
        }
        // Unblock reads the task before the write too. Lift only after refusal.
        if (unblockRefused && method === 'GET' &&
            path === `/api/board/messages/${id}`) {
          const headers = new Headers(request.headers)
          headers.set('content-type', 'application/json')
          const unpark = new Request(
            new URL(`/api/board/tasks/${id}/unpark`, request.url),
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ reason: 'maintenance ended' }),
            },
          )
          const lifted = await team.fetch(unpark)
          if (!lifted.ok) return lifted
        }
        return team.fetch(request)
      })
      onTestFinished(async () => {
        await server.close()
        await team.close()
      })
      const board = `${server.origin}/api/board`
      const as = {
        BOARD_URL: board,
        BOARD_TOKEN: await personToken('u_julian', board),
      }
      id = await create('parked', 'deploy to prod', [], as)
      await ok(['tasks', 'park', id, 'deployment freeze'], as)

      const refused = await vb(
        ['tasks', 'unblock', id, '--url', board, '--json'], as,
      )
      expect(refused).toMatchObject({ code: 1, stdout: '' })
      const { reason, message, next } = failure(refused)
      expect({ reason, message }).toEqual({
        reason: 'task_blocked',
        message: `Can't unblock task #${id}. ` +
          'It was held, and the hold is lifted now.',
      })
      expect(next?.map(({ when, argv }) => ({ when, argv }))).toEqual([
        {
          when: 'See where it stands',
          argv: ['vb', 'read', id, '--url', board],
        },
      ])
    },
  )

  it('does not suggest retrying a cancel the board refused for a hold now lifted', async ({ onTestFinished }) => {
    const team = localBoard({ url: undefined })
    let id: string
    // A board that still holds the task when it cancels: the one here cancels a held task.
    const server = await serve((request) => {
      if (request.method === 'POST' && new URL(request.url).pathname === `/api/board/tasks/${id}/cancel`)
        return Promise.resolve(Response.json({ error: { code: 'task_blocked', message: 'the task is held' } }, { status: 409 }))
      return team.fetch(request)
    })
    onTestFinished(async () => {
      await server.close()
      await team.close()
    })
    const board = `${server.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    id = await create('cancel', 'deploy to prod', [], as)

    const refused = await vb(['tasks', 'cancel', id, 'not needed', '--url', board, '--json'], as)
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    const { reason, message, next } = failure(refused)
    expect({ reason, message }).toEqual({
      reason: 'task_blocked',
      message: `Can't cancel task #${id}. It was held, and the hold is lifted now.`,
    })
    expect(next?.map(({ when, argv }) => ({ when, argv }))).toEqual([{ when: 'See where it stands', argv: ['vb', 'read', id, '--url', board] }])
  })

  it('keeps the claim refusal when reading the held task fails', async ({ onTestFinished }) => {
    const team = localBoard({ url: undefined })
    const server = await serve((request) => {
      if (request.method === 'GET' && new URL(request.url).pathname.startsWith('/api/board/messages/')) {
        return Promise.resolve(Response.json({ error: { code: 'unavailable', message: 'thread read unavailable' } }, { status: 503 }))
      }
      return team.fetch(request)
    })
    onTestFinished(async () => {
      await server.close()
      await team.close()
    })
    const board = `${server.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    const id = await create('parked', 'deploy to prod', [], as)
    await ok(['tasks', 'park', id, 'deployment freeze'], as)

    const refused = await vb(['tasks', 'claim', id, '--json'], as)
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    const error = failure(refused)
    expect(error).toMatchObject({
      reason: 'task_blocked',
      message: `Can't claim task #${id}. It's held, but the CLI couldn't read the task to see why.`,
      data: { error: { code: 'task_blocked', status: 409, message: `#${id} is parked: an operator must unpark it` } },
    })
    expect(error.next?.map(({ argv }) => argv)).toEqual([['vb', 'read', id]])
  })

  it("assigns a task to one of its owner's profiles, the only one that claims it, and returns it to the pool", async () => {
    const id = await create('assigned', 'fix CVE-123')
    expect(await ok(['tasks', 'assign', id, 'Fixer'])).toBe(`assigned ${id} to fixer\n`)
    expect((await task(id)).task?.for).toBe('vercel:user:u_julian+fixer')

    const refused = await vb(['tasks', 'claim', id])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toMatch(
      new RegExp(`^error: Can't claim task #${id}\\. It's assigned to another profile\\.\\n  [^\\n]+\\n\\n  See whom it's for:\\n    vb read ${id}\\n  Or, as its owner, return it to the pool:\\n    vb tasks assign ${id} --pool\\n$`),
    )
    expect(await ok(['tasks', 'claim', id, '--as', 'fixer'])).toBe(`#${id}  yours for 15m  fix CVE-123\n`)
    // The claim is fixer's: as yourself you hold none of it.
    expect(failure(await vb(['tasks', 'release', id, '--json']))).toMatchObject({ reason: 'claim_not_held', message: `You hold no claim on task #${id} as yourself.` })
    expect(await ok(['tasks', 'release', id, '--as', 'fixer'])).toBe(`released ${id}\n`)

    expect(await ok(['tasks', 'assign', id, '--pool'])).toBe(`unassigned ${id}\n`)
    expect((await task(id)).task?.for).toBeNull()
    expect(JSON.parse(await ok(['tasks', 'assign', id, 'reviewer', '--json']))).toMatchObject({ outcome: 'assigned', task: { task: { for: 'vercel:user:u_julian+reviewer' } } })

    // Whoever manages the channel assigns it to its owner's profile, not to one of their own.
    const theirs = await create('assigned', "bo's task", [], await bo())
    await ok(['tasks', 'assign', theirs, 'fixer'])
    expect((await task(theirs)).task?.for).toBe('vercel:user:u_bo+fixer')

    expect((await vb(['tasks', 'assign', id])).stderr).toMatch(/^error: Missing the profile to assign it to, such as fixer, or --pool/)
    expect((await vb(['tasks', 'assign', id, 'fixer', '--pool'])).code).toBe(2)
  }, 60_000)

  it('sets what a task waits for, in place of what it waited for, and nothing with --none', async () => {
    const fix = await create('needed', 'fix CVE-123')
    const notes = await create('needed', 'update the changelog')
    const review = await create('needed', 'review the fix')
    const needs = async (id: string) => (await task(id)).task?.needs
    // The tasks named, each once however it's written: it waits for them now.
    expect(await ok(['tasks', 'needs', review, fix, `#${notes}`, fix])).toBe(`${review} needs #${fix} #${notes}\n`)
    expect((await task(review)).task).toMatchObject({ state: 'waiting', needs: [fix, notes] })
    // In place of what it waited for, not beside it.
    expect(await ok(['tasks', 'needs', review, notes])).toBe(`${review} needs #${notes}\n`)
    expect(await needs(review)).toEqual([notes])
    // Nothing is said, not left out: a command cut short changes nothing.
    const bare = await vb(['tasks', 'needs', review])
    expect(bare).toEqual({ code: 2, stdout: '', stderr: 'error: Missing the tasks it waits for now, by ID, or --none for nothing.\n\n  See how to use it:\n    vb tasks --help\n' })
    expect(failure(await vb(['tasks', 'needs', review, '--json'])).reason).toBe('missing_arguments')
    const both = await vb(['tasks', 'needs', review, fix, '--none'])
    expect([both.code, both.stdout, both.stderr.split('\n')[0]]).toEqual([2, '', `error: Tasks are what #${review} waits for, and --none for nothing: pass one of them.`])
    expect(await needs(review)).toEqual([notes])
    expect(await ok(['tasks', 'needs', review, '--none'])).toBe(`${review} needs nothing\n`)
    expect((await task(review)).task).toMatchObject({ state: 'ready', needs: [] })
    // For a program: the task as it is now, in one document.
    const json = JSON.parse(await ok(['tasks', 'needs', review, fix, '--json'])) as { task: MessageView; outcome: string }
    expect(Object.keys(json).sort()).toEqual(['outcome', 'task'])
    expect(json).toMatchObject({ outcome: 'set', task: { id: review, task: { state: 'waiting', needs: [fix] } } })

    // What the board refuses is said by what the command was doing, with the board's words under it.
    const circle = await vb(['tasks', 'needs', fix, review])
    expect(circle).toEqual({
      code: 2,
      stdout: '',
      stderr: `error: Can't change what task #${fix} needs. It waits for tasks you can read, and none that waits for it.\n  needs: #${review} waits for #${fix} already: they would wait for each other\n\n  See what it waits for now:\n    vb read ${fix}\n  Or see the tasks there are:\n    vb tasks --state all\n`,
    })
    expect(failure(await vb(['tasks', 'needs', fix, '999999', '--json']))).toMatchObject({ reason: 'invalid_needs', data: { error: { code: 'invalid_needs', status: 400 } } })
    expect(await needs(fix)).toEqual([])
    // It's its owner's to change, while no one holds it and it isn't finished.
    const theirs = await vb(['tasks', 'needs', review, '--none'], await deployment())
    expect([theirs.code, theirs.stderr.split('\n')[0]]).toEqual([1, `error: You can't change what task #${review} needs. It's someone else's.`])
    await ok(['tasks', 'claim', fix])
    const held = await vb(['tasks', 'needs', fix, notes])
    expect([held.code, held.stderr.split('\n')[0], held.stderr.split('\n').slice(2).join('\n')]).toEqual([1, `error: Can't change what task #${fix} needs. Someone holds it.`, `\n  See who holds it, and until when:\n    vb read ${fix}\n`])
    await ok(['tasks', 'complete', fix, 'fixed in a1b2c3'])
    const done = await vb(['tasks', 'needs', fix, notes])
    expect([done.code, done.stderr.split('\n')[0]]).toEqual([1, `error: Can't change what task #${fix} needs. It's finished.`])
    expect(await needs(review)).toEqual([fix])
    // A thread that's no task says so, and how to make it one.
    const thread = (await ok(['post', 'needed', 'export times out'])).trim()
    expect((await vb(['tasks', 'needs', thread, notes])).stderr).toBe(`error: #${thread} isn't a task.\n\n  Make it one:\n    vb tasks create ${thread}\n`)
  }, 60_000)

  it("cancels a task as its owner, and tells anyone else it isn't theirs", async () => {
    const id = await create('cancels', 'rebuild the index')
    const web = await deployment()
    const refused = await vb(['tasks', 'cancel', id, 'mine now'], web)
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    // What a board refuses says which board, as any refusal does.
    expect(refused.stderr).toMatch(new RegExp(`^error: You can't cancel task #${id}\\. It's someone else's\\.\\n  [^\\n]+\\n  Board +${url}\\n\\n  See whose it is:\\n    vb read ${id}\\n$`))
    expect(failure(await vb(['tasks', 'unblock', id, '--json'], web)).reason).toBe('task_not_owned')
    expect(await state(id)).toBe('ready')

    expect(await vb(['tasks', 'cancel', id])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing why, in a line\.\n/) })
    // Canceled by whoever holds it, its claim is over with it: the CLI keeps none.
    await ok(['tasks', 'claim', id])
    expect(await claimOn(id)).toHaveLength(1)
    expect(await ok(['tasks', 'cancel', id, 'superseded by the nightly job'])).toBe(`canceled ${id}\n`)
    expect(await claimOn(id)).toEqual([])
    expect((await task(id)).task).toMatchObject({ state: 'canceled', reason: 'superseded by the nightly job', claim: null })
    expect(failure(await vb(['tasks', 'cancel', id, 'again', '--json']))).toMatchObject({ reason: 'task_finished', message: `Can't cancel task #${id}. It's finished.` })
  }, 60_000)
})

describe('vb tasks run', () => {
  /** A command for `run`: this Node, running `script`. */
  const node = (script: string) => ['--', process.execPath, '-e', script]

  it('claims a task, runs the command with its ID, and completes it when the command exits 0', async () => {
    const id = await create('runs', 'run the tests')
    const ran = await vb(['tasks', 'run', id, '--result', 'tests pass', ...node('console.log(`working on ${process.env.BOARD_TASK}`)')])
    expect(ran).toEqual({ code: 0, stdout: `working on ${id}\ncompleted ${id}\n`, stderr: '' })
    expect((await task(id)).task).toMatchObject({ state: 'completed', epoch: 1, result: 'tests pass' })
    expect(await claimOn(id)).toEqual([])

    // --ready takes the next one, as claim does, and a run with no result completes with none.
    const next = await create('runs', 'lint', ['--label', 'step=lint'])
    expect(await vb(['tasks', 'run', '--ready', 'runs', '--label', 'step=lint', ...node('')])).toEqual({ code: 0, stdout: `completed ${next}\n`, stderr: '' })
    expect((await task(next)).task).toMatchObject({ state: 'completed', result: null })
    expect(failure(await vb(['tasks', 'run', '--ready', 'runs', '--label', 'step=lint', '--json', ...node('')])).reason).toBe('nothing_ready')

    // With --json, stdout is one document: what the command prints on its own stdout comes out on stderr.
    const loud = await create('runs', 'build it')
    const built = await vb(['tasks', 'run', loud, '--json', ...node('console.log("compiled 12 files"); console.error("1 warning")')])
    expect(built).toMatchObject({ code: 0, stderr: 'compiled 12 files\n1 warning\n' })
    expect(JSON.parse(built.stdout)).toMatchObject({ outcome: 'completed', task: { id: loud, task: { state: 'completed' } } })
  }, 60_000)

  it("fails the task with how the command ended, and exits with the command's code", async () => {
    const id = await create('runs', 'deploy it')
    const ran = await vb(['tasks', 'run', id, '--result', 'never said', ...node('console.error("no credentials"); process.exit(3)')])
    expect(ran).toEqual({ code: 3, stdout: `failed ${id}\n`, stderr: 'no credentials\n' })
    expect((await task(id)).task).toMatchObject({ state: 'failed', reason: 'exited 3', result: null })
    expect(await claimOn(id)).toEqual([])

    const killed = await create('runs', 'gets killed')
    const died = await vb(['tasks', 'run', killed, '--json', ...node('process.kill(process.pid, "SIGKILL")')])
    expect(died.code).toBe(137)
    expect(JSON.parse(died.stdout)).toMatchObject({ outcome: 'failed', code: 137, task: { task: { state: 'failed', reason: 'killed by SIGKILL' } } })

    // A command that isn't there never worked the task: it goes back as it was.
    const unrun = await create('runs', 'never starts')
    expect(await vb(['tasks', 'run', unrun, '--', 'no-such-command-anywhere'])).toEqual({
      code: 1,
      stdout: '',
      stderr: `error: Couldn't run no-such-command-anywhere. There's no such command.\n  Task #${unrun} was released.\n`,
    })
    expect((await task(unrun)).task).toMatchObject({ state: 'ready', epoch: 1 })
    expect(await claimOn(unrun)).toEqual([])

    expect(await vb(['tasks', 'run', unrun])).toMatchObject({ code: 2, stderr: 'error: Missing the command to run: put it after --.\n\n  Run a command on a task:\n    vb tasks run <ID> -- <COMMAND>\n' })
    expect(await vb(['tasks', 'run', '--', 'true'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing the task to run it on: its ID, or --ready and a channel\.\n/) })
    // A task someone holds isn't run: the command never starts.
    await ok(['tasks', 'claim', unrun], await bo())
    expect(await vb(['tasks', 'run', unrun, ...node('console.log("ran anyway")')])).toMatchObject({ code: 1, stdout: '', stderr: expect.stringMatching(new RegExp(`^error: Can't claim task #${unrun}\\. Someone holds it\\.`)) })
  }, 60_000)

  it('releases the task and exits 130 when Ctrl-C stops it', async () => {
    const id = await create('runs', 'a long build')
    const running = start(['tasks', 'run', id, ...node('console.log("started"); setTimeout(() => {}, 60_000)')])
    await until(() => running.printed.stdout.includes('started'), 'the command to start')
    expect((await task(id)).task).toMatchObject({ state: 'claimed', epoch: 1 })
    expect(await claimOn(id)).toHaveLength(1)
    running.child.kill('SIGINT')
    expect(await running.exited).toBe(130)
    expect(running.printed).toEqual({ stdout: 'started\n', stderr: '' })
    expect((await task(id)).task).toMatchObject({ state: 'ready', epoch: 1, claim: null })
    expect(await claimOn(id)).toEqual([])
  }, 60_000)

  it("releases the task and exits 143 when a supervisor's SIGTERM stops it", async () => {
    const id = await create('runs', 'a long deploy')
    const running = start(['tasks', 'run', id, ...node('console.log("started"); setTimeout(() => {}, 60_000)')])
    await until(() => running.printed.stdout.includes('started'), 'the command to start')
    expect((await task(id)).task).toMatchObject({ state: 'claimed', epoch: 1 })
    running.child.kill('SIGTERM')
    expect(await running.exited).toBe(143)
    expect(running.printed).toEqual({ stdout: 'started\n', stderr: '' })
    expect((await task(id)).task).toMatchObject({ state: 'ready', epoch: 1, claim: null })
    expect(await claimOn(id)).toEqual([])
  }, 60_000)

  it.concurrent('renews the claim while a long command runs, so a lease shorter than the command holds', async () => {
    const id = await create('renews', 'a build longer than its lease')
    const started = Date.now()
    // A third of a 30s lease is 10s: the command outlasts one renewal.
    const ran = await vb(['tasks', 'run', id, '--lease', '30s', '--result', 'built', ...node('setTimeout(() => {}, 12_000)')])
    expect(ran).toEqual({ code: 0, stdout: `completed ${id}\n`, stderr: '' })
    expect(Date.now() - started).toBeGreaterThan(11_000)
    const renewed = (await events('renews')).filter((event) => event.type === 'task.renewed')
    expect(renewed.map((event) => event.message?.id)).toEqual([id])
    // The renewal asked for the same lease again, from when it renewed.
    const { until: end } = renewed[0]!.payload as { until: string }
    const lease = Date.parse(end) - Date.parse(renewed[0]!.createdAt)
    expect(lease).toBeGreaterThan(29_000)
    expect(lease).toBeLessThanOrEqual(30_000)
    expect((await task(id)).task).toMatchObject({ state: 'completed', result: 'built' })
  }, 60_000)

  it.concurrent('stops the command and exits 1 once a renewal finds the claim lost', async () => {
    const id = await create('loses', 'a build whose task is canceled under it')
    const running = start(['tasks', 'run', id, '--lease', '30s', ...node('console.log("started"); setTimeout(() => { console.log("finished"); }, 40_000)')], asProfile('runner'))
    await until(() => running.printed.stdout.includes('started'), 'the command to start')
    // Its owner cancels the task from another terminal: the next renewal is told, and the command goes with it.
    await ok(['tasks', 'cancel', id, 'no longer needed'])
    expect(await running.exited).toBe(1)
    expect(running.printed.stdout).toBe('started\n')
    expect(running.printed.stderr).toBe(`error: Lost the claim on task #${id} while the command ran, so it was stopped.\n\n  See where the task stands:\n    vb read ${id}\n`)
    expect((await task(id)).task).toMatchObject({ state: 'canceled', reason: 'no longer needed' })
    expect(await claimOn(id)).toEqual([])
  }, 60_000)
})

describe("the CLI's claims", () => {
  it('are found again from a copy of its config, and not from a home without them', async () => {
    const id = await create('moved', 'a task claimed on this machine')
    await ok(['tasks', 'claim', id])
    // Another config home has no claim; the same files, copied, are the same claim.
    const empty = await tmp('board-empty-')
    expect(failure(await vb(['tasks', 'complete', id, '--json'], { XDG_CONFIG_HOME: empty })).reason).toBe('claim_not_held')
    const copy = await tmp('board-copy-')
    await cp(env.XDG_CONFIG_HOME!, copy, { recursive: true })
    expect(await ok(['tasks', 'complete', id, 'from the copy'], { XDG_CONFIG_HOME: copy })).toBe(`completed ${id}\n`)
    expect((await task(id)).task).toMatchObject({ state: 'completed', result: 'from the copy' })
    // The first home's file names a claim that's over now: using it says so, and removes it.
    expect(failure(await vb(['tasks', 'release', id, '--json'])).reason).toBe('claim_lost')
    expect(await claimOn(id)).toEqual([])
  }, 60_000)

  it('stop piling up: a claim whose lease ended days ago goes when the next one is kept', async () => {
    // A run that was killed settles nothing, and leaves its claim behind.
    const left = await create('piles', 'claimed by a run that was killed')
    await ok(['tasks', 'claim', left])
    const recent = await create('piles', 'claimed a moment ago')
    await ok(['tasks', 'claim', recent])
    const [stale] = await claimOn(left)
    const { name, ...claim } = stale!
    await writeFile(join(claimsDir(), name), JSON.stringify({ ...claim, until: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString() }))

    const next = await create('piles', 'the next one')
    await ok(['tasks', 'claim', next])
    expect(await claimOn(left)).toEqual([])
    // What may still be settled stays.
    expect(await claimOn(recent)).toHaveLength(1)
    expect(await claimOn(next)).toHaveLength(1)
    expect(await ok(['tasks', 'complete', recent])).toBe(`completed ${recent}\n`)
  }, 60_000)
})
