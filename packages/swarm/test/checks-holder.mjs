import { tryAcquire } from '../src/checks/lock.ts'

const lock = await tryAcquire(process.argv[2])
if (!lock.ok) process.exit(1)
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.send('held')
