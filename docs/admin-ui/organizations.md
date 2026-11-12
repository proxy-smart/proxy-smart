# Organizations

The Organizations page manages Keycloak organizations within your realm. Organizations represent healthcare entities such as hospitals, clinics, or departments, and allow grouping users with shared branding and access policies.

## Accessing

Navigate to **Organizations** in the admin sidebar.

## Organization List

The main view lists every organization with its name, domain, and member count, searchable by name or domain, with edit and delete available inline.

## Creating an Organization

Click **Add Organization** to create a new organization:

| Field | Description |
|---|---|
| **Name** | Display name of the organization |
| **Domains** | Email domains associated with this organization |
| **Description** | Optional description |
| **Attributes** | Custom key-value attributes |

## Editing an Organization

Clicking an organization opens a dialog with two tabs. **General** edits the same fields as creation: name, domains, description, and attributes. **Branding** sets a logo URL, name, website, and portal details that override the global brand, which is how a sub-organization appears as its own entry in the SMART User-Access Brand Bundle instead of inheriting the parent's identity.

## Member Management

Membership is assignment, not creation: an existing Keycloak user is added to or removed from the organization. Members inherit the organization's branding and any organization-scoped access policies, so moving a user between organizations changes what patient apps display for them.

## API Endpoints

<!-- generated:admin-routes /admin/organizations -->
| Method | Path | Summary |
|---|---|---|
| `GET` | `/admin/organizations/` | List Organizations |
| `POST` | `/admin/organizations/` | Create Organization |
| `GET` | `/admin/organizations/:orgId` | Get Organization |
| `PUT` | `/admin/organizations/:orgId` | Update Organization |
| `DELETE` | `/admin/organizations/:orgId` | Delete Organization |
| `GET` | `/admin/organizations/:orgId/branding` | Get Organization Branding |
| `PUT` | `/admin/organizations/:orgId/branding` | Update Organization Branding |
| `GET` | `/admin/organizations/:orgId/members` | List Organization Members |
| `POST` | `/admin/organizations/:orgId/members` | Add Member |
| `DELETE` | `/admin/organizations/:orgId/members/:userId` | Remove Member |
| `GET` | `/admin/organizations/count` | Count Organizations |
<!-- /generated:admin-routes -->

## Relationship to Branding

Organization branding integrates with the SMART 2.2.0 User-Access Brand Bundle. When an organization has custom branding configured, it appears as a separate brand entry in the published bundle, allowing patient apps to display the correct logo and portal link for each sub-organization.

See [Brand Management](branding) for global branding configuration.
