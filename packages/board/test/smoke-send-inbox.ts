// The smoke test runs this with an isolated CLI home to reuse its login without changing the test's environment.
import type { SendOperationalMessageInput } from '../src/api/routes.ts'
import { http } from '../src/backend-http/index.ts'
import { connect } from '../src/client/node.ts'
import { board, BoardError } from '../src/server/index.ts'

try {
  const [url, input] = process.argv.slice(2)
  const team = board({ backend: http(url!, { fetch: connect(url!).fetch }) }).as(null)
  const { message } = await team.operationalInbox.send(JSON.parse(input!) as SendOperationalMessageInput)
  process.stdout.write(JSON.stringify({ id: message.id }))
} catch (error) {
  // Report only the refusal metadata, never the request or credential.
  process.stderr.write(JSON.stringify(error instanceof BoardError
    ? { code: error.code, status: error.status }
    : { code: 'send_failed' }))
  process.exitCode = 1
}
