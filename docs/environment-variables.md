# Environment Variables

Complete reference for all environment variables used by Proxy Smart.

## Core

| Variable | Description | Default |
|---|---|---|
| `BASE_URL` | Public base URL of the Proxy Smart instance | `http://localhost:8445` |
| `SITE_URL` | Public website origin used for canonical links on the landing and App Store pages, when the site and the API live on different hosts (e.g. `proxy-smart.com` and `api.proxy-smart.com`) | `BASE_URL` |
| `PORT` | HTTP port for the backend server | `8445` |
| `NODE_ENV` | Node environment (`production`, `development`) | -- |
| `CORS_ORIGINS` | Comma-separated allowed CORS origins | development defaults |

## Keycloak

| Variable | Description | Default |
|---|---|---|
| `KEYCLOAK_BASE_URL` | Internal Keycloak URL (container-to-container) | -- |
| `KEYCLOAK_PUBLIC_URL` | Browser-facing Keycloak URL | derived from `KEYCLOAK_BASE_URL` |
| `KEYCLOAK_REALM` | Keycloak realm name | -- |
| `KEYCLOAK_DOMAIN` | Domain override for public URL hostname | -- |
| `KEYCLOAK_ADMIN_CLIENT_ID` | Service account client ID | -- |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Service account client secret | -- |

## Database and multi-node state

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string for state every node must share | -- |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | The same connection as discrete parts, used when `DATABASE_URL` is unset | `PGPORT=5432` |
| `PGSSLROOTCERT` | CA bundle for verified TLS to Postgres | -- (no TLS) |
| `PGSSLMODE` | `no-verify` encrypts without verifying the server certificate | -- |

With a database configured, the backend creates and uses these tables in addition to the admin
configuration:

- `smart_token_context`: the launch context of each issued token by `jti`, so token introspection
  and the FHIR proxy return the same `patient`, `encounter`, `fhirContext` and actor chain on every
  node, not only on the node that issued the token
- `client_assertion_jti`: spent `private_key_jwt` assertion ids (a SHA-256 digest of client id and
  `jti`), so an assertion replayed to another node is refused

Rows carry an expiry and are purged every minute. Each node also keeps what it wrote or read in
memory, and keeps serving from memory if the database becomes unreachable. Without a database both
stores are per-process, and a deployment with more than one backend node then needs sticky routing
for introspection and loses cross-node replay protection.

## Client addresses and rate limiting

| Variable | Description | Default |
|---|---|---|
| `TRUSTED_PROXY_HOPS` | Number of reverse proxies in front of the backend that append to `X-Forwarded-For`. The client address is the entry this many places from the right; entries further left were written by the client and are ignored. `0` ignores the header and uses the socket peer | `0` |
| `AUTH_RATE_LIMIT_PER_MINUTE` | Requests per minute per client address on each OAuth credential endpoint: `/auth/token`, `/auth/device`, `/auth/introspect`, `/auth/revoke`, `/auth/register` and `/auth/register/{clientId}`. Each endpoint counts separately; excess requests get `429` with `Retry-After`. `0` turns the limiter off | `0` (off) |

Set `TRUSTED_PROXY_HOPS` to the exact depth of your proxy chain. Too low and every client shares
the address of your outermost proxy; too high and a client can pick its own address by sending an
`X-Forwarded-For` header. The same address is recorded in the audit and OAuth event logs.

The limiter counts per backend node. Resource servers that introspect every request from one
address, and test harnesses that request many tokens, need a limit with headroom for that volume.

## FHIR

| Variable | Description | Default |
|---|---|---|
| `FHIR_SERVER_BASE` | Comma-separated upstream FHIR server URLs | `http://localhost:8081/fhir` |
| `FHIR_SUPPORTED_VERSIONS` | Comma-separated FHIR versions | `R4` |

## SMART Configuration

