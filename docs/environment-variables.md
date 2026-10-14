# Environment Variables

Every environment variable the Proxy Smart backend reads. The tables are generated from [`proxy-smart.guido.json`](../proxy-smart.guido.json), which also carries each variable's valid range and the rules between them; edit the template and run `bun run config:generate`. `bun run check:config` validates `.env.example` and every compose file against it.

## Core

<!-- guido:fields #core -->
| Variable | Description | Default |
|---|---|---|
| `BASE_URL` | Public base URL of this Proxy Smart instance, used for the issuer, discovery documents, FHIR proxy and MCP URLs and token audiences. Set it to the externally reachable origin in every non-local deployment; trailing slashes are removed. | `http://localhost:8445` |
| `CORS_ORIGINS` | Comma-separated browser origins allowed to call the backend, matched exactly. In production only these origins plus the webOrigins of SMART apps registered in Keycloak are allowed. When unset: Outside production: localhost:5173-5176, 3000, 4567, 8445 and BASE_URL. With NODE_ENV=production: none. Registered SMART app webOrigins from Keycloak are always merged in. | -- |
| `LOG_LEVEL` | Base log verbosity, case-insensitive. An unrecognised value falls back to the NODE_ENV default; the server, keycloak, fhir and auth categories always log at least info. When unset: info when NODE_ENV=production, otherwise debug. | -- |
| `NODE_ENV` | Runtime mode. production binds 0.0.0.0, logs JSON at info level, drops the localhost CORS defaults and enables the startup guards against dev bypass flags and the fixture admin secret; development allows internal-network URLs for client JWKS, dynamic registration and FHIR server registration. When unset: Unset when run from source (treated as non-production); the published Docker image sets production. | -- |
| `PORT` | TCP port the backend HTTP server listens on. It is also used to derive the proxy signing JWKS URL when PROXY_SIGNING_JWKS_URL is unset. | `8445` |
| `SITE_URL` | Public website origin used for canonical links on the landing and App Store pages, the post-login fallback redirect and client home URL resolution. Set it when the site and the API live on different hosts. When unset: Falls back to BASE_URL; trailing slashes are stripped. | -- |
<!-- /guido:fields -->

## Keycloak

<!-- guido:fields #keycloak -->
| Variable | Description | Default |
|---|---|---|
| `KEYCLOAK_ADMIN_CLIENT_ID` | Client id of the confidential Keycloak service account the backend uses for the Keycloak admin REST API, token introspection and dynamic client registration. Set it to the service-account client in your realm, usually admin-service. When unset: Unset is treated as unconfigured by the admin API factory, token introspection, CORS origin discovery, the event loggers and backend-services token calls. Only the service-account helper used by dynamic client registration and the DCR reaper, and the consent notification route, fall back to 'admin-service'. | -- |
| `KEYCLOAK_ADMIN_CLIENT_ROLES` | Comma-separated roles on the admin UI client that grant full admin access to this deployment. Set it to narrow or rename the admin roles; an empty value falls back to the defaults. | `proxy-smart-admin,admin,manage-users,manage-clients,manage-realm` |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Client secret of the Keycloak service account named by KEYCLOAK_ADMIN_CLIENT_ID. In production the backend refuses to start when this equals the dev fixture secret from keycloak/realm-export.json. | -- |
| `KEYCLOAK_ADMIN_REALM_ROLES` | Comma-separated realm roles that grant full admin access to this deployment. Narrow it to proxy-smart-admin on a realm shared with other products; an empty value falls back to the defaults. | `proxy-smart-admin,admin,realm-admin,manage-users,manage-realm,realm-management` |
| `KEYCLOAK_ADMIN_UI_CLIENT_ID` | Client id of the public Keycloak client the admin web app signs in with. Admin user tokens must carry this client in aud or azp, and its client roles grant admin access, so change it only if your realm names that client differently. | `admin-ui` |
| `KEYCLOAK_AUDITOR_ROLES` | Comma-separated realm or admin UI client roles that grant read-only access to the admin API, for monitoring or CI principals such as drift checks. An empty value falls back to the default. | `proxy-smart-auditor` |
| `KEYCLOAK_BASE_URL` | URL the backend uses to reach Keycloak, typically the internal container address including any /auth prefix. Keycloak counts as configured only when this and KEYCLOAK_REALM are both set. | -- |
| `KEYCLOAK_DOMAIN` | Hostname that replaces the host of KEYCLOAK_BASE_URL to build the browser-facing Keycloak URL, keeping protocol, port and path. Prefer KEYCLOAK_PUBLIC_URL when the public URL also differs in scheme or port. | -- |
| `KEYCLOAK_PUBLIC_URL` | Browser-facing Keycloak URL used for authorize and login redirects, discovery documents and the expected token issuer (<url>/realms/<realm>). Set it whenever browsers reach Keycloak at a different address than the backend does. When unset: Derived from KEYCLOAK_BASE_URL, with its hostname replaced by KEYCLOAK_DOMAIN when that is set. | -- |
| `KEYCLOAK_REALM` | Name of the Keycloak realm that holds the SMART clients, users and scopes. Required together with KEYCLOAK_BASE_URL for authentication and the admin API to work. When unset: No default in config.ts; the system status page alone displays 'smart-on-fhir' when unset. | -- |
<!-- /guido:fields -->

