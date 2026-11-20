import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { localBoard, personToken } from './harness.ts'
import { serve } from './http.ts'

it('pauses and resumes a local board from vb, refusing claims without stopping replies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vb-pause-'))
  const team = localBoard({ url: undefined })
  const server = await serve(team.fetch)
  try {
    const url = `${server.origin}/api/board`
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: home,
      BOARD_URL: url,
      BOARD_TOKEN: await personToken('u_operator', url),
    }
    const cli = join(import.meta.dirname, '../src/cli/bin.ts')
    const vb = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, [cli, ...args], { cwd: home, env }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr })
      })
    })
    const success = async (...args: string[]) => {
      const result = await vb(...args)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      return result.stdout.trim()
    }
    expect(await success('status')).toBe('board  running')
    expect(await success('pause', '--reason', 'maintenance')).toBe('board  paused')
    expect(JSON.parse(await success('status', '--json'))).toEqual({ paused: true, pauseEpoch: 1 })
    const id = await success('tasks', 'create', 'work', 'update the runbook')
    await success('reply', id, 'leave this note during the pause')
    const denied = await vb('tasks', 'claim', id, '--json')
    expect(denied.code).toBe(1)
    expect(denied.stdout).toBe('')
    expect(JSON.parse(denied.stderr)).toMatchObject({ reason: 'board_paused' })
    expect(JSON.parse(await success('resume', '--reason', 'all clear', '--json'))).toEqual({ paused: false, pauseEpoch: 1 })
    const claim = JSON.parse(await success('tasks', 'claim', id, '--json'))
    expect(claim.task.id).toBe(id)
  } finally {
    await server.close()
    await team.close()
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)
