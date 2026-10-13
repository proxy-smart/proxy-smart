# Packages

Packages published from this repository. Each one exists because something in the platform was worth using without the platform.

| Package | What it owns | Reference |
|---|---|---|
| `@proxy-smart/api-client` | The generated client for this backend's API, produced from its own OpenAPI spec | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/api-client/README.md) |
| `@proxy-smart/app-store` | Visibility and publication state for the app catalog | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/app-store/README.md) |
| `@proxy-smart/cli` | The `proxy-smart` admin CLI, and the OAuth and config machinery behind it | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/cli/README.md) |
| `@proxy-smart/site-kit` | The server-rendered pieces every Proxy Smart page shares: site chrome, app icons, product identity, URL safety and the base stylesheet | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/site-kit/README.md) |

## Where the boundaries fall

`@proxy-smart/app-store` is small and exists for one reason: apps arrive in the catalog by two different routes, keyed two different ways, and the rule for hiding one is not the rule for hiding the other. Keeping that in a package keeps the two rules side by side.

`@proxy-smart/cli` is a binary first, but its entry point re-exports the pieces it is built from, so a deploy script can reuse the config resolution and token handling instead of shelling out.

`@proxy-smart/api-client` is generated from the OpenAPI spec this backend exports, which is why it lives here rather than anywhere else: a route change and its client change in the same commit.

`@proxy-smart/site-kit` exists so that a site built around a deployment renders the same chrome, icons and stylesheet as the backend's own pages without copying them. The backend serves its stylesheet at `/css/base.css`; a static site writes it out at build time.

## `packages/auth` is internal

The SMART authorization layer — launch context, session handling, scope narrowing, token enrichment — is a workspace package but is **not published**. It is `private: true`, so the publish pipeline skips it.

It is framework-agnostic and IdP-pluggable, and it stays that way because those are good properties for the code regardless of who installs it. But it is linked into the backend rather than talked to over a wire, so it is part of the same work as far as this repository's licence is concerned. Publishing it as a separately-licensed artifact would put a build dependency of an AGPL program outside that program's Corresponding Source, which is not a thing to do to anyone who takes this repository at its word.

That it is unpublished costs nothing in practice: nothing outside this repository consumed it.

## `elysia-mcp` moved out

Deriving MCP tools and resources from an Elysia route table has nothing to do with SMART or FHIR, so it now lives in its own repository, [max-network/elysia-mcp](https://github.com/max-network/elysia-mcp), and ships to public npm as [`@maxhealth.tech/elysia-mcp`](https://www.npmjs.com/package/@maxhealth.tech/elysia-mcp) under Apache-2.0, next to the `@maxhealth.tech/mcp-http` edge that serves what it derives. The backend installs it like any other dependency. Its source is public, so it stays inside the Corresponding Source a deployment of this repository has to offer, which is the property `packages/auth` is kept in-tree to protect.

The cost is that a change to the derivation no longer lands in the same commit as the route it serves: it is released there first, then picked up here by a version bump.

## Versioning

`@proxy-smart/api-client` and `@proxy-smart/cli` version in lockstep with the platform. See [Version Management](./tutorials/version-management.md) for how the version is set and which branch produces which release type.

A package that is meant to be usable *without* the platform should not inherit the platform's version, which is why `@proxy-smart/app-store` and `@proxy-smart/site-kit` are marked `versionPolicy: independent` and are not stamped by releases they have no part in.
