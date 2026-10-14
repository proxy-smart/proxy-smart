# @proxy-smart/cli

`proxy-smart` — an admin CLI for the [proxy-smart](https://github.com/proxy-smart/proxy-smart)
SMART on FHIR authorization proxy. It authenticates via Keycloak OAuth and drives
the proxy's admin REST API through a generated, fully typed API client.

It is a Bun TypeScript-source package (no build step). The `bin` points straight
at `src/index.ts`, which carries a `#!/usr/bin/env bun` shebang.

## Install

The package is published to the GitHub npm registry in lockstep with the rest of
the monorepo. With a registry-scoped `.npmrc` configured for `@proxy-smart`:

```bash
bun add -g @proxy-smart/cli
# or run it without installing, from a checkout:
bun run packages/cli/src/index.ts --help
```

Within this monorepo it is wired as a workspace, so `bun install` at the repo
root resolves it and you can run it directly with `bun`.

## Configuration

Settings resolve in this precedence order (highest first):

1. command-line flags
2. environment variables (`PROXY_SMART_*`)
3. the persisted config file at `~/.proxy-smart/config.json`
4. built-in defaults

| Setting        | Flag                | Env var                       | Default                  |
| -------------- | ------------------- | ----------------------------- | ------------------------ |
| Proxy base URL | `--url`             | `PROXY_SMART_URL`             | `http://localhost:8445`  |
| Client id      | `--client-id`       | `PROXY_SMART_CLIENT_ID`       | `admin-ui`               |
| Client secret  | `--client-secret`   | `PROXY_SMART_CLIENT_SECRET`   | (unset)                  |
| Scopes         | `--scope`           | `PROXY_SMART_SCOPE`           | `openid profile email`   |
| CLI home dir   | —                   | `PROXY_SMART_HOME`            | `~/.proxy-smart`         |

The config file and the cached token live under `~/.proxy-smart/` (override the
whole directory with `PROXY_SMART_HOME`). The token cache is written with
owner-only (`0600`) permissions.

## Authentication

The CLI is **proxy-first**: by default every grant flows through the proxy's
auth layer (`${PROXY_SMART_URL}/auth/...`), where audience binding, token
enrichment, and access control are applied. Endpoints are discovered from the
proxy's mirrored OIDC document at `/auth/.well-known/openid-configuration`.

Two grants are supported, matching what the backend already accepts:

### Interactive device flow (humans)

```bash
proxy-smart login
```

Prints a verification URL (and a user code) to open in a browser, then polls
until you approve. The resulting token (and refresh token, when issued) is cached
and transparently refreshed on later commands.

### `client_credentials` (CI / service accounts)

Set a client secret and `login` automatically uses the `client_credentials`
grant (or pass `--ci` to force it):

```bash
export PROXY_SMART_URL=https://proxy.example.com
export PROXY_SMART_CLIENT_ID=admin-service
export PROXY_SMART_CLIENT_SECRET=...    # provided by CI secrets
proxy-smart smart-apps list --json
```

With a secret present the CLI will even mint a token on demand if none is cached,
so a bare `proxy-smart <command>` works in CI without an explicit `login` step.

### There is no Keycloak-direct mode

The CLI cannot be pointed at Keycloak instead of the proxy, and that is
deliberate. The proxy rewrites its discovery document to itself and validates
the access-token audience fail-closed, so a token minted straight from Keycloak
is rejected on the very next call. An escape hatch would only ever produce a
confusing 401.

Everything that once needed direct Keycloak access — protocol mappers, client
roles, token audience — is a first-class command; see
[Token audience and protocol mappers](#token-audience-and-protocol-mappers) and
[Roles](#roles). Anything not yet wrapped is reachable through
`proxy-smart request <METHOD> <path>`, which still goes through the proxy.

## Commands

```
login                 Sign in (device flow; client_credentials when a secret is set)
logout                Remove the cached token
whoami                Show the identity behind the cached token

request <METHOD> <path> [--data <json>]
                      Authenticated escape hatch — call any proxy path

smart-apps        list | get <clientId> | create | update <clientId> | delete <clientId>
                  mappers <clientId> | create-mapper <clientId>
                  update-mapper <clientId> <mapperId> | delete-mapper <clientId> <mapperId>
                  add-audience <clientId> <audience> [--name <n>] [--id-token]
roles             list [--include-technical] | get <name> | create
                  update <name> | delete <name> --yes
                  client-roles <clientId> | client-get <clientId> <name>
                  client-create <clientId> | client-update <clientId> <name>
                  client-delete <clientId> <name> --yes
healthcare-users  list | get <userId> | create | delete <userId>
scope-sets        list | get <id> | create | delete <id>
smart-scopes      list | create | batch | delete <scopeId>
mcp-endpoint      get | update

idps              list | get <alias> | create | update <alias> | delete <alias>
                  mapper-status [alias] | mappers <alias> | mapper-types <alias>
                  fix-mappers <alias> [--required-only]
                  create-mapper <alias> | update-mapper <alias> <mapperId>
                  delete-mapper <alias> <mapperId>
user-federation   list | get <id> | create | update <id> | delete <id> --yes
                  sync <id> [--action triggerFullSync|triggerChangedUsersSync]
                  mappers <id> | mapper-types <id>
                  create-mapper <id> | update-mapper <id> <mapperId>
                  delete-mapper <id> <mapperId>

shutdown --yes        Gracefully stop the proxy server (POST /admin/shutdown)
restart  --yes        Restart the proxy server (POST /admin/restart)
```

Request bodies are supplied as JSON via `--data`:

- `--data '{"name":"X"}'` — inline JSON
- `--data @file.json` — read from a file
- `--data -` — read from stdin

`list` commands render an aligned table by default; pass `--json` for raw JSON.

### Examples

```bash
proxy-smart login
proxy-smart smart-apps list --json
proxy-smart smart-apps get my-client-id
proxy-smart smart-apps create --data @app.json
proxy-smart scope-sets create --data '{"name":"Reader","scopes":["patient/*.read"]}'
proxy-smart smart-scopes list --smart-only
proxy-smart smart-scopes batch --data '{"scopes":[{"name":"patient/Binary.cruds"},{"name":"patient/DocumentReference.cruds"}]}'
proxy-smart smart-apps mappers patient-portal
proxy-smart smart-apps add-audience patient-portal fhir-resource-server
proxy-smart roles list
proxy-smart roles client-roles admin-ui
proxy-smart healthcare-users list --limit 50
proxy-smart mcp-endpoint update --data '{"enabled":true,"disabledTools":["delete_admin_smart_apps"]}'
proxy-smart idps mapper-status --strict
proxy-smart idps mappers hospital-oidc
proxy-smart idps fix-mappers hospital-oidc
proxy-smart user-federation mappers ldap-1 --strict
proxy-smart request GET /admin/smart-config
proxy-smart restart --yes
```

### Token audience and protocol mappers

A client's protocol mappers decide what its tokens contain, and the proxy
validates the access-token audience fail-closed — so a client whose `aud` is
wrong cannot launch at all. `smart-apps mappers` shows what a client emits;
`smart-apps add-audience` writes the audience mapper:

```bash
proxy-smart smart-apps mappers patient-portal
proxy-smart smart-apps add-audience patient-portal fhir-resource-server
proxy-smart smart-apps add-audience patient-portal https://fhir.example.com/R4
```

The audience may name another client in the realm or be a literal URL. Keycloak
stores those under two different config keys (`included.client.audience` versus
`included.custom.audience`) and silently emits nothing if the wrong one is used;
the proxy resolves which applies. The call is idempotent, so it is safe to run
unguarded from a deploy or reconcile step — a second run reports
`created: false` and changes nothing.

Anything the shorthand does not cover goes through the generic verbs:

```bash
proxy-smart smart-apps create-mapper patient-portal --data '{
  "name": "fhirUser",
  "protocolMapper": "oidc-usermodel-attribute-mapper",
  "config": {"user.attribute":"fhirUser","claim.name":"fhirUser","access.token.claim":"true"}
}'
proxy-smart smart-apps update-mapper patient-portal <mapperId> --data '{"config":{"id.token.claim":"true"}}'
proxy-smart smart-apps delete-mapper patient-portal <mapperId>
```

`update-mapper` merges the config entries you pass into the existing mapper, so
you can flip one key without restating the whole thing.

### Roles

Realm roles and client roles have separate verbs rather than sharing one with a
`--client` flag: they are different Keycloak resources, and a forgotten flag
should not silently write the wrong one. Client verbs take the OAuth client id
and resolve the internal Keycloak id server-side.

```bash
proxy-smart roles list                       # plumbing roles hidden by default
proxy-smart roles list --include-technical
proxy-smart roles create --data '{"name":"clinician","fhirScopes":["patient/*.read"]}'
proxy-smart roles client-roles admin-ui
proxy-smart roles client-create admin-ui --data '{"name":"app-admin"}'
proxy-smart roles client-delete admin-ui app-admin --yes
```

Roles carry descriptive metadata only. The `fhirScopes` and represented
scope-set fields are labels for "the scopes this role typically stands for";
FHIR and MCP access stays scope-based and is never derived from them.

### Claim mapping as a CI check

Brokered and directory users only carry the attributes a mapper imports for
them, and a user without `fhirUser` cannot be launched into a SMART app. Both
mapper listings accept `--strict`, which exits non-zero when a required import
is missing, so a pipeline can assert a realm is launch-ready:

```bash
proxy-smart idps mapper-status --strict            # every provider in the realm
proxy-smart user-federation mappers <id> --strict  # one LDAP provider
```

`idps fix-mappers <alias>` provisions what is missing and exits non-zero if
Keycloak rejected any of it. There is deliberately no equivalent for LDAP: the
directory attribute holding the FHIR reference is deployment-specific, so it
cannot be guessed.

## Programmatic API

`src/index.ts` is both the `bin` and the package entry point, so everything the
CLI is built from is importable. This is useful when you want the CLI's auth and
config handling in a deploy script without shelling out to it.

```ts
import { resolveConfig, Session, createApiClient } from '@proxy-smart/cli'

const config = resolveConfig({ url: 'https://proxy.example.com' })
const session = new Session(config)
const api = createApiClient(config, session)

const apps = await api.smartApps.getAdminSmartApps()
```

### Configuration

`resolveConfig(overrides?, env?)` applies the precedence order above and returns
a `ResolvedConfig` with `url`, `clientId`, `clientSecret`, `scope` and `homeDir`.
Both arguments are injectable, so it is testable without touching the real
environment. `ConfigOverrides` is the flag-shaped input; `PersistedConfig` is the
narrower shape written to disk.

`ENV` is the single source of truth for the recognised variable names, and
`DEFAULT_PROXY_URL`, `DEFAULT_CLIENT_ID` and `DEFAULT_SCOPE` are the built-in
fallbacks. `DEFAULT_CLIENT_ID` is `admin-ui` rather than a dedicated CLI client:
the backend already accepts tokens whose `azp` is `admin-ui`, and that client has
the device grant enabled in every realm export, so a device-flow token passes the
admin API with no extra audience configuration.

`normalizeUrl` strips a trailing slash. `resolveHomeDir`, `configPath` and
`tokenCachePath` locate the CLI home and its two files.
`readPersistedConfig` and `writePersistedConfig` read and write `config.json`
(created `0600`), and `clearTokenCache` removes the cached token.

### Session and token cache

`Session` manages OAuth endpoints and token acquisition for one invocation,
memoizing discovery. Its constructor takes `ResolvedConfig` plus three injectable
seams — `fetchImpl`, `SleepImpl` and `NowImpl` — which exist so tests can drive
the device-flow poll loop without sleeping in real time.

| Method | Purpose |
|---|---|
| `resolveEndpoints()` | Discover and memoize the proxy's OIDC endpoints |
| `loginWithDeviceFlow(prompt)` | RFC 8628 device flow; `prompt` is a `DevicePrompt` receiving the `DeviceAuthResponse` to display |
| `loginWithClientCredentials()` | Non-interactive grant; requires a client secret |
| `getAccessToken()` | Return a valid bearer token, refreshing or minting as needed |
| `logout()` | Clear the cached token |

`CachedToken` is the on-disk record. `readCachedToken` tolerates a missing,
partial or corrupt file by returning `undefined` rather than throwing, and
`writeCachedToken` writes to a unique temp file and renames it into place, so a
concurrent reader sees either the old token or the new one and never a torn file.
`toCachedToken` maps a fresh `TokenSet` onto that record.

`deploymentMismatch(cached, targetUrl)` guards the failure mode that motivated
recording a URL in the cache at all. A token is only valid for the deployment
that issued it, and the resolved `--url` can change between invocations, so
`login --url https://beta…` followed by a bare command used to present a beta
token to whatever the default resolved to. The dangerous case is not the opaque
401: it is two deployments that both accept the token, where the command quietly
succeeds against the wrong environment. It returns a message naming both URLs, or
`undefined` when they agree.

### OAuth helpers

`proxyDiscoveryUrl(proxyUrl)` builds the discovery URL, and
`endpointsFromMetadata(meta)` reduces the document to the `AuthEndpoints` the CLI
needs. `parseOidcMetadata`, `parseDeviceAuthResponse` and `parseTokenSet` validate
untrusted responses into `OidcMetadata`, `DeviceAuthResponse` and `TokenSet`, and
`asTokenError` recognises an OAuth error body, returning a `TokenError` or
`undefined`.

`deviceAuthBody`, `deviceTokenBody`, `clientCredentialsBody` and
`refreshTokenBody` build the form-encoded request bodies for each grant;
`formEncode` is the shared encoder.

`generatePkcePair(randomImpl?)` produces a `PkcePair`, `deriveCodeChallenge`
computes the S256 challenge from a verifier, and `PKCE_METHOD_S256` is the method
name. `expiresAt(expiresIn, now?)` converts a relative lifetime to an absolute
epoch second, and `isTokenFresh(expiresAt, skewSeconds?, now?)` answers whether a
token is still usable, defaulting to 30 seconds of clock skew.

### Argument parsing

`parseArgs(argv)` returns `ParsedArgs` with the command, positional arguments and
flags. `flagString`, `flagBool` and `flagList` read a single flag out of that map
with the right coercion. `overridesFromFlags(flags)` turns the global flags into
`ConfigOverrides`, and `run(argv)` is the whole CLI, returning a process exit
code.

### API client

`createApiClient(config, session)` returns an `ApiClient` bundling the generated
API surfaces (`smartApps`, `healthcareUsers`, `scopeSets`, `mcp`, `admin`,
`identityProviders`, `userFederation`, `roles`) plus the `basePath` they are bound
to. All of them share one `Configuration` whose `accessToken` callback delegates
to the session, so every call lazily obtains and transparently refreshes its own
bearer token and no caller has to think about token lifetime.

## The generated API client

`src/api-client/` is a **generated copy**, produced from the backend's exported
OpenAPI document with the same generator the admin UI uses. Model types are
never hand-rolled.

The generator, `openapi-ts-fetch`, is this repo's own pure-Python tool. It is
installed from PyPI with pip/uv and pinned to `==0.3.0` in CI (it is **not** a
bun/npm package and is not resolved via `bunx` or the GitHub package registry):

```bash
pip install openapi-ts-fetch==0.3.0   # or: uv pip install openapi-ts-fetch==0.3.0
```

Regenerate the client whenever the admin API changes:

```bash
# 1. export the OpenAPI document from the backend
bun run --filter backend export-openapi      # writes backend/dist/openapi.json

# 2. regenerate the scoped client
cd packages/cli && bun run generate
```

The `generate` script scopes the client to the tags the CLI actually drives via
the generator's `--tags` flag (supported by `openapi-ts-fetch==0.3.0`):

```
openapi-ts-fetch ../../backend/dist/openapi.json ./src/api-client \
  --tags smart-apps,healthcare-users,scope-sets,mcp-management,admin,identity-providers,user-federation,roles
```

It requires `backend/dist/openapi.json` to exist first (step 1 above). Adding a
command for a route under a new tag means adding that tag here first, otherwise
the route is absent from the generated client.

`bun run generate` from the repo root does both steps for every generated client
(admin UI and CLI), and is what CI runs. The generated directories are
gitignored, so a client left out of that script does not exist in a clean
checkout at all.

## Why a hand-rolled arg parser?

The command surface is small and well-defined, Bun ships a capable runtime, and
a zero-runtime-dependency CLI binary is faster to start and trivially
reproducible. So instead of pulling in `commander`/`yargs`, argument parsing is a
~100-line, fully unit-tested module (`src/args.ts`). If the command surface grows
substantially, swapping in a commander-style library is a contained change.

## Development

```bash
cd packages/cli
bun run typecheck   # tsc --noEmit
bun run lint        # eslint . (the generated client is ignored)
bun test            # pure unit tests for config, token cache, and auth logic
```
