// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'
import { KEYCLOAK_BENCHMARKS, PRODUCT } from './content'

type Flow = 'request' | 'data' | 'identity'
const FLOWS: readonly Flow[] = ['request', 'data', 'identity']

interface Box { x: number; y: number; w: number; h: number }

interface NodeProps extends Box {
  name: string
  sub?: string
  layout?: 'stack' | 'center' | 'row'
  accent?: boolean
}

const Node: FC<NodeProps> = ({ x, y, w, h, name, sub, layout = 'stack', accent }) => {
  const mid = y + h / 2
  const nameY = layout === 'row' ? mid + 4 : sub ? mid - 3 : mid + 5
  const subY = layout === 'row' ? mid + 4 : mid + 14
  const textX = layout === 'center' ? x + w / 2 : x + 16
  const anchor = layout === 'center' ? 'middle' : 'start'
  return (
    <g>
      <rect class={accent ? 'dg-node accent' : 'dg-node'} x={x} y={y} width={w} height={h} />
      <text class="dg-name" x={textX} y={nameY} text-anchor={anchor}>{name}</text>
      {sub ? (
        <text class="dg-sub" x={layout === 'row' ? x + w - 14 : textX} y={subY} text-anchor={layout === 'row' ? 'end' : anchor}>{sub}</text>
      ) : null}
    </g>
  )
}

