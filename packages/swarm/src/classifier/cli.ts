import { fakeClassifier } from './client.ts'
import { unsafeText } from './guard.ts'
import { findQuestion } from './questions.ts'
import { formatReport } from './report.ts'
import { createClassifier } from './service.ts'

const usage = 'usage: swarm classifier report <dir> [--json]\n       swarm classifier clear <dir> <question> --why TEXT'

export function runClassifierCli(args: string[]): number {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return 0 }
  const [command, dir, question, flag, why] = args
  const json = command === 'report' && question === '--json'
  const report = command === 'report' && (args.length === 2 || (args.length === 3 && json))
  const definition = question && findQuestion(question)
  const clear = command === 'clear' && args.length === 5 && definition && flag === '--why' && why?.trim() && !unsafeText.test(why)
  if (!dir || dir.startsWith('--') || (!report && !clear)) {
    console.error(usage)
    return 2
  }
  try {
    const service = createClassifier({ classifier: fakeClassifier({}), dir })
    if (report) {
      const questions = service.report()
      console.log(json ? JSON.stringify({ questions }) : formatReport(questions))
    } else {
      service.clear(question!, why!)
      console.log(`${definition && definition.id}  latch cleared`)
    }
    return 0
  } catch {
    const message = report ? 'cannot read classifier report' : 'cannot clear classifier latch'
    if (json) console.log(JSON.stringify({ error: message }))
    else console.error(`error: ${message}`)
    return 1
  }
}