## Database and multi-node state

<!-- guido:fields #database-and-multi-node-state -->
| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string for admin configuration and state every backend node must share (token launch context, spent client assertions, App State). Unset falls back to the PG* variables, and without either the backend keeps state in files under DATA_DIR and in process memory, which only suits a single node. | -- |
| `DATA_DIR` | Directory for file-backed persistence such as configuration files, the SHL session database and the documentation search cache. Missing config files are seeded into it from the image on startup; mount a volume here so data survives redeploys. When unset: <working directory>/data, which is /app/backend/data in the Docker image. | -- |
| `PGDATABASE` | Name of the application database when the connection is given as discrete PG* parts. The backend creates this database at startup if it does not exist yet. Set by the platform or build, not by an operator. | -- |
| `PGHOST` | PostgreSQL host when the connection is given as discrete PG* parts instead of DATABASE_URL, for example when a platform injects the password as a separate secret. Set by the platform or build, not by an operator. | -- |
| `PGMAINTENANCEDB` | Existing database the backend connects to at startup to create PGDATABASE when it is missing. Change it only if the server has no postgres database or the user cannot connect to it. Set by the platform or build, not by an operator. | `postgres` |
| `PGPASSWORD` | PostgreSQL password when the connection is given as discrete PG* parts. Keeps the password out of a single connection-string variable. Set by the platform or build, not by an operator. | -- |
| `PGPORT` | PostgreSQL port when the connection is given as discrete PG* parts. Set by the platform or build, not by an operator. | `5432` |
| `PGSSLMODE` | Set to no-verify to encrypt the Postgres connection without verifying the server certificate, for a server with a self-signed certificate. Any other value is ignored; prefer PGSSLROOTCERT for verified TLS. | -- |
| `PGSSLROOTCERT` | Path to a CA bundle; when set, the Postgres connection uses TLS and verifies the server certificate against it. Required for managed Postgres that forces TLS (the Docker image ships the Amazon RDS bundle at /etc/ssl/certs/rds-global-bundle.pem); an unreadable path fails startup. | -- |
| `PGUSER` | PostgreSQL user when the connection is given as discrete PG* parts. Needs permission to create PGDATABASE if it does not exist yet. Set by the platform or build, not by an operator. | -- |
<!-- /guido:fields -->

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

<!-- guido:fields #client-addresses-and-rate-limiting -->
| Variable | Description | Default |
|---|---|---|
| `AUTH_RATE_LIMIT_PER_MINUTE` | Requests per minute per client address on each OAuth credential endpoint (token, device, introspect, revoke, register); excess requests get 429 with Retry-After. 0 turns the limiter off, and the count is kept per backend node. | `0` |
| `TRUSTED_PROXY_HOPS` | Number of reverse proxies in front of the backend that append to X-Forwarded-For; the client address is taken that many entries from the right. 0 ignores the header and uses the socket peer, so set it to the exact depth of your proxy chain. | `0` |
<!-- /guido:fields -->

Set `TRUSTED_PROXY_HOPS` to the exact depth of your proxy chain. Too low and every client shares
the address of your outermost proxy; too high and a client can pick its own address by sending an
`X-Forwarded-For` header. The same address is recorded in the audit and OAuth event logs.

The limiter counts per backend node. Resource servers that introspect every request from one
address, and test harnesses that request many tokens, need a limit with headroom for that volume.

## FHIR

