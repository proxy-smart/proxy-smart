#!/usr/bin/env node
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { readFileSync } from 'node:fs';

const POSTURE_FIELDS = {
  CONSENT_MODE: 'consent',
  SCOPE_ENFORCEMENT_MODE: 'scopeEnforcement',
  ROLE_BASED_FILTERING_MODE: 'roleBasedFiltering',
  FHIR_AUDIENCE_ENFORCEMENT: 'fhirAudience',
  TENANT_ISOLATION_MODE: 'tenantIsolation',
};

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const template = readJson('proxy-smart.guido.json');
const posture = readJson('backend/src/lib/access-posture.json');

const problems = Object.entries(POSTURE_FIELDS).flatMap(([name, key]) => {
  const field = template.fields.find((f) => f.name === name);
  if (!field) return [`${name} is missing from proxy-smart.guido.json`];
  if (!(key in posture)) return [`${key} is missing from access-posture.json`];
  return field.value === posture[key] ? [] : [`${name} defaults to ${field.value} in proxy-smart.guido.json but ${posture[key]} in access-posture.json`];
});

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
console.log(`✅ ${Object.keys(POSTURE_FIELDS).length} access posture defaults match access-posture.json`);
