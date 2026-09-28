/**
 * Backend ESLint config — extends shared base (Node.js).
 */
import { defineConfig } from 'eslint/config'
import { baseConfig } from '../config/eslint/base.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(
  ...baseConfig({
    tsconfigRootDir: __dirname,
    files: ['**/*.{js,ts,tsx}'],
    ignores: ['**/lib/api-client/**', 'public/**'],
  }),
)