const Markers: FC<{ id: string }> = ({ id }) => (
  <defs>
    {FLOWS.map(flow => (
      <marker id={`${id}-${flow}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
        <path class={`arrowhead ${flow}`} d="M0 0L8 4L0 8z" />
      </marker>
    ))}
  </defs>
)

const Edge: FC<{ id: string; flow: Flow; d: string; arrow?: boolean }> = ({ id, flow, d, arrow = true }) => (
  <path class={`flow ${flow}`} d={d} marker-end={arrow ? `url(#${id}-${flow})` : undefined} />
)

const Label: FC<{ x: number; y: number; text: string; anchor?: 'start' | 'middle' | 'end'; class?: string }> = props => (
  <text class={props.class ?? 'dg-label'} x={props.x} y={props.y} text-anchor={props.anchor ?? 'start'}>{props.text}</text>
)

export interface ArchitectureProps {
  fhirSummary: string
}

export const ArchitectureWide: FC<ArchitectureProps> = ({ fhirSummary }) => {
  const id = 'arch-w'
  const inner = (y: number, name: string, sub: string, accent = false) => (
    <Node x={266} y={y} w={228} h={44} name={name} sub={sub} layout="row" accent={accent} />
  )
  return (
    <svg class="diagram-wide" viewBox="0 0 760 424" role="img" aria-labelledby={`${id}-title ${id}-desc`}>
      <title id={`${id}-title`}>{PRODUCT.name} architecture</title>
      <desc id={`${id}-desc`}>
        The Admin UI, SMART apps and AI clients connect to {PRODUCT.name}, which runs a WebSocket channel, the FHIR proxy, OAuth
        endpoints and an MCP server. The FHIR proxy forwards requests to FHIR servers and a DICOMweb PACS, and every request is
        validated against Keycloak, which keeps users and configuration in PostgreSQL.
      </desc>
      <Markers id={id} />
      <Label x={20} y={80} text="CLIENTS" />
      <Node x={20} y={92} w={150} h={52} name="Admin UI" sub="DASHBOARD" />
      <Node x={20} y={176} w={150} h={52} name="SMART Apps" sub="PATIENT · PROVIDER" />
      <Node x={20} y={244} w={150} h={52} name="AI Clients" sub="AGENTS OVER MCP" />

      <rect class="dg-group" x={250} y={40} width={260} height={264} />
      <Label x={266} y={62} text="PROXY SMART" />
      <Label x={494} y={62} text="BUN · ELYSIA" anchor="end" class="dg-sub" />
      {inner(76, 'WebSocket', 'LIVE EVENTS')}
      {inner(132, 'FHIR Proxy', '/FHIR · /DICOMWEB', true)}
      {inner(188, 'OAuth Endpoints', 'SMART 2.2.0')}
      {inner(244, 'MCP Server', 'STREAMABLE HTTP')}

      <Label x={590} y={100} text="DATA SOURCES" />
      <Node x={590} y={112} w={150} h={52} name="FHIR Servers" sub={fhirSummary} />
      <Node x={590} y={180} w={150} h={52} name="PACS" sub="ORTHANC · DICOMWEB" />
      <Label x={590} y={256} text="PASS-THROUGH" class="dg-edge-label data" />
      <Label x={590} y={270} text="NO PHI STORED" class="dg-edge-label data dim" />

      <Label x={290} y={387} text="IDENTITY" anchor="end" />
      <Node x={305} y={356} w={150} h={52} name="Keycloak" sub="OAUTH · SSO" />
      <Node x={590} y={356} w={150} h={52} name="PostgreSQL" sub="USERS + CONFIG ONLY" />

      <Edge id={id} flow="request" d="M170 118 C 218 118, 218 98, 264 98" />
      <Edge id={id} flow="request" d="M170 118 C 218 118, 218 154, 264 154" />
      <Edge id={id} flow="request" d="M170 202 C 218 202, 218 154, 264 154" />
      <Edge id={id} flow="request" d="M170 202 C 218 202, 218 210, 264 210" />
      <Edge id={id} flow="request" d="M170 270 C 218 270, 218 266, 264 266" />
      <Edge id={id} flow="data" d="M494 154 C 540 154, 540 138, 588 138" />
      <Edge id={id} flow="data" d="M494 154 C 540 154, 540 206, 588 206" />
      <Edge id={id} flow="identity" d="M380 304 L 380 354" />
      <Label x={392} y={334} text="TOKEN CHECKS" class="dg-edge-label identity" />
      <Edge id={id} flow="identity" d="M455 382 L 588 382" />
    </svg>
  )
}

export const ArchitectureTall: FC<ArchitectureProps> = ({ fhirSummary }) => {
  const id = 'arch-t'
  return (
    <svg class="diagram-tall" viewBox="0 0 360 520" role="img" aria-labelledby={`${id}-title`}>
      <title id={`${id}-title`}>
        {PRODUCT.name} architecture: clients connect to the proxy, which forwards to FHIR servers and a PACS and validates identity
        with Keycloak and PostgreSQL.
      </title>
      <Markers id={id} />
      <Node x={10} y={16} w={106} h={44} name="Admin UI" layout="center" />
      <Node x={127} y={16} w={106} h={44} name="SMART Apps" layout="center" />
      <Node x={244} y={16} w={106} h={44} name="AI Clients" layout="center" />
      <Edge id={id} flow="request" d="M63 60 L 63 98" />
      <Edge id={id} flow="request" d="M180 60 L 180 98" />
      <Edge id={id} flow="request" d="M297 60 L 297 98" />

      <rect class="dg-group" x={20} y={100} width={320} height={200} />
      <Label x={36} y={122} text="PROXY SMART" />
      <Label x={324} y={122} text="BUN · ELYSIA" anchor="end" class="dg-sub" />
      <Node x={36} y={136} w={136} h={64} name="WebSocket" sub="LIVE EVENTS" layout="center" />
      <Node x={188} y={136} w={136} h={64} name="FHIR Proxy" sub="/FHIR · /DICOMWEB" layout="center" accent />
      <Node x={36} y={216} w={136} h={64} name="OAuth" sub="SMART 2.2.0" layout="center" />
      <Node x={188} y={216} w={136} h={64} name="MCP Server" sub="STREAMABLE HTTP" layout="center" />

      <Edge id={id} flow="data" d="M95 300 L 95 346" />
      <Edge id={id} flow="data" d="M20 290 L 8 290 L 8 446 L 18 446" />
      <Edge id={id} flow="identity" d="M265 300 L 265 346" />
      <Edge id={id} flow="identity" d="M265 400 L 265 418" />

      <Node x={20} y={348} w={150} h={52} name="FHIR Servers" sub={fhirSummary} layout="center" />
      <Node x={20} y={420} w={150} h={52} name="PACS" sub="ORTHANC · DICOMWEB" layout="center" />
      <Node x={190} y={348} w={150} h={52} name="Keycloak" sub="OAUTH · SSO" layout="center" />
      <Node x={190} y={420} w={150} h={52} name="PostgreSQL" sub="USERS + CONFIG ONLY" layout="center" />
      <Label x={95} y={500} text="DATA SOURCES" anchor="middle" />
      <Label x={265} y={500} text="IDENTITY" anchor="middle" />
    </svg>
  )
}

export const Topology: FC = () => {
  const { zones, podsPerZone, pod } = KEYCLOAK_BENCHMARKS.topology
  const zoneW = 140
  const gap = 10
  const width = zones * zoneW + (zones - 1) * gap + 40
  const centers = Array.from({ length: zones }, (_, i) => 20 + i * (zoneW + gap) + zoneW / 2)
  const podTotal = zones * podsPerZone
  return (
    <svg viewBox={`0 0 ${width} 300`} role="img" aria-labelledby="topo-title">
      <title id="topo-title">
        {podTotal} Keycloak pods across {zones} availability zones, each with {pod}, behind the stateless {PRODUCT.name} layer and
        backed by Aurora PostgreSQL multi-AZ.
      </title>
      <rect class="dg-group" x={20} y={14} width={width - 40} height={42} />
      <text class="dg-name" x={width / 2} y={40} text-anchor="middle">
        {PRODUCT.name} <tspan class="dg-sub" dx="6">STATELESS · HORIZONTAL</tspan>
      </text>
      {centers.map((cx, zone) => (
        <g>
          <path class="flow identity" d={`M${cx} 56 L ${cx} 76`} />
          <rect class="dg-zone" x={cx - zoneW / 2} y={78} width={zoneW} height={138} />
          <text class="dg-label" x={cx - zoneW / 2 + 12} y={96}>AZ {zone + 1}</text>
          {Array.from({ length: podsPerZone }, (_, p) => (
            <Node x={cx - 58} y={106 + p * 54} w={116} h={44} name="Keycloak" sub={pod} />
          ))}
          <path class="flow identity" d={`M${cx} 216 L ${cx} 240`} />
        </g>
      ))}
      <rect class="dg-node accent" x={20} y={242} width={width - 40} height={44} />
      <text class="dg-name" x={width / 2} y={269} text-anchor="middle">
        Aurora PostgreSQL <tspan class="dg-sub" dx="6">MULTI-AZ</tspan>
      </text>
    </svg>
  )
}
