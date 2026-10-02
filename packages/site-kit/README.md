# @proxy-smart/site-kit

The server-rendered pieces every Proxy Smart web page shares, so the backend's own pages and any site built around a deployment look and behave the same without copying each other.

| Export | What it is |
|---|---|
| `SiteNav`, `SiteFooter`, `NavLink`, `SiteSource` | Site chrome with the theme and mobile-nav toggles. `SiteNav` takes an `assetBase` for sites served under a prefix; `SiteFooter` takes `extraLinks`. |
| `AppIcon`, `isAppIconKey`, `FALLBACK_APP_ICON`, `AppIconKey` | The curated app glyph set. An unknown key falls back to a generic window. |
| `Glyph`, `GlyphName` | Every glyph as a bare SVG: the app set plus interface and diagram glyphs (`database`, `key`, `check`, `filter`), one drawing per concept. Its stroke follows `currentColor` unless a stylesheet sets `stroke`. |
| `PRODUCT` | Product name, author, community and licence labels. |
| `safeUrl`, `asset` | `safeUrl` lets only same-origin paths and https URLs reach an `href` or `src`; `asset` appends a cache-busting version. |
| `THEME_STORAGE_KEY`, `THEME_BOOT_SCRIPT` | The stored light/dark choice, applied before first paint. |
| `BASE_CSS` | The base stylesheet as text, for a server to serve at its own path. The file is also exported as `@proxy-smart/site-kit/base.css`. |

Components are Hono JSX (`jsxImportSource: "hono/jsx"`). Colours, radii and type come from [brandc](https://www.npmjs.com/package/brandc) tokens; the stylesheet defines layout only.

`BASE_CSS` is a text import (`with { type: 'text' }`), which Bun inlines when bundling. A TypeScript consumer needs `module` set to `esnext` or `preserve` for the import attribute to type-check.
