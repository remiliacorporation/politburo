// Seeded fixtures. The swarm record types (WP-401 to WP-403) are not on main yet; this is the design's shape (design/swarm-work-items.md). Replace with board reads when they land.
import type { SwarmRecords } from './work.ts'

// The board still supplies task states. For example, plb-4 then shows Running on a live claim,
// while plb-8 can only represent Done if the task itself is terminal and in the snapshot.
export const fixtureRecords: SwarmRecords = {
  source: 'fixtures',
  parties: {
    default: { name: "The People's Party", colour: '#b3261e', openClaimLimit: 4 },
    blue: { name: 'Blue Party', colour: '#1f6feb', openClaimLimit: 2, labels: { repo_view: 'Chapter' } },
  },
  observations: {
    'plb-1': { contract: 'missing', humanRequest: true, spend: { tokens: null, coverage: 'unknown' } },
    'plb-2': {
      contract: 'valid',
      pr: { number: 41, state: 'open', checks: 'fail' },
      spend: { tokens: 142_000, coverage: 'partial' },
      overlap: [{ kind: 'branch', with: 'plb-4' }, { kind: 'pr', with: 'plb-7' }],
    },
    'plb-3': {
      contract: 'valid',
      pr: { number: 42, state: 'open', checks: 'pass', head: '1ab23cd' },
      urls: { source: 'https://example.com/issues/812', pr: 'https://example.com/pull/42' },
      spend: { tokens: 81_000, coverage: 'complete' },
      trackers: [{ kind: 'gh', id: '812' }, { kind: 'lin', id: 'ENG-123' }],
    },
    'plb-4': {
      contract: 'valid', leaseLive: true,
      attempt: 2, branch: 'work/plb-4', handoffReason: 'previous cell reached its time limit',
      pr: { number: 43, state: 'open', checks: 'pending' },
      spend: { tokens: 51_000, coverage: 'stale' },
    },
    'plb-5': {
      contract: 'valid',
      pr: { number: 44, state: 'draft', checks: 'none' },
      overlap: [{ kind: 'possible', with: 'plb-8' }],
    },
    'plb-6': {
      contract: 'valid',
      trackers: [{ kind: 'bd', id: 'rw-4u5' }, { kind: 'native', id: '6' }],
      overlap: [{ kind: 'branch', with: 'plb-5' }, { kind: 'tracker item', with: 'plb-3' }],
    },
    'plb-7': { contract: 'invalid', pr: { number: 45, state: 'closed', checks: 'unknown' } },
    'plb-8': { contract: 'valid', pr: { number: 46, state: 'merged', checks: 'pass' } },
  },
}
