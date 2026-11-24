import { workerData } from 'node:worker_threads'
import { openClassifierStore } from '../src/classifier/store.ts'

const shared = new Int32Array(workerData.shared as SharedArrayBuffer)
openClassifierStore(workerData.dir as string, {
  duringRepair() {
    const now = Atomics.add(shared, 0, 1) + 1
    if (now > Atomics.load(shared, 1)) Atomics.store(shared, 1, now)
    const start = Date.now()
    while (Atomics.load(shared, 0) < 2 && Date.now() - start < 400) Atomics.wait(shared, 0, now, 50)
    Atomics.sub(shared, 0, 1)
  },
}).appendCall({
  call_id: workerData.id as string, at: '2026-11-24T00:00:00.000Z', spawner_did: 'wake', costly: false,
})
