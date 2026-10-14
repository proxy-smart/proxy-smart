#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

console.log('Setting up git hooks for version management...');

try {
  // Make sure .githooks directory exists
  if (!fs.existsSync('.githooks')) {
    console.error('❌ .githooks directory not found');
    process.exit(1);
  }

  // Configure git to use our hooks directory
  execSync('git config core.hooksPath .githooks');
  
  // Make hooks executable (Unix/Mac)
  if (process.platform !== 'win32') {
    execSync('chmod +x .githooks/*');
  }
  
  console.log('✅ Git hooks configured successfully!');
  console.log('');
  console.log('Available version management commands:');
  console.log('  bun run version:sync        - Sync all package versions to root version');
  console.log('  bun run version:bump        - Bump patch version (0.0.1 → 0.0.2)');
  console.log('  bun run version:bump:minor  - Bump minor version (0.0.1 → 0.1.0)');
  console.log('  bun run version:bump:major  - Bump major version (0.0.1 → 1.0.0)');
  console.log('  bun run version:set 1.2.3   - Set specific version');
  console.log('');
  console.log('The pre-push hook syncs versions before a push to develop, test or main.');
  
} catch (error) {
  console.error('❌ Error setting up git hooks:', error.message);
  process.exit(1);
}
