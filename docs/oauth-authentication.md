# OAuth & Authentication

Proxy Smart acts as an OAuth 2.0 / OpenID Connect proxy between SMART apps and Keycloak. All authentication traffic flows through the `/auth` endpoints, which validate, enrich, and forward requests to the underlying Keycloak realm.

## Architecture

```
SMART App  ──►  /auth/authorize  ──►  Keycloak /auth endpoint
                                          │
SMART App  ◄──  redirect with code  ◄────┘
                                          
SMART App  ──►  /auth/token      ──►  Keycloak /token endpoint
                                          │
SMART App  ◄──  access_token     ◄────────┘
                                          
SMART App  ──►  /proxy-smart/…   ──►  FHIR Server (with validated token)
```

## Endpoints

### Discovery

| Endpoint | Description |
|---|---|
| `GET /auth/.well-known/openid-configuration` | Proxies Keycloak's OIDC discovery metadata |
| `GET /auth/.well-known/oauth-authorization-server` | OAuth 2.0 AS Metadata (RFC 8414) |
| `GET /auth/config` | Returns Keycloak connectivity status and realm info |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 Protected Resource Metadata for MCP clients |
| `GET /.well-known/jwks.json` | JSON Web Key Set for token verification |

### Authorization Flow

| Endpoint | Description |
|---|---|
| `GET /auth/authorize` | Redirects to Keycloak's authorization endpoint |
| `GET /auth/login` | Simplified login redirect with sensible defaults for UI apps |
| `GET /auth/logout` | Proxies logout to Keycloak with `id_token_hint` and redirect |
| `GET /auth/identity-providers` | Public list of enabled identity providers for login pages |

### Launch

| Endpoint | Description |
|---|---|
| `POST /auth/launch` | Issues a signed launch code for an EHR launch (see [EHR Launch](#ehr-launch)) |
| `POST /auth/launch/task` | Acts on a SMART launch Task and returns the app launch URL (see [Task-Based App Launch](/task-launch)) |

### Token Operations

| Endpoint | Description |
|---|---|
| `POST /auth/token` | Proxies token requests to Keycloak (authorization code, refresh, client credentials) |
| `POST /auth/introspect` | Token introspection with SMART launch context enrichment |
| `GET /auth/userinfo` | UserInfo endpoint with authorization_details generation |

### Dynamic Client Registration

| Endpoint | Description |
|---|---|
| `POST /auth/register` | RFC 7591 Dynamic Client Registration |

## Authorization Flow Details

### SMART App Launch

1. **App redirects to `/auth/authorize`** with standard OAuth parameters plus SMART-specific:
   - `aud` -- the FHIR server URL the app wants to access (validated against configured servers)
   - `scope` -- SMART scopes like `launch/patient patient/*.read openid fhirUser`
   - `launch` -- EHR launch token (for EHR launch flow)

2. **Audience validation** -- the proxy validates the `aud` parameter matches a configured FHIR endpoint, preventing token leakage to unauthorized servers (SMART App Launch 2.2.0 requirement).

3. **Keycloak handles authentication** -- user logs in, consents to scopes, Keycloak redirects back with an authorization code.

4. **App exchanges code at `/auth/token`** -- the proxy forwards the token request to Keycloak. The response includes SMART launch context claims (patient, encounter, fhirUser) injected by Keycloak scope mappers.

### EHR Launch

An EHR (or an agent acting for its signed-in user) calls `POST /auth/launch` with its Bearer token and the context to launch with: `patient`, `encounter`, `fhirUser`, `intent`, `fhirContext`, `appContext`, `smartStyleUrl`, `tenant`, `needPatientBanner`, and optionally the `clientId` the code is meant for. The proxy answers with a signed, short-lived `launch` code, which the EHR passes to the app's launch URL together with `iss`.

A patient may name only their own record and a practitioner any patient; a `fhirUser` may only name the caller. The code is bound to the caller, so its context applies only when the same user signs in. `appContext` is returned as is in the token response.

To launch from a FHIR Task instead, see [Task-Based App Launch](/task-launch).

### Supported Grant Types

| Grant Type | Use Case |
|---|---|
| `authorization_code` | Standard SMART App Launch (EHR and standalone) |
| `refresh_token` | Token refresh |
| `client_credentials` | Backend Services (with JWT client assertion) |
| `password` | Resource Owner Password (admin tools only) |
| Token Exchange (RFC 8693) | Subject token exchange for delegated access |

### Backend Services

For system-to-system access without user interaction:

- Uses `client_credentials` grant with `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
- Client authenticates with a signed JWT containing `system/*.read` scopes
- No user context -- suitable for bulk data, analytics, and integration engines

### Token Introspection

`POST /auth/introspect` enriches Keycloak's introspection response with SMART-specific fields:

- Generates `authorization_details` from token claims and configured FHIR servers
- Includes FHIR server locations, versions, patient context, and granted scopes
- Follows the SMART on FHIR authorization details type (`smart_on_fhir`)

### UserInfo

`GET /auth/userinfo` returns the standard OIDC UserInfo response plus `authorization_details` generated from the token's SMART claims and configured FHIR server endpoints.

## Keycloak Unavailability

If Keycloak is unreachable when a user tries to authenticate, the proxy returns a friendly HTML error page (HTTP 503) with a retry button instead of a raw browser connection error. This applies to `/auth/authorize` and `/auth/login`.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `KEYCLOAK_BASE_URL` | Internal Keycloak URL | -- |
| `KEYCLOAK_PUBLIC_URL` | Browser-facing Keycloak URL (if different from internal) | derives from `KEYCLOAK_BASE_URL` |
| `KEYCLOAK_REALM` | Keycloak realm name | -- |
| `KEYCLOAK_ADMIN_CLIENT_ID` | Service account client ID for admin API calls | -- |
| `KEYCLOAK_ADMIN_CLIENT_SECRET` | Service account client secret | -- |
| `KEYCLOAK_DOMAIN` | Domain override for public URL generation | -- |
