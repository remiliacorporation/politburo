import { writeFileSync } from 'node:fs'
import { partyConfigReference } from '../src/config/reference.ts'

const target = new URL('../docs/party-config-reference.md', import.meta.url)
writeFileSync(target, partyConfigReference())