<!-- guido:fields #fhir -->
| Variable | Description | Default |
|---|---|---|
| `FHIR_BUNDLE_MAX_ENTRIES` | Maximum number of entries accepted in a batch or transaction Bundle; each entry is authorized separately. Zero or invalid values fall back to 100. | `100` |
| `FHIR_SERVER_BASE` | Comma-separated base URLs of the upstream FHIR servers the proxy fronts. Upstream bases are also accepted as token audiences. | `http://localhost:8081/fhir` |
| `FHIR_SUPPORTED_VERSIONS` | Comma-separated FHIR versions the proxy accepts; the first entry is the fallback when a server does not report its version. Add R5 only when upstream servers serve it. | `R4` |
<!-- /guido:fields -->

## SMART Configuration

<!-- guido:fields #smart-configuration -->
| Variable | Description | Default |
|---|---|---|
| `APP_STATE_MAX_PER_SUBJECT` | Maximum number of SMART App State resources kept per state code and subject. Zero, negative or non-numeric values fall back to 20. | `20` |
| `APP_STATE_MAX_RESOURCE_BYTES` | Largest SMART App State resource accepted, in bytes. The SMART spec requires accepting at least 256KB, so smaller or invalid values are raised to 262144. | `262144` |
| `BACKEND_SERVICE_TOKEN_LIFESPAN` | Access token lifetime in seconds applied to clients that get a service account (SMART Backend Services) when the create or update request names none. SMART Backend Services says it SHOULD NOT exceed 300; zero or invalid values fall back to 300. | `300` |
| `CLIENT_ASSERTION_ALGORITHMS` | Comma-separated JWS algorithms accepted on private_key_jwt client assertions and advertised as token_endpoint_auth_signing_alg_values_supported. Only asymmetric algorithms (RS256/384/512, PS256/384/512, ES256/384/512) can ever be accepted. | `RS384,ES384` |
| `JWKS_CACHE_MAX_TTL_MS` | Upper bound in milliseconds on how long a client JWKS fetched from its URL is cached, regardless of the Cache-Control max-age it sends. Zero or invalid values fall back to 3600000. | `3600000` |
| `JWKS_CACHE_TTL_MS` | How long in milliseconds a client JWKS is cached when its response carries no Cache-Control header. A Cache-Control header always wins, capped by JWKS_CACHE_MAX_TTL_MS. | `60000` |
| `JWKS_FETCH_TIMEOUT_MS` | Timeout in milliseconds for fetching a client's JWKS from its jwks_uri during private_key_jwt authentication. Zero or a non-numeric value falls back to the default. | `5000` |
| `JWKS_REFETCH_MIN_INTERVAL_MS` | Minimum gap in milliseconds between forced reloads of one client's JWKS after an assertion names an unknown kid. Limits how often a client can make the proxy refetch its keys. | `30000` |
| `PATIENT_ONBOARDING_URL` | Page where a user links their account to a patient record. Shown as the way forward when a launch is refused because the account has no fhirUser; leave unset to show the explanation without a link. When unset: Empty string; the account-setup link is omitted. | -- |
| `SMART_CAPABILITIES` | Comma-separated list that replaces the capabilities advertised in .well-known/smart-configuration. Leave unset to advertise the built-in list. | `launch-ehr,launch-standalone,authorize-post,client-public,client-confidential-symmetric,client-confidential-asymmetric,sso-openid-connect,context-standalone-patient,context-standalone-encounter,context-ehr-patient,context-ehr-encounter,context-banner,context-style,permission-offline,permission-online,permission-patient,permission-user,permission-v2,permission-v1,smart-app-state` |
| `SMART_CONFIG_CACHE_TTL` | How long in milliseconds the generated SMART configuration, built from Keycloak's discovery document, is cached before it is rebuilt. | `300000` |
| `SMART_INTROSPECTION_SCOPE` | Scope a SMART bearer token must carry to call /auth/introspect. The backend creates it as a Keycloak client scope at startup. | `token-introspection` |
| `SMART_LAUNCH_CODE_TTL` | Lifetime in seconds of the signed EHR launch codes the proxy mints. Keep it short, since a launch code only needs to survive the redirect to the app. | `300` |
| `SMART_LAUNCH_SECRET` | Secret that signs EHR launch codes, which any backend node may redeem. Leave it unset when PROXY_SIGNING_KEY_FILE or PROXY_SIGNING_KEY_PEM is set: it is then derived from that key, so every node agrees. Without either, each process generates its own and only a single node works. | -- |
| `SMART_SCOPES_SUPPORTED` | Comma-separated list that replaces the built-in preferred SMART scopes. These scopes are created in Keycloak at startup and advertised first, followed by the other requestable scopes Keycloak reports. | `openid,profile,fhirUser,launch,launch/patient,launch/encounter,online_access,offline_access,patient/*.cruds,patient/*.rs,user/*.cruds,user/*.rs,system/*.cruds,system/*.rs,patient/*.read,patient/*.write,patient/*.*,user/*.read,user/*.write,user/*.*,system/*.read,system/*.write,system/*.*` |
<!-- /guido:fields -->

