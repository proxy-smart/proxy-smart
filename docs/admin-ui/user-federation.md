# User Federation

User Federation manages LDAP directory connections for importing and synchronizing users into Keycloak. This is found as a sub-tab within the **Users** admin page.

## Accessing

Navigate to **Users** in the admin sidebar, then select the **User Federation** tab.

## Provider List

Each configured LDAP provider shows its name and connection URL, its enabled state, how many users it has imported, and when it last synced.

## Adding an LDAP Provider

Click **Add Provider** to configure a new LDAP connection:

| Field | Description |
|---|---|
| **Name** | Display name for the federation provider |
| **Vendor** | LDAP vendor (Active Directory, OpenLDAP, Red Hat DS, etc.) |
| **Connection URL** | LDAP server URL (`ldap://` or `ldaps://`) |
| **Bind DN** | Distinguished name for binding to LDAP |
| **Bind Credential** | Password for the bind DN |
| **Users DN** | Base DN for user searches |
| **User Object Classes** | LDAP object classes for user entries |
| **Edit Mode** | How Keycloak writes back to LDAP (`READ_ONLY`, `WRITABLE`, `UNSYNCED`) |
| **Search Scope** | LDAP search scope (`ONE_LEVEL` or `SUBTREE`) |
| **Pagination** | Enable LDAP pagination for large directories |
| **Import Users** | Whether to import users into Keycloak's local database |
| **Sync Registrations** | Sync newly registered Keycloak users back to LDAP |

## Connection Testing

Two checks are available before saving, and they fail differently: **Test Connection** covers network reachability and the TLS handshake, while **Test Authentication** goes further and confirms the bind DN and credential are accepted. A connection that passes the first and fails the second is a credential problem, not a network one.

## Synchronization

A full sync imports every user matching the filter; a changed-users sync imports only those modified since the last run, which is the one to schedule on a large directory. Two teardown actions differ in an important way: **Remove Imported** deletes the users that came from this provider, while **Unlink Users** keeps them in Keycloak and only severs the federation link.

## Mapper Configuration

Attribute mappers control which LDAP attributes reach the Keycloak user, listed per provider as `directory attribute → user attribute` with the mapper's type and synchronization direction.

Mappers decide which directory attributes reach the Keycloak user, which makes
them a prerequisite for SMART launches: a directory user without the `fhirUser`
attribute cannot be resolved to a FHIR resource.

Open **Mappers** on a provider card to list its mappers as
`directory attribute → user attribute`, add one (the form is built from the
properties Keycloak reports for the chosen mapper type, so it adapts to the LDAP
vendor), or delete one. The card itself shows a summary chip: the mapper count,
or a warning when nothing writes `fhirUser`.

Unlike identity providers, there is no provisioning action here. The directory
attribute holding the FHIR reference is deployment-specific -- it may be
`fhirUser`, an employee number, or a vendor-specific OID -- so the dialog reports
the gap and leaves the source attribute to the admin rather than guessing.

## API Endpoints

<!-- generated:admin-routes /admin/user-federation -->
| Method | Path | Summary |
|---|---|---|
| `GET` | `/admin/user-federation/` | List LDAP Federations |
| `POST` | `/admin/user-federation/` | Create LDAP Federation |
| `GET` | `/admin/user-federation/:id` | Get LDAP Federation |
| `PUT` | `/admin/user-federation/:id` | Update LDAP Federation |
| `DELETE` | `/admin/user-federation/:id` | Delete LDAP Federation |
| `GET` | `/admin/user-federation/:id/mapper-types` | List LDAP Mapper Types |
| `GET` | `/admin/user-federation/:id/mappers` | List LDAP Mappers |
| `POST` | `/admin/user-federation/:id/mappers` | Create LDAP Mapper |
| `PUT` | `/admin/user-federation/:id/mappers/:mapperId` | Update LDAP Mapper |
| `DELETE` | `/admin/user-federation/:id/mappers/:mapperId` | Delete LDAP Mapper |
| `POST` | `/admin/user-federation/:id/remove-imported` | Remove Imported Users |
| `POST` | `/admin/user-federation/:id/sync` | Sync LDAP Users |
| `POST` | `/admin/user-federation/:id/unlink` | Unlink Federated Users |
| `GET` | `/admin/user-federation/count` | Get User Federation Count |
| `POST` | `/admin/user-federation/test-authentication` | Test LDAP Authentication |
| `POST` | `/admin/user-federation/test-connection` | Test LDAP Connection |
<!-- /generated:admin-routes -->
