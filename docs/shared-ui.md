# Shared UI Library

`@proxy-smart/shared-ui` is the shared React component library for all Proxy Smart SMART apps. It lives in a [separate repository](https://github.com/Max-Health-Inc/shared-ui) and is consumed as a git dependency.

## Installation

All apps in the monorepo already depend on it. The `package.json` entry uses a GitHub git reference:

```json
"@proxy-smart/shared-ui": "github:Max-Health-Inc/shared-ui"
```

Bun resolves this to the latest commit on `main` when `bun.lock` is regenerated.

## SmartAppShell

The primary component -- replaces ~60 lines of duplicated auth state rendering in every SMART app.

```tsx
import { SmartAppShell } from "@proxy-smart/shared-ui"
import { smartAuth } from "@/lib/smart-auth"
import { Heart } from "lucide-react"

export default function App() {
  return (
    <SmartAppShell
      smartAuth={smartAuth}
      header={{ title: "My App", icon: Heart }}
      title="My App"
      description="Sign in to access your health records."
      icon={Heart}
      maxWidth="max-w-5xl"
    >
      <Dashboard />
    </SmartAppShell>
  )
}
```

### Props

| Prop | Type | Description |
|------|------|-------------|
| `smartAuth` | `SmartAuthLike` | The SmartAuth instance (from `createSmartAuth`) |
| `hookOptions` | `Omit<UseSmartAuthOptions, "smartAuth">` | Options passed to `useSmartAuth` (e.g., `ehrLaunch`, `skip`, `onAuthenticated`, `startAuth`) |
| `header` | `Omit<AppHeaderProps, "authenticated" \| "onSignOut">` | Props for the `AppHeader` (title, icon, maxWidth, children) |
| `title` | `string` | Title on the unauthenticated landing screen |
| `description` | `string` | Description on the unauthenticated landing screen |
| `icon` | `LucideIcon` | Fallback icon when no branding logo is set |
| `maxWidth` | `string` | Tailwind max-width class (default: `"max-w-5xl"`) |
| `children` | `ReactNode` | Content rendered when authenticated |
| `wrapper` | `(children: ReactNode) => ReactNode` | Wrap the entire shell (e.g., `ModalStackProvider`, i18n provider) |
| `renderLoading` | `(state) => ReactNode` | Override loading/callback state |
| `renderError` | `(error, retry) => ReactNode` | Override error state |
| `renderUnauthenticated` | `(login) => ReactNode` | Override unauthenticated state |
| `renderSessionExpired` | `(error, login) => ReactNode` | Override session-expired state |

### Advanced Usage

**With wrapper (ModalStack, i18n):**

```tsx
<SmartAppShell
  smartAuth={smartAuth}
  header={{ title: "Consent Manager", icon: ShieldCheck, maxWidth: "max-w-4xl" }}
  title="Consent Manager"
  description="Manage consent settings."
  icon={ShieldCheck}
  maxWidth="max-w-4xl"
  wrapper={(children) => <ModalStackProvider>{children}</ModalStackProvider>}
>
  <Dashboard />
</SmartAppShell>
```

**With onAuthenticated callback:**

<!-- doccheck: skip — JSX usage sketch with an elided prop list -->
```tsx
const [launchMode, setLaunchMode] = useState<LaunchMode>("standalone")
const onAuthenticated = useCallback(() => setLaunchMode(smartAuth.getLaunchMode()), [])

<SmartAppShell
  smartAuth={smartAuth}
  hookOptions={{ onAuthenticated, startAuth: () => smartAuth.startStandaloneLaunch() }}
  header={{ title: "DTR", icon: FileCheck, children: <LaunchBadge mode={launchMode} /> }}
  ...
>
  <Dashboard launchMode={launchMode} />
</SmartAppShell>
```

## Exported Components

| Component | Description |
|-----------|-------------|
| `SmartAppShell` | Full auth state machine + layout shell |
| `AppHeader` | Top navigation bar with title, icon, sign-out |
| `Button` | Primary button with variants |
| `Card`, `CardHeader`, etc. | Card layout primitives |
| `Badge` | Status badges |
| `Input`, `Label`, `Select` | Form controls |
| `Tabs`, `ResponsiveTabsList` | Tab navigation |
| `Dialog` | Modal dialogs |
| `Table` | Data tables |
| `Spinner` | Loading indicator |
| `PageHeader` | Page title with breadcrumb |
| `FilterToolbar` | Filter bar for lists |
| `StatCard` | Dashboard statistic cards |
| `PatientBanner` | FHIR Patient context display |
| `Toaster` | Toast notifications (sonner) |
| `ErrorBoundary` | React error boundary |
| `ScrollArea` | Custom scrollbar |
| `Progress` | Progress bar |
| `Tooltip` | Hover tooltips |
| `DropdownMenu` | Context menus |
| `Separator` | Visual separator |

## Hooks

| Hook | Description |
|------|-------------|
| `useSmartAuth` | Full SMART auth state machine (loading → unauthenticated → callback → authenticated) |
| `useBranding` | Fetches organization branding (logo, colors) from the backend |
| `useModalLayer` / `useLayerZIndex` | Z-index management for stacked modals |

## Utilities

| Export | Description |
|--------|-------------|
| `cn()` | Tailwind class merging (clsx + tailwind-merge) |
| `createSmartAuth()` | Create a SmartAuth instance from config |
| `createSmartAppConfig()` | Build SMART app config from the app's own `import.meta.env` (passed as `env`) |
| `buildFhirBaseUrl()` | Construct the proxied FHIR base URL |
| `formatHumanName()` | Format FHIR HumanName to display string |
| `onAuthError()` / `reportAuthError()` | Auth error handling utilities |
| `createAuthFetch()` | Fetch wrapper that attaches Bearer token |
| `CHART_COLORS` | Consistent chart color palette |

## Tailwind Integration

Each app's `index.css` must include:

```css
@source "@proxy-smart/shared-ui/src";
@import "@proxy-smart/shared-ui/theme.css";
```

- `@source` tells Tailwind to scan shared-ui source for utility classes
- `@import` brings in the MaxHealth design system CSS variables (colors, radii, etc.)

The shared-ui `exports` field exposes `"./src/*": "./src/*"` specifically for this Tailwind scanning use case.

## Creating a New SMART App

1. Copy `frontend/smart-dicom-template` as a starting point
2. Update `package.json` (name, port)
3. Add `@proxy-smart/shared-ui` dependency
4. Set up `index.css` with `@source` and `@import`
5. Create `lib/smart-auth.ts` using `createSmartAuth()`
6. Use `SmartAppShell` in `App.tsx`
7. Register the app in Proxy Smart admin