## Access Control

<!-- guido:fields #access-control -->
| Variable | Description | Default |
|---|---|---|
| `ALLOWED_EXTERNAL_AUDIENCES` | Comma-separated list of external resource servers that may be named as aud or resource in authorize requests, for services that use this proxy as their authorization server. An entry starting with a dot (e.g. .example.com) matches that domain and all its subdomains at authorize time; other entries match as URL prefixes. When unset: Unset means an empty list: only this proxy's own FHIR, MCP and resource endpoints are accepted as aud/resource. | -- |
| `FHIR_AUDIENCE_ENFORCEMENT` | Whether a FHIR request's access token must carry this FHIR server (or its resource client) in aud. Use audit-only to log mismatches before switching to enforce; unknown values fall back to the posture default. The default is the access posture in backend/src/lib/access-posture.json. | `audit-only` |
| `JWT_AUDIENCE_ENFORCEMENT` | Whether access tokens on the admin API, MCP endpoint and other proxy call sites must carry an accepted aud or azp. Set to disabled only temporarily while debugging or migrating clients; any other value keeps enforcement on. | `enforce` |
| `JWT_EXPECTED_AUDIENCE` | Legacy override that replaces the built-in set of accepted token audiences with this single value at every call site that does not name its own audience. A URL value is matched as a prefix, anything else must equal aud or azp exactly; leave it unset unless you know you need it, because it can lock out admin UI logins. When unset: Unset uses the built-in audience set: the admin-ui and admin-service client ids, the MCP endpoint URL, the proxy FHIR base, the upstream FHIR server bases and configured external audiences. | -- |
| `ROLE_BASED_FILTERING_MODE` | Role-based data isolation driven by the token's fhirUser claim, for example limiting a practitioner to their own patients. audit-only logs what would be filtered without filtering. The default is the access posture in backend/src/lib/access-posture.json. | `enforce` |
| `SCOPE_ENFORCEMENT_MODE` | Whether the FHIR proxy checks the token's SMART scopes against the requested resource type and interaction. audit-only logs violations without blocking. The default is the access posture in backend/src/lib/access-posture.json. | `enforce` |
| `TENANT_ISOLATION_MODE` | Whether a user's Keycloak organization must be one a FHIR server is assigned to before requests reach that server. enforce answers 403 when it is not, audit-only logs and allows; servers with no organizations assigned stay open to everyone. The default is the access posture in backend/src/lib/access-posture.json. | `disabled` |
| `TENANT_QUERY_ISOLATION` | When true, FHIR search requests from a user with an organization get a _tag filter on the https://proxy-smart.com/tenant system, so tenants sharing one FHIR server only see their own resources. Resources must already be tagged with that organization on write. | `false` |
<!-- /guido:fields -->

## Consent Enforcement

<!-- guido:fields #consent-enforcement -->
| Variable | Description | Default |
|---|---|---|
| `CONSENT_APP_URL` | URL of the consent management app, returned as consentRequestUrl in the 403 response when a request is denied for missing consent. Set it so apps can send the patient somewhere to grant consent. | -- |
| `CONSENT_CACHE_TTL` | How long a consent decision is cached, in milliseconds. Lower it when consent changes must take effect faster. | `60000` |
| `CONSENT_ENABLED` | Turns consent checking on FHIR requests on or off. Any value other than the exact string true turns it off. The default is the access posture in backend/src/lib/access-posture.json. | `true` |
| `CONSENT_EXEMPT_CLIENTS` | Comma-separated OAuth client IDs whose requests skip consent checks. Use it for trusted internal clients such as clinical systems that operate under treatment exceptions. | -- |
| `CONSENT_EXEMPT_RESOURCE_TYPES` | Comma-separated FHIR resource types that never require consent, in addition to CapabilityStatement and metadata. Resource types outside the patient compartment are skipped automatically. When unset: CapabilityStatement and metadata are always exempt; listed types are added to them. | -- |
| `CONSENT_MODE` | How consent decisions are applied: enforce denies requests without consent, audit-only logs what would be denied, disabled skips checks. Unknown values fall back to the posture default. The default is the access posture in backend/src/lib/access-posture.json. | `enforce` |
| `CONSENT_REQUIRED_RESOURCE_TYPES` | Comma-separated FHIR resource types to restrict consent checks to. When set, only these types are checked and every other type skips consent; leave it empty to check all patient-compartment types. | -- |
<!-- /guido:fields -->

