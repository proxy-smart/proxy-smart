/**
 * Minimal, dependency-free argv parser.
 *
 * We deliberately hand-roll this instead of pulling in commander/yargs: the
 * command surface is small and well-defined, Bun ships a capable runtime, and
 * a zero-dependency CLI binary is faster to start and trivially reproducible.
 * The README documents this choice.
 *
 * Grammar:  proxy-smart [global-flags] <domain> [verb] [positionals] [flags]
 * Flags:    --key value | --key=value | --bool (boolean) | -h/-v shorthands
 */
import { optionalString } from './json'

/** Parsed representation of an argv line. */
export interface ParsedArgs {
  /** Positional arguments in order (command, subcommand, ids, ...). */
  positionals: string[]
  /** Long/short flags. Boolean flags resolve to `true`. */
  flags: Record<string, string | boolean>
}

/** Short flag aliases expanded to their long form. */
const SHORT_ALIASES: Record<string, string> = {
  h: 'help',
  v: 'version',
  d: 'data',
}

/**
 * Flags that are always boolean (never consume the following token as a value).
 * Everything else treats the next non-flag token as its value.
 */
const BOOLEAN_FLAGS = new Set(['help', 'version', 'json', 'ci', 'yes'])

/** Parse an argv array (excluding node/bun + script path) into structured form. */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!

    if (token === '--') {
      // Everything after `--` is a positional, verbatim.
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

/** Read a flag as a string, or undefined when absent / boolean-only. */
export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  return optionalString(flags[name])
}

/** Read a flag as a boolean (present truthy → true). */
export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true'
}

/**
 * Read a comma-separated list flag (e.g. `--columns a,b,c`) into a string
 * array. Surrounding whitespace is trimmed and empty entries dropped. Returns
 * undefined when the flag is absent or boolean-only, so callers can fall back
 * to their default behavior.
 */
export function flagList(flags: Record<string, string | boolean>, name: string): string[] | undefined {
  const value = flagString(flags, name)
  if (value === undefined) return undefined
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}