| Variable | Description | Default |
|---|---|---|
| `SMART_CONFIG_CACHE_TTL` | SMART well-known configuration cache TTL (ms) | `300000` |
| `SMART_SCOPES_SUPPORTED` | Comma-separated override for supported SMART scopes | auto-detected |
| `SMART_CAPABILITIES` | Comma-separated override for SMART capabilities | auto-detected |
| `SMART_INTROSPECTION_SCOPE` | Scope a SMART bearer token needs to call `/auth/introspect`; created as a Keycloak client scope at startup | `token-introspection` |
| `APP_STATE_MAX_RESOURCE_BYTES` | Largest App State resource accepted; never below 256KB (see [App State](app-state)) | `262144` |
| `APP_STATE_MAX_PER_SUBJECT` | App State resources kept per state code and subject | `20` |
| `BACKEND_SERVICE_TOKEN_LIFESPAN` | Access token lifetime (seconds) set on new clients with a service account, unless the request names one. SMART Backend Services says it SHOULD NOT exceed 300 | `300` |
| `CLIENT_ASSERTION_ALGORITHMS` | Comma-separated JWS algorithms accepted on `private_key_jwt` client assertions, and advertised as `token_endpoint_auth_signing_alg_values_supported` | `RS384,ES384` |
| `JWKS_CACHE_TTL_MS` | How long a client JWKS fetched from its URL is reused when the response has no `Cache-Control`. A `Cache-Control` header always wins | `60000` |
| `JWKS_CACHE_MAX_TTL_MS` | Upper bound on any client JWKS cache lifetime, whatever `max-age` says | `3600000` |
| `JWKS_FETCH_TIMEOUT_MS` | Timeout for fetching a client JWKS | `5000` |
| `JWKS_REFETCH_MIN_INTERVAL_MS` | Minimum gap between forced reloads of one client's keys after an assertion names an unknown `kid` | `30000` |

## Consent Enforcement