## Identity Assurance Level (IAL)

<!-- guido:fields #identity-assurance-level-ial -->
| Variable | Description | Default |
|---|---|---|
| `IAL_ALLOW_ON_PERSON_LOOKUP_FAILURE` | Allows access when the Person resource for the user cannot be fetched. Leave it false to fail closed; only the exact string true enables it. | `false` |
| `IAL_CACHE_TTL` | How long fetched Person resources are cached, in milliseconds. Lower it when identity assurance changes must apply faster. | `300000` |
| `IAL_ENABLED` | Turns on identity assurance checks that verify the user's Person resource and its link to the patient before granting access. Only the exact string true enables it. | `false` |
| `IAL_MINIMUM_LEVEL` | Minimum identity assurance level required for general patient data access. Unknown values fall back to level1. | `level1` |
| `IAL_SENSITIVE_MINIMUM_LEVEL` | Minimum identity assurance level required for the resource types listed in IAL_SENSITIVE_RESOURCE_TYPES. Unknown values fall back to level3. | `level3` |
| `IAL_SENSITIVE_RESOURCE_TYPES` | Comma-separated FHIR resource types that require the elevated IAL_SENSITIVE_MINIMUM_LEVEL. Use it for sensitive data such as prescriptions or diagnostic reports. | -- |
| `IAL_VERIFY_PATIENT_LINK` | Checks that the token's patient appears in the user's Person.link entries. Only the exact string false turns the check off. | `true` |
<!-- /guido:fields -->

## DICOMweb Proxy

<!-- guido:fields #dicomweb-proxy -->
| Variable | Description | Default |
|---|---|---|
| `DICOMWEB_BASE_URL` | Base URL of an upstream PACS DICOMweb endpoint, used to create a default DICOM server when none is configured in the admin UI. Leave unset to manage DICOM servers only through the admin UI. | -- |
| `DICOMWEB_PASSWORD` | Password for Basic authentication against the upstream PACS. Set it together with DICOMWEB_USERNAME. | -- |
| `DICOMWEB_QIDO_ROOT` | QIDO-RS (search) root of the upstream PACS. Set it only when search is served from a different path than DICOMWEB_BASE_URL. When unset: Falls back to DICOMWEB_BASE_URL. | -- |
| `DICOMWEB_TIMEOUT_MS` | Timeout in milliseconds for requests to the upstream PACS. Raise it for slow archives or large studies. | `30000` |
| `DICOMWEB_UPSTREAM_AUTH` | Full Authorization header value sent to the upstream PACS, for example a Basic or Bearer credential. It takes precedence over DICOMWEB_USERNAME and DICOMWEB_PASSWORD. | -- |
| `DICOMWEB_USERNAME` | Username for Basic authentication against the upstream PACS. Set it together with DICOMWEB_PASSWORD. | -- |
| `DICOMWEB_WADO_ROOT` | WADO-RS (retrieve) root of the upstream PACS. Set it only when retrieval is served from a different path than DICOMWEB_BASE_URL. When unset: Falls back to DICOMWEB_BASE_URL. | -- |
<!-- /guido:fields -->

## MCP

