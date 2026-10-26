// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import type { ReactNode } from "react"
import { Badge, Card, CardContent } from "@max-health-inc/shared-ui"
import type { LucideIcon } from "lucide-react"

/** One choosable resource in a picker list: icon, title, a line of facts, and the selected mark. */
export function SelectableRow({ icon: Icon, title, facts, isSelected, onSelect, testId, resourceId }: {
  icon: LucideIcon
  title: ReactNode
  facts: ReactNode
  isSelected: boolean
  onSelect: () => void
  testId: string
  resourceId: string | undefined
}) {
  return (
    <Card
      data-testid={testId}
      data-resource-id={resourceId}
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className={`cursor-pointer transition-colors hover:bg-accent/50 ${isSelected ? "border-primary bg-accent/30" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <CardContent className="flex items-center gap-3 py-3 px-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary shrink-0">
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{title}</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground mt-0.5">{facts}</div>
        </div>
        {isSelected && <Badge className="shrink-0">Selected</Badge>}
      </CardContent>
    </Card>
  )
}

export function Fact({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <Icon className="h-3 w-3" />
      {children}
    </span>
  )
}