| Variable | Description | Default |
|---|---|---|
| `CONSENT_ENABLED` | Enable consent checking | on unless the posture's `consent` is `disabled` |
| `CONSENT_MODE` | `disabled`, `audit-only`, or `enforce`; only applies when `CONSENT_ENABLED=true` | [access posture](fhir-proxy.md#access-posture) |
| `CONSENT_CACHE_TTL` | Consent decision cache TTL (ms) | `60000` |
| `CONSENT_EXEMPT_CLIENTS` | Comma-separated client IDs exempt from consent | -- |
| `CONSENT_REQUIRED_RESOURCE_TYPES` | Resource types that always require consent | -- |
| `CONSENT_EXEMPT_RESOURCE_TYPES` | Resource types exempt from consent | `CapabilityStatement,metadata` |

## Identity Assurance Level (IAL)

| Variable | Description | Default |
|---|---|---|
| `IAL_ENABLED` | Enable IAL verification | `false` |
| `IAL_MINIMUM_LEVEL` | Minimum IAL for general access (`level1`–`level4`) | `level1` |
| `IAL_SENSITIVE_RESOURCE_TYPES` | Comma-separated resource types requiring elevated IAL | -- |
| `IAL_SENSITIVE_MINIMUM_LEVEL` | Minimum IAL for sensitive resources | `level3` |
| `IAL_VERIFY_PATIENT_LINK` | Verify token patient matches Person.link[] | `true` |
| `IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE` | Allow access if Person lookup fails | `false` |
| `IAL_CACHE_TTL` | Person resource cache TTL (ms) | `300000` |

## Access Control

| Variable | Description | Default |
|---|---|---|
| `SCOPE_ENFORCEMENT_MODE` | SMART scope enforcement: `disabled`, `audit-only`, `enforce` | [access posture](fhir-proxy.md#access-posture) |
| `ROLE_BASED_FILTERING_MODE` | Role-based data isolation: `disabled`, `audit-only`, `enforce` | [access posture](fhir-proxy.md#access-posture) |
| `FHIR_AUDIENCE_ENFORCEMENT` | Whether a FHIR request's token `aud` must name the FHIR server it reaches: `disabled`, `audit-only`, `enforce` | [access posture](fhir-proxy.md#access-posture) |
| `FHIR_BUNDLE_MAX_ENTRIES` | Most entries accepted in a batch or transaction Bundle posted to a FHIR server base | `100` |

## Branding (SMART 2.2.0 User-Access Brands)

| Variable | Description | Default |
|---|---|---|
| `BRAND_NAME` | Organization display name | package display name |
| `BRAND_WEBSITE` | Organization website URL | `BASE_URL` |
| `BRAND_LOGO_URL` | Logo image URL | -- |
| `BRAND_LOGO_LICENSE_URL` | Logo license URL | -- |
| `BRAND_ALIASES` | Comma-separated alternative names | -- |
| `BRAND_CATEGORY` | Organization category (`prov`, `pay`, `laboratory`, etc.) | `prov` |
| `BRAND_PORTAL_NAME` | Patient portal display name | -- |
| `BRAND_PORTAL_URL` | Patient portal URL | -- |
| `BRAND_PORTAL_DESCRIPTION` | Patient portal description | -- |
| `BRAND_PORTAL_LOGO_URL` | Patient portal logo URL | -- |
| `BRAND_PORTAL_LOGO_LICENSE_URL` | Portal logo license URL | -- |
| `BRAND_ADDRESS_LINE` | Street address; separate lines with a newline | -- |
| `BRAND_ADDRESS_CITY` | Address city | -- |
| `BRAND_ADDRESS_STATE` | Address state | -- |
| `BRAND_ADDRESS_POSTAL_CODE` | Address postal code | -- |
| `BRAND_ADDRESS_COUNTRY` | Address country | -- |
| `BRAND_IDENTIFIER` | Brand identifier value, advertised as `user_access_brand_identifier` | `BRAND_WEBSITE` or `BASE_URL` |
| `BRAND_IDENTIFIER_SYSTEM` | Brand identifier system | `urn:ietf:rfc:3986` |
| `BRAND_DEVELOPER_URL` | https URL where app developers configure access, published as each Endpoint's `contact` | `BASE_URL/docs/admin-ui/smart-apps` |
| `BRAND_ADDITIONAL_PORTALS` | JSON array of further portals: `[{"name":"...","url":"https://...","description":"...","logoUrl":"...","logoLicenseUrl":"...","serverIds":["..."]}]`. Each becomes its own `organization-portal` extension | -- |

## MCP

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | API key for embeddings and semantic search | -- |
| `MCP_ENDPOINT_PATH` | MCP endpoint URL path | `/mcp` |
| `MCP_PREFAB_UI` | Render MCP tool results as prefab UIs for MCP Apps hosts. Tools stop advertising `outputSchema` when on | `false` |

## App Store

| Variable | Description | Default |
|---|---|---|
| `APP_STORE_SHOW_ADMIN` | Show the Admin link in the app store header. The store is a public page and the console only works for a staff admin, so it is hidden unless a deployment asks for it | `false` |

Replaces `APP_STORE_HIDE_ADMIN`, which defaulted to SHOWING the link: a deployment that set
nothing published a link to the staff console on a public page. Set `APP_STORE_SHOW_ADMIN=true`
to get the old behaviour back on an internal deployment.

## DICOMweb Proxy

| Variable | Description | Default |
|---|---|---|
| `DICOMWEB_BASE_URL` | Upstream PACS DICOMweb URL | -- (disabled if unset) |
| `DICOMWEB_WADO_ROOT` | WADO-RS root URL | `DICOMWEB_BASE_URL` |
| `DICOMWEB_QIDO_ROOT` | QIDO-RS root URL | `DICOMWEB_BASE_URL` |
| `DICOMWEB_UPSTREAM_AUTH` | Auth header for upstream PACS | -- |
| `DICOMWEB_TIMEOUT_MS` | Request timeout for PACS calls (ms) | `30000` |