<!-- guido:fields #mcp -->
| Variable | Description | Default |
|---|---|---|
| `MCP_ENDPOINT_PATH` | Path under BASE_URL where the Streamable HTTP MCP endpoint is mounted; it is also the MCP resource indicator and an accepted token audience. Must start with a slash. | `/mcp` |
| `MCP_PREFAB_UI` | Render MCP tool results as prefab UIs for MCP Apps hosts such as VS Code or Claude Desktop. When on, tools stop advertising an outputSchema; only the exact value true enables it. | `false` |
| `OPENAI_API_KEY` | OpenAI API key used to embed the documentation for the semantic documentation search tool. Without it documentation search is disabled and the rest of the backend runs normally. | -- |
| `OPENAI_EMBEDDING_MODEL` | OpenAI embedding model used to index the documentation for semantic search (the docs API and the search_documentation MCP tool). Changing it rebuilds the embedding cache. | `text-embedding-3-small` |
| `RAG_CHUNK_SIZE` | Target size in characters of each documentation chunk embedded for semantic search. Larger chunks give more context per hit and fewer embeddings. | `1200` |
| `RAG_DOCS_DIR` | Directory of markdown documentation that semantic documentation search indexes. Set it only when the docs live somewhere the automatic lookup does not find. When unset: The first existing docs directory next to the backend: the repository docs/ in development, /app/docs in the Docker image. | -- |
| `RAG_EMBEDDING_BATCH_SIZE` | How many documentation chunks are sent to the OpenAI embeddings API per request when building the search index. Lower it if requests hit rate or size limits. | `64` |
| `RAG_MIN_CHUNK_SIZE` | Smallest documentation chunk in characters kept on its own for semantic search; shorter fragments are merged with neighbours. | `200` |
<!-- /guido:fields -->

## App Store

<!-- guido:fields #app-store -->
| Variable | Description | Default |
|---|---|---|
| `APP_STORE_SHOW_ADMIN` | Shows an Admin link in the header of the public app store and instance pages. Only the exact value true enables it; leave it off on public deployments because the console is for staff admins only. | `false` |
<!-- /guido:fields -->

Replaces `APP_STORE_HIDE_ADMIN`, which defaulted to SHOWING the link: a deployment that set
nothing published a link to the staff console on a public page. Set `APP_STORE_SHOW_ADMIN=true`
to get the old behaviour back on an internal deployment.

## Branding (SMART 2.2.0 User-Access Brands)

