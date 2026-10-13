#!/usr/bin/env node
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directories to skip entirely during recursive search
const SKIP_DIRS = ['node_modules', 'dist', 'build', '.git', '.cache', 'cache'];

/**
 * A manifest opts out of lockstep with `"versionPolicy": "independent"`.
 *
 * Lockstep is correct for anything whose contract IS the backend's: api-client and
 * the CLI are both generated from backend/dist/openapi.json, so api-client@X is by
 * definition the client for backend@X, and syncing them says something true.
 *
 * It is wrong for the libraries the backend imports — auth, app-store, site-kit.
 * Their API is their own, and moving them because the backend was reshaped tells a
 * consumer nothing while burning a version. They declare the policy themselves
 * rather than being listed here, so there is no central list to go stale.
 */
const INDEPENDENT = 'independent';

// Recursively find all package.json files using built-in modules
function findPackageFiles(dir = process.cwd(), found = [], depth = 0) {
  try {
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (SKIP_DIRS.includes(item) || item.startsWith('.')) continue;
        findPackageFiles(fullPath, found, depth + 1);
      } else if (item === 'package.json') {
        // Convert to relative path from process.cwd()
        const relativePath = path.relative(process.cwd(), fullPath);
        found.push(relativePath || 'package.json');
      }
    }
    
    return found;
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dir}:`, error.message);
    return found;
  }
}

// Dynamically find all package.json files
function getPackagePaths() {
  const allPackages = findPackageFiles();

  // Ensure root package.json is first
  const rootIndex = allPackages.indexOf('package.json');
  if (rootIndex > 0) {
    allPackages.splice(rootIndex, 1);
    allPackages.unshift('package.json');
  }

  return allPackages;
}

/** Git reports POSIX paths; path.relative gives backslashes on Windows. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Write every package.json to `newVersion` and return the paths actually changed.
 *
 * ONLY writes a file whose bytes would differ. It used to write unconditionally,
 * which re-serialised each manifest on every run — and since JSON.stringify does
 * not reproduce the original formatting byte-for-byte, a sync that changed no
 * version at all still left the whole tree dirty. The pre-push hook then "fixed"
 * that with `git checkout -- .`, discarding whatever else was uncommitted. Writing
 * only real changes removes the need for any such cleanup.
 *
 * @param {boolean} quiet  Suppress progress logging (for --porcelain callers).
 * @param {boolean} dryRun Report what would change without writing anything, so a
 *   caller can decide whether the write is safe before the tree is mutated.
 * @returns {string[]} POSIX-style relative paths that were (or would be) rewritten.
 */
function updateVersion(newVersion, quiet = false, dryRun = false) {
  const log = quiet ? () => {} : console.log;
  log(`Updating all packages to version: ${newVersion}`);

  const packagePaths = getPackagePaths();
  log(`Found ${packagePaths.length} package.json files:`);
  packagePaths.forEach(p => log(`  - ${p}`));
  log('');

  const changed = [];

  packagePaths.forEach(packagePath => {
    if (!fs.existsSync(packagePath)) {
      console.warn(`⚠ Warning: ${packagePath} not found`);
      return;
    }

    const raw = fs.readFileSync(packagePath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const packageContent = JSON.parse(raw);
    if (packageContent.versionPolicy === INDEPENDENT) {
      log(`~ Independent ${packagePath} (${packageContent.version})`);
      return;
    }
    if (packageContent.version === newVersion) {
      log(`= Unchanged ${packagePath}`);
      return;
    }

    packageContent.version = newVersion;
    const output = JSON.stringify(packageContent, null, 2).replace(/\n/g, eol) + eol;
    if (output === raw) {
      log(`= Unchanged ${packagePath}`);
      return;
    }

    if (!dryRun) fs.writeFileSync(packagePath, output);
    changed.push(toPosix(packagePath));
    log(`${dryRun ? '~ Would update' : '✓ Updated'} ${packagePath}`);
  });

  return changed;
}

function getCurrentVersion() {
  const rootPackage = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  return rootPackage.version;
}

function incrementVersion(version, type = 'patch') {
  // Remove any pre-release suffixes to get base version
  const baseVersion = version.replace(/-.*$/, '');
  const [major, minor, patch] = baseVersion.split('.').map(Number);
  
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

function getBaseVersion(version) {
  // Remove any pre-release suffixes (alpha, beta, etc.)
  return version.replace(/-.*$/, '');
}

function checkConsistency() {
  const rootVersion = getCurrentVersion();
  const packagePaths = getPackagePaths();
  let isConsistent = true;
  
  console.log(`Checking version consistency (root: ${rootVersion})`);
  
  packagePaths.slice(1).forEach(packagePath => {
    if (fs.existsSync(packagePath)) {
      const packageContent = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      if (packageContent.versionPolicy === INDEPENDENT) {
        console.log(`~ ${packagePath}: ${packageContent.version} (independent)`);
        return;
      }
      if (packageContent.version !== rootVersion) {
        console.log(`❌ ${packagePath}: ${packageContent.version} (expected: ${rootVersion})`);
        isConsistent = false;
      } else {
        console.log(`✓ ${packagePath}: ${packageContent.version}`);
      }
    }
  });
  
  return isConsistent;
}

// CLI usage
const args = process.argv.slice(2);
const command = args[0];

if (command === 'sync') {
  // Sync all packages to root version.
  //
  // --porcelain prints ONLY the paths that were rewritten, one per line, so a
  // caller (the pre-push hook) can stage exactly those files instead of reaching
  // for `git add -u` and sweeping up unrelated work.
  //
  // --dry-run reports the same list without writing, so the hook can refuse an
  // unsafe sync BEFORE the tree has been touched.
  const porcelain = args.includes('--porcelain');
  const dryRun = args.includes('--dry-run');
  const rootVersion = getCurrentVersion();
  const changed = updateVersion(rootVersion, porcelain, dryRun);
  if (porcelain) {
    changed.forEach(p => console.log(p));
  }
} else if (command === 'bump') {
  // Bump version (patch by default)
  const type = args[1] || 'patch';
  const currentVersion = getCurrentVersion();
  const newVersion = incrementVersion(currentVersion, type);
  updateVersion(newVersion);
} else if (command === 'set') {
  // Set specific version
  const newVersion = args[1];
  if (!newVersion) {
    console.error('Please provide a version number');
    process.exit(1);
  }
  updateVersion(newVersion);
} else if (command === 'check') {
  // Check version consistency
  const isConsistent = checkConsistency();
  if (!isConsistent) {
    console.log('\n❌ Version inconsistency detected. Run "node scripts/version.js sync" to fix.');
    process.exit(1);
  } else {
    console.log('\n✅ All versions are consistent!');
  }
} else if (command === 'base') {
  // Get base version (without pre-release suffixes)
  const currentVersion = getCurrentVersion();
  const baseVersion = getBaseVersion(currentVersion);
  console.log(baseVersion);
} else {
  console.log('Usage:');
  console.log('  node scripts/version.js sync [--porcelain] [--dry-run]');
  console.log('                                              - Sync all packages to root version');
  console.log('                                                --porcelain: print only changed paths');
  console.log('                                                --dry-run:   report without writing');
  console.log('  node scripts/version.js bump [major|minor|patch] - Bump version (default: patch)');
  console.log('  node scripts/version.js set <version>       - Set specific version');
  console.log('  node scripts/version.js check               - Check version consistency');
  console.log('  node scripts/version.js base                - Get base version (no pre-release suffixes)');
}
