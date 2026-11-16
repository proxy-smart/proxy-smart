# @proxy-smart/guards

Zero-dependency type guards for narrowing unknown JSON without type assertions, and the access posture contract every Proxy Smart deployment declares. The backend, the CLI, the admin UI and the sites built around a deployment import these instead of keeping their own copies.

| Export | What it is |
|---|---|
| `isRecord`, `requireRecord` | A plain JSON object (arrays excluded); `requireRecord` throws naming the value when it is anything else. |
| `stringEntries` | The string-valued entries of an object. |
| `parseJson`, `parseJsonRecord` | JSON text parsed without throwing: `undefined` (or `null` for a non-object) when absent or malformed. |
| `optionalString`, `optionalNumber` | The value when it has that type, else `undefined`. |
| `isStringArray`, `stringArray`, `stringList` | An array of strings; the strings of an array; one string or a list of them as a list. |
| `isOneOf` | Narrows a value to one of a closed set of string literals. |
| `isHttpUrl` | An absolute `http:` or `https:` URL. |
| `ENFORCEMENT_MODES`, `EnforcementMode`, `isEnforcementMode`, `requireEnforcementMode` | `enforce`, `audit-only` and `disabled`, the modes every access control runs in. |
| `ACCESS_POSTURE_SETTINGS`, `AccessPosture`, `AccessPostureKey`, `parseAccessPosture`, `accessPostureMode` | The keys of a deployment's `access-posture.json`, the setting that overrides each one, a parser that rejects any entry that is not a mode, and a reader for a single key, for a consumer that shows only some of them. Also exported as `@proxy-smart/guards/posture`. |

Like the other `@proxy-smart` packages it ships TypeScript source, so it needs a bundler or a runtime that loads `.ts` (Bun, Vite, tsx).
