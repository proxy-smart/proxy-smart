# SMART Apps

Register and manage SMART on FHIR OAuth clients. Each SMART app corresponds to a Keycloak client with SMART-specific attributes.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/smart-apps/` | List all registered SMART apps |
| POST | `/admin/smart-apps/` | Register a new SMART app |
| GET | `/admin/smart-apps/:clientId` | Get app details |
| PUT | `/admin/smart-apps/:clientId` | Update app configuration |
| DELETE | `/admin/smart-apps/:clientId` | Remove app registration |

## App Registration

When creating a SMART app, you provide:

- **Client ID** -- unique identifier used in OAuth flows
- **App Name** -- human-readable display name
- **Redirect URIs** -- allowed OAuth callback URLs
- **Launch URI** -- the URL opened when the app is launched from an EHR context
- **Client Type** -- `public` (SPA, native) or `confidential` (backend service)
- **Grant Types** -- `authorization_code`, `client_credentials`, etc.
- **Scopes** -- which SMART scopes the app is allowed to request

## App Types

`appType` says whose behalf the app acts on, and that decides its grants:

| Type | `appType` | Acts as | Grants |
|------|-----------|---------|--------|
| EHR Launch | `ehr-launch` | the signed-in user, launched from within EHR context (patient already selected) | authorization code |
| Standalone Launch | `standalone-app` | the signed-in user; the app selects its own context | authorization code |
| Backend Service | `backend-service` | itself, with no user (`system/` scopes) | `client_credentials` (service account) |
| Agent | `agent` | the user signed in to the app calling it: it exchanges the token it is handed ([RFC 8693](https://www.rfc-editor.org/rfc/rfc8693)) and is recorded as the actor (`act`) while `sub` stays the user | token exchange; no service account, no login of its own |

An agent never holds a token without a user behind it, so it sees only what that user may see. `serviceAccountsEnabled` overrides the default in either direction.

### Resource servers

`resourceServer` is a separate question: whether tokens are issued *to* the app ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). Its client id must be its https URL, which becomes its `resource_url`. An MCP server that reads FHIR for the user is both: an `agent` that is also a `resourceServer`. Clients request tokens with `resource=<its URL>`, and it exchanges them with `resource=<FHIR base>`. Keycloak's exchange ignores `resource`, so the proxy maps it onto the client holding that `resource_url` (`audience`) and answers `invalid_target` when none does. Give such an agent `fhirUser` and `user/` scopes: `patient/` scopes need a launch patient that an exchanged token does not have.

## Client Configuration

The backend stores the full Keycloak client configuration and adds SMART-specific metadata:

- **PKCE enforcement** -- required for public clients per SMART STU2
- **Token lifetimes** -- access token and refresh token expiry
- **Allowed scopes** -- restrict which scopes the app can request
- **Web origins** -- CORS origins for browser-based apps
- **Logo URI** -- displayed in consent screens and app store

## Sub-Tabs

The SMART Apps page contains three sub-tabs.

### Registered Apps

The main view for managing manually registered SMART client applications, documented above.

### App Store

Publication and visibility are separate actions, which is what lets an app be pulled from view without losing its catalog entry:

| Action | Description |
|---|---|
| **Publish** | Make an app available in the app store catalog |
| **Unpublish** | Remove an app from the catalog |
| **Hide** | Hide an app from the catalog without removing it |
| **Show** | Restore visibility of a hidden app |

API endpoints: `GET /admin/app-store/`, `POST /admin/app-store/publish`, `POST /admin/app-store/:appId/hide`, `POST /admin/app-store/:appId/show`, `POST /admin/app-store/:appId/unpublish`.

### Dynamic Client Registration

Manages the RFC 7591 Dynamic Client Registration policy: which requirements and defaults apply to clients that register themselves rather than being entered here by an administrator. The policy can be viewed, updated, or reset to its factory defaults.

API endpoints: `GET /admin/client-registration/settings`, `PUT /admin/client-registration/settings`, `POST /admin/client-registration/reset-defaults`.

## Related

- [Scope Management](./scope-management.md) -- configure which scopes exist
- [Launch Contexts](./launch-context.md) -- set per-user launch context attributes
- [FHIR Servers](./fhir-servers.md) -- the upstream servers apps will access

