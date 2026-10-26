# Keycloak version & feature reference

Single source of truth for **which Keycloak version proxy-smart runs and which feature
flags it enables**, to avoid ambiguity (e.g. assuming a preview feature has graduated when
it hasn't). Feature statuses below are verified against the authoritative
[`Profile.java` at the Keycloak `26.8.1` tag](https://github.com/keycloak/keycloak/blob/26.8.1/common/src/main/java/org/keycloak/common/Profile.java).

## Versions

Server and admin-client are **both pinned to 26.8.1** and move together. The admin-client is
pinned exactly because 26.7.0 to 26.7.2 broke `client_credentials` auth (below).

| Component | Version | Where it's pinned |
| --- | --- | --- |
| Keycloak server (prod/beta, custom image) | **26.8.1** | [`Dockerfile.keycloak`](../Dockerfile.keycloak) (`FROM quay.io/keycloak/keycloak:26.8.1`) |
| Keycloak server (local dev) | **26.8.1** | `docker-compose.yml` (`docker-compose.development.yml` extends it) |
| Keycloak server (SMART compliance CI) | read from `Dockerfile.keycloak` | `.github/workflows/smart-compliance-tests.yml` |
| Keycloak server (CDK stock fallback) | **26.8.1** | `keycloak-stack.ts` in the `proxy-smart-infra` repo (`keycloakVersion` default; only used when no `imageUri`) |
| `@keycloak/keycloak-admin-client` (backend lib) | **26.8.1** (exact pin, no caret) | `backend/package.json` |

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

## Keycloak 26.8 (upgrade from 26.7.5)

What the 26.8.0 and 26.8.1 upgrade notes change for proxy-smart, verified against a 26.8.1
stack built from `Dockerfile.keycloak`.

| 26.8 change | Effect here |
| --- | --- |
| Identity provider `organizationId` replaced by organization links (many-to-many) | Keycloak ignores `organizationId` on IdP writes and no longer returns it. `/admin/idps` now links through the organization endpoints: `organizationIds` on create, update and read (`organizationId` stays as a deprecated alias for the first link). A provider with one organization gets an auto-join `MANAGED` link, as before; a provider shared by several gets auto-join `UNMANAGED` links, because Keycloak allows one managing organization per provider. |
| IdP update rejected (400) when the masked client secret is sent while `clientId`, `clientAuthMethod`, `tokenUrl`, `tokenIntrospectionUrl`, `baseUrl`, `tenantId` or `sandbox` change | `PUT /admin/idps/:alias` checks this first and answers 400 naming the changed keys. The startup reconcile of `proxy-smart-signing` always sends its real (unused) secret. `providerId` cannot change; the update schema never accepted it. |
| IdP mappers may not grant admin roles or admin groups unless the provider has `allowAdminRoleMapping` (only `manage-realm` can set it) | `config.allowAdminRoleMapping` is declared on the IdP schema, and Keycloak's 403 reason now reaches the caller instead of a generic refusal. The SMART attribute mappers grant no roles. |
| Disabled or removed clients never appear in `aud` or `resource_access` | Token exchange no longer names a disabled client as the audience for a `resource` (`lib/resource-audience.ts`). |
| Resource indicators on `client_credentials` no longer fail with 500 (keycloak#49077: 26.7.5 wrote the resource to a refresh token that grant never issues) | SMART Backend Services names no resource, so the token endpoint binds a `client_credentials` request without one to the `fhir-resource-server`'s `resource_url`; FHIR audience binding refused these tokens otherwise. A client without the `resource-indicators` scope cannot be bound and is retried once unbound, with a warning naming it. |
| With `resource-indicators` on, a CIMD client may only name resources in the executor's `cimd-resource-indicator-allow-list`; an empty list refuses all (keycloak#51413) | The backend writes every `resource_url` in the realm into the list when CIMD is configured and re-syncs it at startup (`syncCimdResourceAllowList`). Without it every MCP client registered by metadata document fails to sign in. |
| Client secrets masked for callers without `manage-clients` | Keycloak stores whatever secret it is sent, so a round-tripped mask would overwrite the real one. Writes that spread a fetched client drop a masked secret, and a smart-app update ignores the mask. |
| Introspection `act.sub` is the impersonator's user id | Not used: the proxy records its own client actor chain (`act.client_id`). |
| Token exchange delegation needs FGAP v2; scope renamed to `delegation:user:<admin>` | Not used. |
| Refresh token `exp` capped by session idle; offline refresh tokens always carry `exp` | The token context store already keys TTLs off `exp`. The CLI reads the old `refresh_expires_in: 0` as no deadline. |
| Login failures stored in the database by default | No realm here enables brute-force detection; enabling it later adds database load. |
| `client-secret-rotation` and `scim-api` on by default | No client policy uses secret rotation; SCIM stays off per realm. |
| Semicolons no longer split query parameters; registration access tokens rejected cross-protocol | Not affected: the proxy builds queries with `&`, and DCR is implemented by the proxy on the admin API. |
| OIDC IdP back-channel logout always validates signatures; `initiating_idp` ignored | `proxy-smart-signing` validates signatures through its JWKS. Brokered IdPs with *Validate Signatures* off that use back-channel logout need a JWKS URL or public key. |
| Redesigned IdP buttons on the login page | Our `social-providers.ftl` keeps its own markup; `theme.properties` pins the button classes it is styled against. Base `login.ftl`, `template.ftl`, `error.ftl` and `login-page-expired.ftl` are unchanged in 26.8.1. |
| *Full scope allowed* deprecated, logged as WARN per token | `admin-ui`, `admin-service` and DCR clients still have it on; moving them to explicit role scope mappings is a follow-up. |

### Operator actions on existing realms

- **Snapshot the database first.** 26.8 rewrites the organization tables (`ORG_IDENTITY_PROVIDER`, `ORG_DOMAIN`) and drops `IDENTITY_PROVIDER.ORGANIZATION_ID`.
- **Large `OFFLINE_USER_SESSION` tables** (over 300000 rows): Keycloak skips rebuilding `IDX_USER_SESSION_EXPIRATION_CREATED`, `IDX_USER_SESSION_EXPIRATION_LAST_REFRESH` and, on PostgreSQL, `IDX_OFFLINE_USS_BY_BROKER_SESSION_ID` during migration, then creates them concurrently after startup. Expect extra database load right after the first start.
- **IdPs whose mappers grant admin roles or admin groups** stop granting them at the next broker login until someone with `manage-realm` sets `allowAdminRoleMapping` on that provider.
- **Automation reading client secrets with `view-clients` only** now sees `**********`; grant `manage-clients`. The `admin-service` account in the realm export already has it.
- **Organization links** migrate as auto-join `MANAGED`. Check each organization's *Domains* tab: `kc.org.domain` and excluded domains became per-domain routing.
- **IdP back-channel logout** with *Validate Signatures* off fails until a JWKS URL or public key is configured.

## Feature flags

`kc.sh build --features=<list>` **adds** to Keycloak's default-on set — it does not replace it.
So only features that are **not** enabled-by-default need to be listed. proxy-smart lists
exactly two:

```
--features=cimd,resource-indicators
```

| Feature | KC 26.8.1 status | In `--features`? | Why proxy-smart needs it |
| --- | --- | --- | --- |
| `cimd` | **Experimental** | yes | OAuth Client ID Metadata Document — MCP `2025-11-25` client registration (recommended over DCR). |
| `resource-indicators` | **Experimental** | yes | RFC 8707 Resource Indicators — binds access-token `aud` to the requested FHIR/MCP resource so SMART + MCP audience validation is **fail-closed**. Needs an audience mapper to keep `aud` non-null. |
| `token-exchange-standard:v2` | **Default (on)** | no (automatic) | RFC 8693 Standard Token Exchange — required for SMART Health Links (SHL). On by default since it graduated; no flag needed. |
| `client-auth-federated` | **Default (on)** | no (automatic) | Federated-JWT client auth — validates proxy-signed client assertions. Graduated to default-on; no flag needed. |
| `organization` | **Default (on)** | no | KC Organizations. Enabled per-realm **at runtime** via a realm attribute (see `backend/src/init.ts` → `ensureOrganizationsEnabled`), not via `--features`. |
| `token-exchange` (legacy preview) | Preview, **deprecated** | no (removed) | Superseded by `token-exchange-standard:v2` (default-on). Removed from every deployment, dev compose and CI included. |

### Do NOT assume these have graduated

- **`resource-indicators` is still EXPERIMENTAL** (26.6.4, 26.7.5 and 26.8.1) and has *not*
  graduated. Its implementation is byte-identical in 26.6.4 and 26.7.5; 26.8 changed it
  (CIMD allow list, client_credentials null guard, custom-audience match), see above.
  Treat both `cimd` and `resource-indicators` as
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
