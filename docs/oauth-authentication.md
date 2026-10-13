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
| `POST /auth/authorize` | The same, with the parameters as an `application/x-www-form-urlencoded` body (SMART `authorize-post`); answers with a 303 |
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
| `POST /auth/revoke` | RFC 7009 token revocation, forwarded to Keycloak |
| `GET /auth/userinfo` | UserInfo endpoint with authorization_details generation |

### Dynamic Client Registration

| Endpoint | Description |
|---|---|
| `POST /auth/register` | RFC 7591 Dynamic Client Registration |

## Authorization Flow Details

### SMART App Launch

1. **App redirects to `/auth/authorize`** with standard OAuth parameters plus SMART-specific:
   - `code_challenge` and `code_challenge_method=S256` -- PKCE, required on every request. `plain`, a missing method or a missing challenge is refused
   - `aud` -- the FHIR server URL the app wants to access. Required when the scope carries a SMART launch or resource scope
   - `scope` -- SMART scopes like `launch/patient patient/*.read openid fhirUser`
   - `launch` -- EHR launch token (for EHR launch flow)

   The same parameters can be sent as a form `POST` to `/auth/authorize`.

2. **Audience validation** -- `aud` (or RFC 8707 `resource`) must be the base of a configured FHIR server, `{BASE_URL}/{name}/{server}/{version}`, or the proxy's MCP endpoint, an enabled per-server MCP endpoint or an allowed external audience. A path below a FHIR base or a server that does not exist is refused, which keeps a genuine token away from a counterfeit resource server (SMART App Launch 2.2.0). For an EHR launch `aud` must also be the `iss` the launch code was minted for.

   **Refusals.** When the proxy refuses an authorization request and the `redirect_uri` is registered for the client, the app gets an RFC 6749 §4.1.2.1 error on that `redirect_uri`, with `error_description`, its `state` and the RFC 9207 `iss`:

   | `error` | When |
   |---|---|
   | `invalid_request` | PKCE missing or not `S256`; `aud` missing on a SMART request; a `launch` value that is invalid, expired, already used, bound to no client or to another client |
   | `invalid_target` | `aud` names no resource this proxy serves, or not the `iss` of the launch |
   | `access_denied` | No patient can be established for a request that needs one (see below), or a picker submission the session never offered. For an account linked to no FHIR record, `error_uri` points at `PATIENT_ONBOARDING_URL` when it is set |
   | `interaction_required` | A patient has to be chosen but the request carried `prompt=none` |

   A `redirect_uri` that is not registered gets a plain `400` with the same `error`, since an unverified address is never redirected to. An app that was refused `access_denied` because the wrong account was signed in can start again with `prompt=login`, which the proxy passes to Keycloak.

   **Redirect URIs** match exactly, or through a single trailing Keycloak `*` wildcard. SMART asks apps to register fixed, fully specified redirect URIs, and dynamic registration stores exactly what the app sends; wildcards remain for the clients shipped in the realm export, which serve several origins and development ports. A wildcard match has to keep the registered origin once the URL is parsed, may not carry userinfo, and may not leave the registered path through dot segments. A port wildcard such as `http://localhost:*` is honoured for loopback hosts only.

   **Patient context.** A request with `launch/patient` or a `patient/` scope gets a patient in context, as SMART requires of a server that grants a patient-level scope: from the EHR launch code, from a Patient `fhirUser` (directly or through a Person), or from the patient picker, which only a practitioner may use. That includes an EHR launch whose code names no patient. Anyone else is refused, and a launch whose identity is settled only at the token endpoint and still has no patient there gets `invalid_grant` instead of a token.

3. **Keycloak handles authentication** -- user logs in, consents to scopes, Keycloak redirects back with an authorization code.

4. **App exchanges code at `/auth/token`** -- the proxy forwards the token request to Keycloak, then adds the launch context it holds for that code (`patient`, `encounter`, `fhirContext`, `need_patient_banner`, `smart_style_url`, `intent`) and an absolute `fhirUser` to the response. A confidential client authenticates with `client_secret_basic` (HTTP Basic), `client_secret_post`, or `private_key_jwt`; the proxy passes the first two to Keycloak unchanged and re-signs the third.

