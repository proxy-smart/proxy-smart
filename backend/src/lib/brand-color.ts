/**
 * Validation for admin-supplied brand colours.
 *
 * The login page renders an organization's colour into a stylesheet, so an unvalidated
 * value is a CSS injection: `#000; } body { display: none } :root {` closes our rule and
 * opens its own. Only shapes that cannot carry `;`, `}`, a comment or a `url()` are
 * accepted, and the value is re-checked where it is emitted rather than trusted because
 * it survived the admin API.
 */

/** #rgb, #rgba, #rrggbb, #rrggbbaa. */
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * rgb/rgba/hsl/hsla with one flat argument list. The character class carries no `(`, so a
 * nested `var()` or `calc()` cannot appear, and no `;`, `}` or `*` either.
 */
const FUNCTIONAL = /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.,%\s/+-]+\)$/i

/** A bare keyword (`rebeccapurple`, `transparent`). Letters only, so nothing can hide. */
const KEYWORD = /^[a-z]+$/i

/** Longer than any real colour, so a payload cannot arrive disguised as one. */
const MAX_LENGTH = 48

export function isCssColor(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const colour = value.trim()
  if (colour === '' || colour.length > MAX_LENGTH) return false
  return HEX.test(colour) || FUNCTIONAL.test(colour) || KEYWORD.test(colour)
}

/** The colour, trimmed, or null when it is not something we are willing to emit. */
export function safeCssColor(value: unknown): string | null {
  return isCssColor(value) && typeof value === 'string' ? value.trim() : null
}

export function brandAccent(colors: { primaryColor?: string | null; accentColor?: string | null }): string | null {
  return safeCssColor(colors.accentColor) ?? safeCssColor(colors.primaryColor)
}
