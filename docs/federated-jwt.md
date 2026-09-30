# Federated JWT Client Authentication

Proxy Smart uses Keycloak's **Federated JWT** (`client-auth-federated`) preview feature to authenticate SMART Backend Services clients. Instead of sharing secrets between the proxy and Keycloak, the proxy validates a client's JWT assertion against the client's registered JWKS, then re-signs it with its own key. Keycloak verifies the proxy's signature via an Identity Provider, creating a trust chain.

## Token Flow

```
┌──────────┐       client_assertion (JWT)        ┌────────────┐
│  SMART   │ ──────────────────────────────────►  │   Proxy    │
│  Client  │  iss=clientId, sub=clientId          │   Smart    │
│          │  aud=proxy/auth/token                │  Backend   │
│          │  signed with client's private key    │            │
└──────────┘                                      └─────┬──────┘
                                                        │
                                               1. Validate JWT:
                                                  - structure, exp, jti
                                                  - iss == sub == clientId
                                                  - aud == proxy token URL
                                                  - signature vs client JWKS
                                                        │
                                               2. Re-sign with proxy key:
                                                  - iss = config.baseUrl
                                                  - sub = clientId
                                                  - aud = KC realm issuer
                                                  - kid = proxy-signing-key-1
                                                        │
                                                        ▼
                                                  ┌───────────┐
                                                  │ Keycloak  │
                                                  │           │
                                                  │ 3. "clients with federated-jwt"
                                                  │    auth flow evaluates:
                                                  │    → federated-jwt authenticator
                                                  │    → matches jwt.credential.issuer
                                                  │      to "proxy-smart-signing" IdP
                                                  │    → fetches JWKS from IdP
                                                  │      (http://backend:8445/
                                                  │       .well-known/jwks.json)
                                                  │    → verifies proxy signature
                                                  │    → matches jwt.credential.sub
                                                  │      to client's clientId
                                                  │                             
                                                  │ 4. Issues access_token for
                                                  │    service account
                                                  └───────────┘
```

## Configuration

### Keycloak Feature Flag

`client-auth-federated` is enabled by default since it graduated, so no `--features` entry
is needed. See [keycloak-features.md](keycloak-features.md) for the flags proxy-smart does set.

### Identity Provider ("proxy-smart-signing")

An OIDC Identity Provider is created automatically by `ensureProxySigningIdp()` in `backend/src/init.ts`:

| Setting | Value |
|---------|-------|
| `alias` | `proxy-smart-signing` |
| `providerId` | `oidc` |
| `issuer` | `config.baseUrl` (e.g. `https://beta.proxy-smart.com`) |
| `jwksUrl` | `http://backend:8445/.well-known/jwks.json` |
| `useJwksUrl` | `true` |
| `validateSignature` | `true` |
| `supportsClientAssertions` | `true` |
| `hideOnLogin` | `true` |

**Critical:** The `supportsClientAssertions` flag must be `"true"`. Without it, the OIDC IdP won't participate in federated-jwt client authentication, even if signatures and JWKS are configured correctly. This was the root cause of `invalid_client_credentials` errors where everything else looked correct.

The JWKS URL uses the Docker service name (`backend`) so Keycloak can reach it within the container network.

### Client Authentication Flow

The built-in "clients" flow does **not** include `federated-jwt` for realms created before the feature was enabled. The backend auto-configures this on startup:

1. Copies the built-in "clients" flow → **"clients with federated-jwt"**
2. Adds the `federated-jwt` execution (set to `ALTERNATIVE`)
3. Binds the new flow as the realm's `clientAuthenticationFlow`

Final flow executions:

| Provider | Display Name | Requirement |
|----------|-------------|-------------|
| `client-secret` | Client Id and Secret | ALTERNATIVE |
| `client-jwt` | Signed JWT | ALTERNATIVE |
| `client-secret-jwt` | Signed JWT with Client Secret | ALTERNATIVE |
| `client-x509` | X509 Certificate | ALTERNATIVE |
| **`federated-jwt`** | **Signed JWT - Federated** | **ALTERNATIVE** |

