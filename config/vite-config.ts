// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

/**
 * Shared Vite configuration factory for SMART-on-FHIR apps.
 *
 * Usage in each app's vite.config.ts:
 * ```ts
 * import { createSmartViteConfig } from '../../config/vite-config'
 * export default createSmartViteConfig({ base: '/apps/my-app/', port: 5174 })
 * ```
 */
import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export interface SmartViteOptions {
  /** Base URL path, e.g. '/patient-picker/' */
  base: string
  /** Dev server port */
  port: number
  /** Extra Vite plugins to append */
  plugins?: UserConfig['plugins']
  /** Extra optimizeDeps config */
  optimizeDeps?: UserConfig['optimizeDeps']
  /** Extra worker config */
  worker?: UserConfig['worker']
}

export function createSmartViteConfig(
  opts: SmartViteOptions,
  /** Absolute directory of the consuming app (import.meta.dirname) */
  appDir: string,
) {
  return defineConfig(({ command, mode }) => {
    // In production builds, default VITE_PROXY_BASE to empty string (same-origin)
    // for apps co-hosted with the backend. Standalone deployments (e.g. Cloudflare Pages)
    // must set VITE_PROXY_BASE via their build environment — we don't override it then.
    const prodDefines = command === 'build' && mode === 'production' && !process.env.VITE_PROXY_BASE
      ? { 'import.meta.env.VITE_PROXY_BASE': JSON.stringify('') }
      : {}

    return {
      base: opts.base,
      plugins: [react(), tailwindcss(), ...(opts.plugins ?? [])],
      server: {
        port: opts.port,
      },
      resolve: {
        alias: {
          '@': path.resolve(appDir, './src'),
        },
      },
      define: prodDefines,
      ...(opts.optimizeDeps ? { optimizeDeps: opts.optimizeDeps } : {}),
      ...(opts.worker ? { worker: opts.worker } : {}),
      build: {
        sourcemap: false,
        reportCompressedSize: false,
      },
    }
  })
}
