# Keycloak version & feature reference

Single source of truth for **which Keycloak version proxy-smart runs and which feature
flags it enables**, to avoid ambiguity (e.g. assuming a preview feature has graduated when
it hasn't). Feature statuses below are verified against the authoritative
[`Profile.java` at the Keycloak `26.7.5` tag](https://github.com/keycloak/keycloak/blob/26.7.5/common/src/main/java/org/keycloak/common/Profile.java).

## Versions

Server and admin-client are **both pinned to 26.7.5** and move together. The admin-client is
pinned exactly because 26.7.0 to 26.7.2 broke `client_credentials` auth (below).

| Component | Version | Where it's pinned |
| --- | --- | --- |
| Keycloak server (prod/beta, custom image) | **26.7.5** | [`Dockerfile.keycloak`](../Dockerfile.keycloak) (`FROM quay.io/keycloak/keycloak:26.7.5`) |
| Keycloak server (local dev) | **26.7.5** | `docker-compose.yml`, `docker-compose.development.yml` |
| Keycloak server (SMART compliance CI) | read from `Dockerfile.keycloak` | `.github/workflows/smart-compliance-tests.yml` |
| Keycloak server (CDK stock fallback) | **26.7.5** | `keycloak-stack.ts` in the `proxy-smart-infra` repo (`keycloakVersion` default; only used when no `imageUri`) |
| `@keycloak/keycloak-admin-client` (backend lib) | **26.7.5** (exact pin, no caret) | `backend/package.json` |

> The prod/beta image tag is `ghcr.io/proxy-smart/proxy-smart/keycloak:<env>-latest`, built
> from `Dockerfile.keycloak` in CI — the KC version lives in the Dockerfile, not the compose files.

## admin-client 26.7.0 to 26.7.2 regression (fixed in 26.7.3)

`client_credentials` returns no refresh token. 26.7.0 dropped a null guard in the
admin-client's `decodeToken` (a lint cleanup, keycloak#48218), so
`admin.auth({ grantType: 'client_credentials' })` threw
`undefined is not an object (evaluating 'token.split')` while decoding the missing refresh
token ([keycloak#50845](https://github.com/keycloak/keycloak/issues/50845)). Every admin call
the backend makes authenticates that way: CORS refresh, DCR, redirect-URI lookups and role
mappings all failed. The guard came back in 26.7.3
([keycloak#51985](https://github.com/keycloak/keycloak/pull/51985)).

`backend/test/kc-admin-client-client-credentials.test.ts` drives the real library against a
token endpoint that answers like Keycloak, so a regression fails there. The exact pin stays,
so a bump is always a decision.

## Audience mappers must name a real client (26.7.5)

Since 26.7.5 (CVE fix, keycloak#53074) an `oidc-audience-mapper` with
`included.client.audience` adds nothing unless that value is an existing, **enabled** client.
Literal audiences such as the MCP URL belong in `included.custom.audience`.

- `backend/src/lib/audience-mapper.ts` picks the key for every mapper the backend writes.
- `reconcileLiteralAudiences` runs at startup and moves existing literal values, because
  `--import-realm` never touches a realm that already exists. Mappers naming a disabled
  client are left alone: dropping those is the point of the fix.
- `backend/test/audience-mapper.test.ts` fails for any realm export that names a
  non-existent client, including the environment realms validated through
  `REALM_EXPORT_PATHS`.

## Feature flags

`kc.sh build --features=<list>` **adds** to Keycloak's default-on set — it does not replace it.
So only features that are **not** enabled-by-default need to be listed. proxy-smart lists
exactly two:

```
--features=cimd,resource-indicators
```

| Feature | KC 26.7.5 status | In `--features`? | Why proxy-smart needs it |
| --- | --- | --- | --- |
| `cimd` | **Experimental** | yes | OAuth Client ID Metadata Document — MCP `2025-11-25` client registration (recommended over DCR). |
| `resource-indicators` | **Experimental** | yes | RFC 8707 Resource Indicators — binds access-token `aud` to the requested FHIR/MCP resource so SMART + MCP audience validation is **fail-closed**. Needs an audience mapper to keep `aud` non-null. |
| `token-exchange-standard:v2` | **Default (on)** | no (automatic) | RFC 8693 Standard Token Exchange — required for SMART Health Links (SHL). On by default since it graduated; no flag needed. |
| `client-auth-federated` | **Default (on)** | no (automatic) | Federated-JWT client auth — validates proxy-signed client assertions. Graduated to default-on; no flag needed. |
| `organization` | **Default (on)** | no | KC Organizations. Enabled per-realm **at runtime** via a realm attribute (see `backend/src/init.ts` → `ensureOrganizationsEnabled`), not via `--features`. |
| `token-exchange` (legacy preview) | Preview, **deprecated** | no (removed) | Superseded by `token-exchange-standard:v2` (default-on). Removed from every deployment, dev compose and CI included. |

### Do NOT assume these have graduated

- **`resource-indicators` is still EXPERIMENTAL** (in both 26.6.4 and 26.7.5) and did *not*
  graduate at 26.7. Its implementation is byte-identical between those tags. CIMD-aware
  resource indicators (keycloak#51413) land in 26.8, not 26.7. A prior `Dockerfile.keycloak` comment claimed "experimental until 26.7";
  that was wrong and has been corrected. Treat both `cimd` and `resource-indicators` as
  experimental-in-production.
- Experimental features can be removed or changed between minor releases — re-verify against
  `Profile.java` for the target tag on every Keycloak bump.

## Upgrade checklist (when bumping Keycloak)

1. **Run the admin-client contract test**, then a live `admin.auth({grantType:'client_credentials'})`
   against the target server (26.7.0 broke it, above).
2. Check the [upgrading guide](https://www.keycloak.org/docs/latest/upgrading/index.html) for
   renamed/removed feature flags (e.g. 26.7 renamed `dynamic-scopes` → `parameterized-scopes`
   and removed `token-exchange-external-internal:v2`).
3. Re-verify each flag's `Type` in `Profile.java` at the target tag; drop any that became
   `Type.DEFAULT`, keep those still `PREVIEW`/`EXPERIMENTAL`.
4. Bump in lockstep: `Dockerfile.keycloak`, both `docker-compose*.yml`,
   `@keycloak/keycloak-admin-client`, the CDK `keycloakVersion` default and the image in
   `docs/deployment.md`. The compliance workflow reads `Dockerfile.keycloak` itself.
5. Read the release's "notable changes" for token content: audience, role and mapper
   behaviour changed silently in 26.7.1 and 26.7.5.
6. Re-diff the overridden theme templates against the new tag and look at the login,
   consent and error pages. 26.7 changed the consent button layout.
7. Keycloak's database migrations are one-way. Snapshot the production database before the
   first start on a new minor; an image rollback alone does not undo them.
8. `--http-relative-path` in the build **must** match the runtime `KC_HTTP_RELATIVE_PATH`
   (`/auth`) — a mismatch makes KC re-build *without* features at startup, crashing realm import.
9. Run `bun run test` (the `--isolate` variant) in `backend/` — plain `bun test` has known
   cross-test pollution and will report false failures.
10. Deploy to **beta first**; `--import-realm` is a no-op on an existing realm, so realm/client
   config changes in the export do **not** apply to already-provisioned environments.

## Realm export constraints

`--import-realm` writes straight into Keycloak's schema, so the export is bound by
that schema's column widths. Overflowing one aborts the import, and Keycloak then
**refuses to start at all** — the failure looks like a broken deployment, not a bad
JSON value:

```
ERROR: value too long for type character varying(255)
[update KEYCLOAK_ROLE set CLIENT=?,...,DESCRIPTION=?,NAME=?,...]
ERROR: Failed to start server in (development) mode
```

Practical limits, all `varchar(255)`: role `name` and `description`, client `name`
and `description`, client-scope `description`.

Two further rules, both learned the hard way:

- **No `"//"` pseudo-comment keys.** JSON has no comments, and Keycloak deserializes
  `users[]` into `UserRepresentation` with unknown fields rejected. See the seeded
  administrator note in [deployment.md](deployment.md).
- **Put the reasoning here, not in the data.** A description is a UI label with a hard
  length cap, not a place for rationale.

`backend/test/realm-export-importable.test.ts` enforces all of this across every
export.

### The default role must be declared twice

`default-roles-<realm>` is Keycloak's own role, not ours — every realm gets one, and
it is the set of roles every newly created user receives automatically. Ours grants
`offline_access` and `user` (stock would be `offline_access` + `uma_authorization`
plus the `account` client roles, so this is a deliberate trim).

It has to appear in **both** `realm.defaultRole` **and** `roles.realm[]`. `RealmManager`
does:

```java
realm.setDefaultRole(RepresentationToModel.createRole(realm, rep.getDefaultRole()));
```

and `createRole` does **not** wire composites — those are attached by the separate
pass over `roles.realm[]`. Declared only under `defaultRole`, the role is created
**empty**, and every user holding it silently gets nothing.

The symptom is remote from the cause: login succeeds, then the token exchange fails
with `Offline tokens not allowed for the user or client`, because Keycloak gates the
`offline_access` *scope* on the user holding the `offline_access` *realm role*.

### The `admin` composite

`admin` grants the per-product admin roles rather than meaning anything to a service
itself, so "administers everything" is expressed once instead of re-encoded per
service. Each product contributes its own role; this repo's export can only declare
the one it owns (`proxy-smart-admin`).

`proxy-smart-admin` is product-namespaced because the realm is shared: a bare `admin`
would mean administrator of *something*, and the realm also carries roles belonging to
other Max Health services (for example llm-gateway's `gateway-admin`).
