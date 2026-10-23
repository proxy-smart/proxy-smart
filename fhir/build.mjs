#!/usr/bin/env node
// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial
/**
 * Build the Consent IG into its typed package, locally and in publish-ig.yml alike, through
 * @max-health-inc/ig-tools. The output is lib/maxhealth.consent-<version>-generated.tgz; the backend
 * consumes the published @proxy-smart/consent-fhir, never this file.
 */
import { resolve } from "node:path";
import { compileIg, DEFAULT_GENERATOR_PACKAGE, resolveGenerator } from "@max-health-inc/ig-tools";

process.chdir(resolve(import.meta.dirname, ".."));

// @babelfhir-ts/*, the generator and the runtime packages alike, lives on GitHub Packages.
process.env["npm_config_@babelfhir-ts:registry"] ??= "https://npm.pkg.github.com";

const generator = process.env.BABELFHIR_VERSION || (await resolveGenerator({ log: (line) => console.log(line) })).version;

const { tarball } = compileIg({
  igDir: "fhir",
  packageDir: "fhir/fsh-generated/package",
  includeImplementationGuide: true,
  manifest: { fhirVersions: ["4.0.1"], type: "fhir.ig" },
  generator: { packageName: DEFAULT_GENERATOR_PACKAGE, version: generator },
  // --no-client: the backend reads types, validators and value sets; it never imports a FHIR client.
  generatorArgs: ["--fhir-version", "r4", "--no-client", "--skip-install"],
});

console.log(`\n✓ ${tarball} built with ${DEFAULT_GENERATOR_PACKAGE} ${generator}. Publish via publish-ig.yml.`);
