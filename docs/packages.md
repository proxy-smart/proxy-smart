# Packages

Packages published from this repository. Each one exists because something in the platform was worth using without the platform.

| Package | What it owns | Reference |
|---|---|---|
| `@proxy-smart/api-client` | The generated client for this backend's API, produced from its own OpenAPI spec | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/api-client/README.md) |
| `@proxy-smart/app-store` | Visibility and publication state for the app catalog | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/app-store/README.md) |
| `@proxy-smart/cli` | The `proxy-smart` admin CLI, and the OAuth and config machinery behind it | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/cli/README.md) |
| `@proxy-smart/elysia-mcp` | Deriving MCP tools and resources from an Elysia route table, and executing them back through it | [README](https://github.com/proxy-smart/proxy-smart/blob/main/packages/elysia-mcp/README.md) |

## Where the boundaries fall

`@proxy-smart/app-store` is small and exists for one reason: apps arrive in the catalog by two different routes, keyed two different ways, and the rule for hiding one is not the rule for hiding the other. Keeping that in a package keeps the two rules side by side.

`@proxy-smart/cli` is a binary first, but its entry point re-exports the pieces it is built from, so a deploy script can reuse the config resolution and token handling instead of shelling out.

`@proxy-smart/api-client` is generated from the OpenAPI spec this backend exports, which is why it lives here rather than anywhere else: a route change and its client change in the same commit.

## `packages/auth` is internal

The SMART authorization layer — launch context, session handling, scope narrowing, token enrichment — is a workspace package but is **not published**. It is `private: true`, so the publish pipeline skips it.

It is framework-agnostic and IdP-pluggable, and it stays that way because those are good properties for the code regardless of who installs it. But it is linked into the backend rather than talked to over a wire, so it is part of the same work as far as this repository's licence is concerned. Publishing it as a separately-licensed artifact would put a build dependency of an AGPL program outside that program's Corresponding Source, which is not a thing to do to anyone who takes this repository at its word.

That it is unpublished costs nothing in practice: nothing outside this repository consumed it.

## `elysia-mcp` stays, on its own version

Deriving MCP tools and resources from an Elysia route table has nothing to do with SMART or FHIR, and the package says so by stopping short of the HTTP edge: hosts serve MCP with `@maxhealth.tech/mcp-http` instead. It is still published from here as `@proxy-smart/elysia-mcp`, and the backend consumes it as a workspace dependency, so a route change and the tool derived from it land in the same commit.

What it does not do is inherit the platform's version — it is `versionPolicy: independent`, like `@proxy-smart/app-store`.

## Versioning

`@proxy-smart/api-client` and `@proxy-smart/cli` version in lockstep with the platform. See [Version Management](./tutorials/version-management.md) for how the version is set and which branch produces which release type.

A package that is meant to be usable *without* the platform should not inherit the platform's version, which is why `@proxy-smart/elysia-mcp` and `@proxy-smart/app-store` are marked `versionPolicy: independent` and are not stamped by releases they have no part in.