### EHR Launch

An EHR (or an agent acting for its signed-in user) calls `POST /auth/launch` with its Bearer token, the `clientId` of the app it launches, and the context to launch with: `patient`, `encounter`, `fhirUser`, `intent`, `fhirContext`, `appContext`, `smartStyleUrl`, `tenant`, `needPatientBanner`. It should also send the `iss` it will hand the app. The proxy answers with a signed, short-lived `launch` code, which the EHR passes to the app's launch URL together with `iss`.

A patient may name only their own record and a practitioner any patient; a `fhirUser` may only name the caller. The code is bound to the caller, so its context applies only when the same user signs in. `appContext` is returned as is in the token response.

The proxy holds the launch context to the SMART rules:

- `clientId` is required, and the code authorizes that client only.
- A code works once. The first authorization request that passes validation spends it, on every node when `DATABASE_URL` is set; launch the app again for a new one.
- With `iss`, which must be the base of a configured FHIR server, the code is bound to that server: the app's `aud` must name it, and an `encounter` given with a `patient` is read there with the caller's token and must belong to that patient. Without `iss` neither check can run.
- Each `fhirContext` item needs `reference`, `canonical` or `identifier`. `role` may be left out but not empty, and is an absolute URI unless it is `launch`. Patient and Encounter go in the `patient` and `encounter` parameters; inside `fhirContext` they need a role other than `launch`. Anything else is refused with `400`.

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

`POST /auth/introspect` is for resource servers, and the caller authenticates as one (RFC 7662 §2.1): HTTP Basic with its client credentials, or `client_secret` / `client_assertion` in the body. A request without credentials, including one that only names a `client_id`, gets `401 invalid_client`. Keycloak then answers for that caller, so a token is `active` only for a resource server in its audience, which is what RFC 8707 resource indicators put there.

For an active token the response repeats the launch context of the original token response: `patient`, `encounter`, `fhirUser`, `fhirContext`, `intent`, `need_patient_banner`, `smart_style_url`, `tenant`, and the RFC 8693 `act` chain of an exchanged token. With `DATABASE_URL` set the context is stored in PostgreSQL, so every backend node returns it; without a database it lives in memory on the node that issued the token, and a multi-node deployment needs sticky routing (see [environment variables](environment-variables.md#database-and-multi-node-state)).

### Token Revocation

`POST /auth/revoke` takes `token` and an optional `token_type_hint` (RFC 7009). A confidential client authenticates as it does at the token endpoint: HTTP Basic is passed to Keycloak unchanged, `client_secret` travels in the body, and a `private_key_jwt` assertion (with `aud` = the proxy token endpoint) is verified and re-signed. A public client sends only its `client_id`. A request that names no client gets `401 invalid_client`.

An unknown, expired or already revoked token answers `200`, as RFC 7009 §2.2 requires. Revoking a token issued to another client is refused by Keycloak and the refusal is passed through. A successful revocation also drops the launch context the proxy held for that token.

Keycloak records the revocation, so introspection reports the token inactive from then on. The proxy validates access tokens locally, so it also keeps the `jti` of each access token revoked through it until that token would have expired, and refuses it on the FHIR, DICOMweb, MCP and admin routes. Each node checks that list in memory. With `DATABASE_URL` set every revocation is also written to PostgreSQL and the other nodes pick it up within five seconds; without a database the list stays on the node that took the revocation, and the others accept the token until it expires. Revoking a refresh token makes Keycloak end that client's session, which stops new access tokens but not the ones already issued.

### Managing app access

`management_endpoint` in `.well-known/smart-configuration` points the user to where they see and revoke the apps they authorized: the consent app when `CONSENT_APP_URL` (or the consent `appUrl` runtime setting) is set, otherwise the Keycloak account console's applications page (`{KEYCLOAK_PUBLIC_URL}/realms/{realm}/account/applications`).

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
