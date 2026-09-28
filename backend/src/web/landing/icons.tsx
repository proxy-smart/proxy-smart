// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { FC } from 'hono/jsx'

const PATHS = {
  database: <><ellipse cx="12" cy="5.5" rx="7" ry="2.5" /><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13" /><path d="M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" /></>,
  window: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v5" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M16 7l3 3M18 5l2 2" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  shield: <><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>,
  lock: <><rect x="4" y="11" width="16" height="10" rx="1.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  filter: <path d="M4 5h16l-6 8v6l-4-2v-4z" />,
} as const

export type IconName = keyof typeof PATHS

export const Icon: FC<{ name: IconName }> = ({ name }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {PATHS[name]}
  </svg>
)
