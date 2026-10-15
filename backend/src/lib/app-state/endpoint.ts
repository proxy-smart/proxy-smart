// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { getSmartSecurityServiceVSConcept } from '@proxy-smart/consent-fhir/valuesets/ValueSet-SmartSecurityServiceVS'
import { config } from '../../config'
import type { AppStateFhirServer } from './context'

export const APP_STATE_CAPABILITY = 'smart-app-state'
export const APP_STATE_PATH = '/app-state'

const SMART_APP_STATE_SERVER = 'http://hl7.org/fhir/smart-app-launch/CapabilityStatement/smart-app-state-server'
const SMART_APP_STATE_PROFILE = 'http://hl7.org/fhir/smart-app-launch/StructureDefinition/smart-app-state-basic'

export function appStateEndpointUrl(): string {
  return `${config.baseUrl}${APP_STATE_PATH}`
}

// Imported on first use, so the discovery documents that link this endpoint do not load the server registry.
export async function appStateFhirServers(): Promise<AppStateFhirServer[]> {
  const { fhirResourceUrlFor, getAllServers } = await import('../fhir-server-store')
  return (await getAllServers()).map((server) => ({ base: fhirResourceUrlFor(server), upstream: server.url }))
}

export function appStateAssociatedEndpoint(): { url: string; capabilities: string[] } {
  return { url: appStateEndpointUrl(), capabilities: [APP_STATE_CAPABILITY] }
}

export function appStateCapabilityStatement(endpointUrl: string, limits: { maxResourceBytes: number; maxPerSubject: number }) {
  return {
    resourceType: 'CapabilityStatement',
    status: 'active',
    date: new Date().toISOString(),
    kind: 'instance',
    instantiates: [SMART_APP_STATE_SERVER],
    software: { name: config.displayName, version: config.version },
    implementation: { description: 'SMART App State endpoint', url: endpointUrl },
    fhirVersion: '4.0.1',
    format: ['json'],
    rest: [{
      mode: 'server',
      documentation: `Resources up to ${limits.maxResourceBytes} bytes; at most ${limits.maxPerSubject} per state code and subject.`,
      security: {
        service: [{ coding: [{ ...getSmartSecurityServiceVSConcept('SMART-on-FHIR') }] }],
      },
      resource: [{
        type: 'Basic',
        supportedProfile: [SMART_APP_STATE_PROFILE],
        interaction: [{ code: 'search-type' }, { code: 'create' }, { code: 'update' }, { code: 'delete' }],
        versioning: 'versioned-update',
        updateCreate: false,
        conditionalCreate: false,
        conditionalUpdate: false,
        conditionalDelete: 'not-supported',
        searchParam: [
          { name: 'code', type: 'token', documentation: 'Exact system|code of Basic.code.coding[0]' },
          { name: 'subject', type: 'reference', documentation: 'Absolute reference; subject:missing=true finds global state' },
        ],
      }],
    }],
  }
}
