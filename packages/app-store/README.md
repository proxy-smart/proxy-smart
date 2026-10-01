# @proxy-smart/app-store

Visibility and publication state for the SMART app catalog. Framework-agnostic, with pluggable persistence.

The package holds one decision: which apps a user sees at `/apps`. That decision spans two different populations, and keeping them straight is most of what this package is for.

## Two populations, two namespaces

Apps reach the catalog by two different routes, and they are keyed differently.

**Discovered apps** are directories on disk, served by the backend from the `apps_static` volume. They exist because something deployed them, so the only decision left is whether to show them. They are keyed by **app id**, the directory name, and controlled through `hiddenAppIds`: present means hidden, absent means visible. The default is visible.

**Registered apps** are Keycloak clients that an administrator chose to surface. Nothing puts them in the catalog automatically. They are keyed by **client id** and carried in full as `PublishedApp` entries, because unlike a directory they have no on-disk manifest to read a name or logo from. The default is absent.

Hiding a registered app is therefore not `hideApp` but `unpublishApp`, and the two id spaces never mix.

## Install

```bash
bun add @proxy-smart/app-store
```

```ts
import { AppStoreConfigStore } from '@proxy-smart/app-store'
import type { PublishedApp, AppStoreConfig } from '@proxy-smart/app-store'
```

Subpath entries are available for narrower imports: `@proxy-smart/app-store/store` for `AppStoreConfigStore`, `@proxy-smart/app-store/types` for the types alone.

## Usage

```ts
const store = new AppStoreConfigStore({
  configPath: '/data/app-store-config.json',
  logger: console,
})

store.hideApp('legacy-viewer')            // discovered app, by directory name
store.publishApp({                        // registered client, by clientId
  clientId: 'patient-portal',
  name: 'Patient Portal',
  description: 'Health records, imaging and IPS',
  launchUrl: 'https://portal.example.com/launch',
  category: 'patient',
})

const visible = store.getPublishedApps()
```

Every mutator returns the full updated `AppStoreConfig` and persists before returning, so there is no separate save step and no window where the in-memory state has moved ahead of the backing store.

## AppStoreConfigStore

Constructed with `AppStoreConfigStoreOptions`, which takes either a `configPath` (used by the default file backend) or a `persistence` implementation that replaces file I/O entirely. An optional `logger` receives a warning when a load fails.

| Method | Returns | Notes |
|---|---|---|
| `getConfig()` | `AppStoreConfig` | The whole current config |
| `reload()` | `void` | Re-read from the persistence backend, discarding in-memory state |
| `getHiddenAppIds()` | `string[]` | Hidden discovered-app ids |
| `setHiddenAppIds(ids)` | `AppStoreConfig` | Replaces the list wholesale |
| `hideApp(appId)` | `AppStoreConfig` | Idempotent; a second call does not write |
| `showApp(appId)` | `AppStoreConfig` | Removes the id from the hidden list |
| `getPublishedApps()` | `PublishedApp[]` | Registered apps in the catalog |
| `publishApp(app)` | `AppStoreConfig` | Upserts by `clientId` |
| `unpublishApp(clientId)` | `AppStoreConfig` | Removes by `clientId` |

A malformed or missing config file is not an error. `load` falls back to an empty config and warns through the logger, because a store that refuses to construct would take the whole catalog down over a corrupt visibility file.

## Custom persistence

The default `configPath` backend writes JSON to disk, which is fine for a single process and wrong for several: two backend instances would each hold their own copy and overwrite each other. Supply `persistence` to point the store at somewhere shared instead.

```ts
const store = new AppStoreConfigStore({
  persistence: {
    load: () => readConfigFromPostgres(),
    save: (config) => writeConfigToPostgres(config),
  },
})
```

`AppStoreConfigPersistence` is deliberately synchronous and only has `load` and `save`. The mutation logic (upsert semantics, idempotent hide, timestamp bookkeeping) stays in `AppStoreConfigStore` for every backend, so a new backend implements storage and inherits behavior rather than reimplementing it.

A backend that stores the config itself (a key/value table, say) can run what it reads through `normalizeAppStoreConfig(raw)`, the same normaliser the store applies on load. It accepts any value, keeps only string `hiddenAppIds` and fully formed `publishedApps`, and falls back to an empty config for anything that is not an object.

## Types

`PublishedApp` describes a registered app in the catalog: `clientId`, `name`, `description`, `launchUrl`, `category`, and an optional `logoUri`.

`AppStoreConfig` is what gets persisted: `hiddenAppIds`, `publishedApps`, and an `updatedAt` ISO timestamp refreshed on every mutation.

`AppStoreConfigPersistence` is the storage contract described above. `AppStoreConfigStoreOptions` is the constructor argument.

## Related

- [SMART Apps administration](https://max-health-inc.github.io/proxy-smart/admin-ui/smart-apps) covers the admin UI and the `/admin/app-store/` endpoints that drive this store.
