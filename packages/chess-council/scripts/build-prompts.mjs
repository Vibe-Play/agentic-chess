import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const promptsDir = join(here, '..', 'src', 'prompts')
const out = join(here, '..', 'src', 'prompts.generated.ts')

const files = readdirSync(promptsDir).filter((f) => f.endsWith('.md'))
const entries = {}
for (const file of files) {
  const key = basename(file, '.md').replace(/^_/, '')
  entries[key] = readFileSync(join(promptsDir, file), 'utf8').trimEnd()
}

const escape = (s) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`'

const lines = ['// AUTO-GENERATED from src/prompts/*.md — do not edit.', '']
for (const [key, value] of Object.entries(entries)) {
  lines.push(`export const ${key}Prompt: string = ${escape(value)}`)
  lines.push('')
}

writeFileSync(out, lines.join('\n'))
console.log(`wrote ${out} (${Object.keys(entries).length} prompts)`)
