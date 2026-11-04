import { optionalString } from './json'

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

const SHORT_ALIASES: Record<string, string> = {
  h: 'help',
  v: 'version',
  d: 'data',
}

/** Never consume the next token; any other flag takes the next non-flag token as its value. */
const BOOLEAN_FLAGS = new Set(['help', 'version', 'json', 'ci', 'yes'])

/** argv without runtime and script: --key value | --key=value | --bool | -h/-v/-d, and `--` ends flags. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!

    if (token === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=')
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1)
        continue
      }
      const name = token.slice(2)
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      const name = SHORT_ALIASES[short] ?? short
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true
        continue
      }
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next
        i++
      } else {
        flags[name] = true
      }
      continue
    }

    positionals.push(token)
  }

  return { positionals, flags }
}

/** Undefined when absent or given without a value. */
export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  return optionalString(flags[name])
}

/** True for a bare flag or the literal value `true`. */
export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true'
}

/** `--columns a, b,,c` → ['a', 'b', 'c']; undefined when absent or empty, so callers fall back to defaults. */
export function flagList(flags: Record<string, string | boolean>, name: string): string[] | undefined {
  const value = flagString(flags, name)
  if (value === undefined) return undefined
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}
