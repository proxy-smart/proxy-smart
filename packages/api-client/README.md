# @proxy-smart/api-client

Typed fetch client for the Proxy Smart admin and FHIR API, generated from the backend's own OpenAPI spec.

The spec is the contract. `src/generated/` is emitted by `openapi-ts-fetch` from `backend/dist/openapi.json` and is never edited by hand; `src/index.ts` decides which of it is public API. Regenerating is `bun run build` — it re-emits, bundles each entry point, and emits declarations.

The entries are bundled rather than compiled file-by-file on purpose. The generator writes extensionless relative imports, which a bundler resolves and Node's ESM resolver does not — so a `tsc`-only build works under Vite and fails under anything loading the package through Node, `vitest` included.

This exists so consumers outside this repository — the admin UI, and anything else that talks to the API — can install a client instead of reaching into `backend/dist/` for a spec file and running a generator themselves.

## Install

```bash
bun add @proxy-smart/api-client
```

Published to GitHub Packages, so the `@proxy-smart` scope needs to point at `https://npm.pkg.github.com`. Inside this repository it is a workspace dependency and needs no registry configuration.

## Usage

```ts
import { AuthenticationApi, Configuration } from '@proxy-smart/api-client'

const api = new AuthenticationApi(new Configuration({
  basePath: 'https://proxy.example.com',
  accessToken: () => token,
}))
```

One class per OpenAPI tag — `AdminApi`, `AuthenticationApi`, `FhirApi`, `SmartAppsApi` and so on, 26 in total covering 249 operations. Request and response models come from the same generation, so a route's declared schema is the type you get.

Subpaths expose the pieces individually: `./apis`, `./models`, `./runtime`.

## Supported surface

`Configuration` takes the `basePath`, credentials and middleware; `ConfigurationParameters` is its shape. `accessToken` accepts a function, which is what lets a caller hand over a token that is refreshed elsewhere without rebuilding the client.

`ResponseError` is thrown for a non-2xx response and carries the raw `response`, so a caller can read the status and body. `FetchError` covers a transport failure with no response at all, and `RequiredError` a missing required parameter — that one is a programming error rather than a runtime condition. `BASE_PATH` is the spec's declared server URL, used when no `basePath` is given.

`Middleware` intercepts requests and responses, receiving a `RequestContext` or `ResponseContext`. `HTTPHeaders`, `HTTPQuery` and `InitOverrideFunction` type the per-call overrides.

## Generator plumbing

The generated runtime also exports its own internals. They are reachable through `./runtime` for anyone who needs them, but they are not part of this package's supported surface and may change whenever the generator does: `ApiResponse`, `BaseAPI`, `BlobApiResponse`, `COLLECTION_FORMATS`, `Consume`, `DefaultConfig`, `ErrorContext`, `FetchAPI`, `FetchParams`, `HTTPBody`, `HTTPMethod`, `HTTPRequestInit`, `Json`, `JSONApiResponse`, `ModelPropertyNaming`, `RequestOpts`, `ResponseTransformer`, `TextApiResponse`, `VoidApiResponse`, `canConsumeForm`, `mapValues`, `querystring`.

Treat anything in that list as an implementation detail: it is generator boilerplate, not API this repository designed.

## Regenerating

```bash
cd backend && bun run export-openapi   # refresh backend/dist/openapi.json
bun run generate                        # from the repo root — this package and the CLI
```

CI does both before building the frontend. `src/generated/` and `dist/` are gitignored, so a checkout without a generate step has no client at all rather than a stale one.
