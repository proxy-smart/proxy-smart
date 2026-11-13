# Healthcare Users

Manage Keycloak users that participate in SMART on FHIR flows. Users created here get Keycloak accounts and can optionally be linked to FHIR Person/Practitioner resources and external identity providers.

## API Endpoints

<!-- generated:admin-routes /admin/healthcare-users -->
| Method | Path | Summary |
|---|---|---|
| `GET` | `/admin/healthcare-users/` | List Healthcare Users |
| `POST` | `/admin/healthcare-users/` | Create Healthcare User |
| `GET` | `/admin/healthcare-users/:userId` | Get Healthcare User |
| `PUT` | `/admin/healthcare-users/:userId` | Update Healthcare User |
| `DELETE` | `/admin/healthcare-users/:userId` | Delete Healthcare User |
| `POST` | `/admin/healthcare-users/:userId/client-roles/:clientId` | Add Client Roles to User |
| `DELETE` | `/admin/healthcare-users/:userId/client-roles/:clientId/:roleName` | Remove Client Role from User |
| `GET` | `/admin/healthcare-users/:userId/federated-identities` | List Federated Identities |
| `POST` | `/admin/healthcare-users/:userId/federated-identities/:provider` | Link Federated Identity |
| `DELETE` | `/admin/healthcare-users/:userId/federated-identities/:provider` | Unlink Federated Identity |
| `POST` | `/admin/healthcare-users/:userId/realm-roles` | Add Realm Roles to User |
| `DELETE` | `/admin/healthcare-users/:userId/realm-roles/:roleName` | Remove Realm Role from User |
<!-- /generated:admin-routes -->

## Creating a User

Required fields:

- **Username** -- Keycloak login name
- **First name / Last name**
- **Email** -- used for password resets and notifications
- **Enabled** -- whether the account is active immediately
- **Credentials** -- initial password (can be marked temporary)

Optional fields:

- **Attributes** -- key-value pairs stored on the Keycloak user (e.g., `fhirUser`, department)
- **Realm roles** -- assign roles like `clinician`, `admin`, etc.
- **Groups** -- Keycloak group membership

## Federated Identity Links

A user can be linked to external identity providers (SAML, OIDC, LDAP). This allows them to log in via those providers while maintaining a single Keycloak identity.

Use the federated-identities endpoints to:
- List which providers a user is linked to
- Link a new provider (requires the external user ID and username)
- Unlink a provider

## Launch Contexts

Launch context is resolved during each authorization rather than stored on the user; see [Launch Context](./launch-context.md). The `fhirUser` attribute is the one context value kept on the user, and it decides which FHIR resource the user acts as.

## Roles

Roles are managed separately via `/admin/roles/`:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/roles/` | List all realm roles |
| POST | `/admin/roles/` | Create role |
| GET | `/admin/roles/:roleName` | Get role details |
| PUT | `/admin/roles/:roleName` | Update role |
| DELETE | `/admin/roles/:roleName` | Delete role |
| GET | `/admin/roles/clients/:clientId` | List client-specific roles |

## Organizations

Users can be members of organizations (Keycloak Organizations feature):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/organizations/` | List organizations |
| POST | `/admin/organizations/` | Create organization |
| GET | `/admin/organizations/:orgId/members` | List members |
| POST | `/admin/organizations/:orgId/members` | Add member |
| DELETE | `/admin/organizations/:orgId/members/:userId` | Remove member |

Organizations support per-org branding overrides via the `/:orgId/branding` endpoints.

## Related

- [Identity Providers](./identity-providers.md) -- configure the external IdPs users can link to
- [Scope Management](./scope-management.md) -- what scopes apps can request on behalf of users
- [Launch Context](./launch-context.md) -- how launch context reaches a token
- [User Federation](./user-federation.md) -- LDAP directory connections, sync operations, and attribute mapping

## User Federation (LDAP)

The Users page carries a **User Federation** sub-tab for LDAP directory connections, which imports and synchronizes users from an enterprise directory (Active Directory, OpenLDAP, and similar) into Keycloak rather than managing them here.

See [User Federation](./user-federation.md) for provider configuration, sync operations, and attribute mapping.