<!-- guido:fields #branding-smart-220-user-access-brands -->
| Variable | Description | Default |
|---|---|---|
| `BRAND_ACCENT_COLOR` | Accent colour used to theme the login and other auth pages, as a CSS hex, rgb()/hsl() or keyword colour. Values that are not a safe CSS colour are ignored; it is never published in branding.json. When unset: Unset falls back to BRAND_PRIMARY_COLOR wherever an accent is rendered. | -- |
| `BRAND_ADDITIONAL_PORTALS` | JSON array of further patient portals, each published as its own organization-portal extension in the brand bundle. Each item needs name and an http(s) url and may carry description, logoUrl, logoLicenseUrl and serverIds; an invalid array is ignored with a warning. | -- |
| `BRAND_ADDRESS_CITY` | City of the organization address published in the user-access brand bundle. | -- |
| `BRAND_ADDRESS_COUNTRY` | Country of the organization address published in the user-access brand bundle. | -- |
| `BRAND_ADDRESS_LINE` | Street address of the organization published in the brand bundle. Separate multiple address lines with a newline. | -- |
| `BRAND_ADDRESS_POSTAL_CODE` | Postal code of the organization address published in the brand bundle. | -- |
| `BRAND_ADDRESS_STATE` | State or province of the organization address published in the brand bundle. | -- |
| `BRAND_ALIASES` | Comma-separated alternative names of the organization, published as Organization.alias in the brand bundle so apps can find it by former or informal names. When unset: Unset means no aliases. | -- |
| `BRAND_APP_STORE_URL` | URL of an external app store. When set, /apps redirects there instead of serving the built-in store, and the SMART configuration advertises it as app_store_url. | -- |
| `BRAND_CATEGORY` | SMART user-access category of the organization, published as its Organization.type in the brand bundle. Values outside the SMART UserAccessCategory value set fall back to prov. | `prov` |
| `BRAND_DEVELOPER_URL` | HTTPS URL where app developers learn how to get access, published as each Endpoint's contact in the brand bundle. The admin API requires https; the env value is not validated. When unset: Unset uses BASE_URL + /docs/admin-ui/smart-apps. | -- |
| `BRAND_IDENTIFIER` | Identifier value of the brand, advertised as user_access_brand_identifier in the SMART configuration and as the Organization identifier. Usually the organization website URL. When unset: Unset uses BRAND_WEBSITE, then BASE_URL, then http://localhost:8445. | -- |
| `BRAND_IDENTIFIER_SYSTEM` | Identifier system for BRAND_IDENTIFIER. Keep the default when the identifier is a URL; set it to another system (for example an NPI system URI) when using a registry identifier. | `urn:ietf:rfc:3986` |
| `BRAND_LOGIN_THEME` | Keycloak login theme name reported in the brand configuration. It is not applied to Keycloak by itself: the realm's own loginTheme overrides it once loaded, startup sets the realm to the shipped theme, and only saving Branding in the admin UI writes a theme to the realm. | -- |
| `BRAND_LOGO_LICENSE_URL` | URL of the license terms for the brand logo, published as brandLogoLicense in the brand bundle. | -- |
| `BRAND_LOGO_URL` | URL of the organization logo (SVG or 1024px PNG with transparent background), published as brandLogo in the brand bundle. | -- |
| `BRAND_NAME` | Display name of the organization, used as Organization.name in the brand bundle and on the instance pages. Saving it in the admin UI also sets the Keycloak login page heading. | `Proxy Smart Backend` |
| `BRAND_PORTAL_DESCRIPTION` | Markdown description of the primary patient portal, published in the organization-portal extension. When unset: When BRAND_PORTAL_NAME and BRAND_PORTAL_URL are both unset and the patient-portal app is deployed, its manifest description is used. | -- |
| `BRAND_PORTAL_LOGO_LICENSE_URL` | URL of the license terms for the patient portal logo, published as portalLogoLicense. | -- |
| `BRAND_PORTAL_LOGO_URL` | URL of the primary patient portal logo, published as portalLogo in the brand bundle. | -- |
| `BRAND_PORTAL_NAME` | Name patients know the primary patient portal by, published in the organization-portal extension of the brand bundle. When unset: When this and BRAND_PORTAL_URL are both unset and the patient-portal app is deployed, its manifest client_name (or Patient Portal) is used. | -- |
| `BRAND_PORTAL_URL` | Patient portal URL advertised in the User-Access Brand bundle. It is also where SMART Health Link recipients land when the minting app has no usable launch URL. When unset: When both BRAND_PORTAL_NAME and BRAND_PORTAL_URL are unset and the patient-portal app is deployed, the portal is auto-detected as {BASE_URL}/apps/patient-portal/. SMART Health Link viewers fall back to the same path. | -- |
| `BRAND_PRIMARY_COLOR` | Primary brand colour used on the themed login and landing pages. Accepts a hex colour (#rgb, #rrggbb, #rrggbbaa), a flat rgb()/hsl() function or a CSS colour keyword; anything else is silently ignored. | -- |
| `BRAND_WEBSITE` | Organization website advertised in the User-Access Brand bundle. It also serves as the default brand identifier when BRAND_IDENTIFIER is unset. When unset: Falls back to BASE_URL, then http://localhost:8445. | -- |
<!-- /guido:fields -->

## SMART Health Links

<!-- guido:fields #smart-health-links -->
| Variable | Description | Default |
|---|---|---|
| `SHL_DB_PATH` | Path of the SQLite file that stores SMART Health Link sessions. Point it at durable storage if DATA_DIR is not on a persistent volume. When unset: DATA_DIR/shl-sessions.sqlite. | -- |
| `SHL_EXCHANGE_CLIENT_ID` | Client id of the confidential Keycloak service account the SMART Health Links flow uses for RFC 8693 token exchange. The backend creates or reconciles this client in Keycloak at startup. | `shl-exchange` |
| `SHL_EXCHANGE_CLIENT_SECRET` | Secret of the SHL token-exchange client; the backend sets Keycloak's copy to match it at startup. Without it SMART Health Links are disabled. | -- |
| `URL_SHORTENER_BASE` | Base URL of the shortener service that creates short SMART Health Link URLs via POST <base>/api/shorten when a share request opts in with shortenUrl. Point it at your own shortener, or disable shortening, if links must not leave your infrastructure. | `https://go.maxhealth.tech` |
| `URL_SHORTENER_ENABLED` | Whether SMART Health Link shares that ask for a short URL may use the shortener at URL_SHORTENER_BASE. Only the exact value false disables it; when disabled or on failure the share carries no short URL. | `true` |
<!-- /guido:fields -->

## Signing keys

<!-- guido:fields #signing-keys -->
| Variable | Description | Default |
|---|---|---|
| `PROXY_SIGNING_JWKS_URL` | URL from which Keycloak fetches this backend's JWKS to verify proxy-signed client assertions. Set it whenever Keycloak cannot reach the backend as 'backend' on the compose network, for example on ECS, or every private_key_jwt client fails with invalid_client. When unset: Derived as http://localhost:<PORT>/.well-known/jwks.json when the Keycloak host is loopback, otherwise http://backend:<PORT>/.well-known/jwks.json (the docker-compose service name). | -- |
| `PROXY_SIGNING_KEY_FILE` | Path to a PEM RSA private key the proxy uses to sign federated client assertions it forwards to Keycloak, published at /.well-known/jwks.json. Without a key each node generates a throwaway one at startup, so set it for persistence and for any deployment with more than one backend node. | -- |
| `PROXY_SIGNING_KEY_ID` | Key id (kid) published for the proxy signing key and put in the header of every proxy-signed assertion. Change it when you rotate the key so Keycloak picks up the new one. | `proxy-signing-key-1` |
| `PROXY_SIGNING_KEY_PEM` | The proxy signing RSA private key as inline PEM, for platforms that inject secrets as environment variables. Use PROXY_SIGNING_KEY_FILE instead when you can mount a file. | -- |
<!-- /guido:fields -->

## TLS

<!-- guido:fields #tls -->
| Variable | Description | Default |
|---|---|---|
| `TLS_CERT_FILE` | Path to a PEM certificate (chain) so the backend serves HTTPS itself. Normally TLS ends at a reverse proxy or load balancer and this stays unset. | -- |
| `TLS_KEY_FILE` | Path to the PEM private key matching TLS_CERT_FILE, for serving HTTPS directly from the backend. | -- |
<!-- /guido:fields -->

## Email

<!-- guido:fields #email -->
| Variable | Description | Default |
|---|---|---|
| `RESEND_API_KEY` | Resend API key for transactional email. When set, the backend sends its own emails through Resend and configures the Keycloak realm to use Resend SMTP with password reset enabled; when unset, emails are skipped. | -- |
<!-- /guido:fields -->

## Source offer (AGPL)

<!-- guido:fields #source-offer-agpl -->
| Variable | Description | Default |
|---|---|---|
| `SOURCE_COMMERCIAL_CONTACT` | Contact address for commercial licensing published by the /source route and /.well-known/agpl-source. Forks and self-hosters can set their own contact. | `hello@maxhealth.tech` |
| `SOURCE_LICENSE` | SPDX license expression published in the AGPL section 13 source offer. Change it only if your fork is distributed under different terms. | `AGPL-3.0-or-later OR LicenseRef-Commercial` |
| `SOURCE_REPOSITORY_URL` | Repository URL offered to network users as the corresponding source under AGPL section 13. Set it to your fork when you run modified code. | `https://github.com/proxy-smart/proxy-smart` |
<!-- /guido:fields -->

## Development only

<!-- guido:fields #development-only -->
| Variable | Description | Default |
|---|---|---|
| `ALLOW_DEV_AUTH_BYPASS` | Lets a signed-in user without an admin role (or without realm-management roles) use the admin API anyway, logging a warning. Only for local development; the backend refuses to start when this is true and NODE_ENV=production. | -- |
| `ALLOW_DEV_FIXTURE_SECRET` | In production the backend refuses to start when KEYCLOAK_ADMIN_CLIENT_SECRET equals the public dev fixture secret from keycloak/realm-export.json. Setting this to true skips that check, which only the compliance test suite should do. | -- |
| `DOCKER` | When set to any non-empty value, the HTTP server listens on all interfaces (0.0.0.0) instead of localhost. Only needed for a container that runs without NODE_ENV=production, since production already listens on all interfaces. | -- |
<!-- /guido:fields -->

## Build metadata

<!-- guido:fields #build-metadata -->
| Variable | Description | Default |
|---|---|---|
| `BUILD_SHA` | Git commit the image was built from, appended to the reported version as +sha. Values that are not a 7 to 40 character hex string are ignored. Set by the platform or build, not by an operator. | -- |
| `GITHUB_SHA` | Commit SHA provided by GitHub Actions, used as the build commit when BUILD_SHA is unset. Values that are not a 7 to 40 character hex string are ignored. Set by the platform or build, not by an operator. | -- |
| `JWT_AUDIENCE` | Value written as x-audience into the exported OpenAPI document by the export-openapi build script. It does not affect token validation at runtime. When unset: BASE_URL. Set by the platform or build, not by an operator. | -- |
<!-- /guido:fields -->