### Client Attributes

Each SMART Backend Services client needs:

| Attribute | Value | Purpose |
|-----------|-------|---------|
| `clientAuthenticatorType` | `federated-jwt` | Tells KC to use the federated authenticator |
| `jwt.credential.issuer` | `proxy-smart-signing` | Must match the IdP alias |
| `jwt.credential.sub` | Client's own `clientId` | KC matches the JWT `sub` claim to this |
| `jwks.string` | JSON string with client's public keys | Used by the proxy to validate client assertions |
| `use.jwks.string` | `true` | Enables inline JWKS (vs JWKS URL) |
| `serviceAccountsEnabled` | `true` | Required for `client_credentials` grant |

These are auto-migrated by `ensureProxySigningIdp()` for any client with `use.jwks.string=true`.

## Startup Initialization

`ensureProxySigningIdp()` in `backend/src/init.ts` performs these steps on every boot (all idempotent):

1. **Self-assign roles** -- ensures `admin-service` has `manage-identity-providers` role
2. **Create/update IdP** -- ensures `proxy-smart-signing` exists with correct JWKS URL
3. **Configure auth flow** -- ensures `federated-jwt` execution exists in the client auth flow
4. **Migrate clients** -- ensures all JWKS clients use `federated-jwt` with correct attributes

## Troubleshooting

### Error: `client_not_found`

KC cannot find a client authenticator to handle the assertion. The `federated-jwt` execution is **missing from the client auth flow**.

**Fix:** Check that `clientAuthenticationFlow` points to a flow containing the `federated-jwt` execution:

```
GET /admin/realms/{realm}
→ clientAuthenticationFlow

GET /admin/realms/{realm}/authentication/flows/{flowAlias}/executions
→ look for providerId: "federated-jwt"
```

### Error: `invalid_client_credentials`

KC found the client via `federated-jwt` but failed to verify the JWT. Possible causes:

- IdP JWKS URL is unreachable from Keycloak container (DNS / network issue)
- Proxy signing key doesn't match what's served at `/.well-known/jwks.json`
- `jwt.credential.issuer` doesn't match any IdP alias
- `jwt.credential.sub` doesn't match the JWT's `sub` claim

### Error: `Invalid token audience` (from proxy, not KC)

The client's JWT `aud` claim doesn't match `{config.baseUrl}/auth/token`. Per SMART Backend Services spec, the audience must be the token endpoint URL.

### Diagnostic Endpoints

| What | Endpoint |
|------|----------|
| Registered authenticator providers | `GET /admin/serverinfo` → `providers["client-authenticator"]` |
| Flow executions | `GET /admin/realms/{realm}/authentication/flows/{alias}/executions` |
| Realm binding | `GET /admin/realms/{realm}` → `clientAuthenticationFlow` |
| Client config | `GET /admin/realms/{realm}/clients?clientId={id}` |
| Backend JWKS | `GET /.well-known/jwks.json` |
| KC events | `GET /admin/realms/{realm}/events?type=CLIENT_LOGIN_ERROR` |

## Related Files

| File | Purpose |
|------|---------|
| `Dockerfile.keycloak` | Feature flags baked into KC image |
| `backend/src/init.ts` | `ensureProxySigningIdp()` -- IdP, flow, and client setup |
| `backend/src/lib/proxy-signing.ts` | `signProxyAssertion()` -- creates proxy-signed JWTs |
| `backend/src/routes/auth/backend-services.ts` | `translateClientAssertion()` -- validates client JWT, triggers re-signing |
| `backend/src/routes/auth/oauth.ts` | Token endpoint -- intercepts `client_assertion`, calls translation |
| `keycloak/realm-export.json` | Client definitions with `federated-jwt` attributes |
