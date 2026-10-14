// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { useCallback, useEffect, useState } from "react"
import { Badge, Button, EmptyState, Loader, ScrollArea, formatDateTime } from "@proxy-smart/shared-ui"
import { CalendarClock, CalendarX, Building2, Hash, RotateCw, Stethoscope } from "lucide-react"
import { listEncounters, type Encounter } from "@/lib/api-client"
import { SelectableRow, Fact } from "@/components/SelectableRow"

export type EncounterLoad =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; encounters: Encounter[] }

export function EncounterList({ selected, onSelect, onLoad }: {
  selected: Encounter | null
  onSelect: (encounter: Encounter) => void
  onLoad: (load: EncounterLoad) => void
}) {
  const [load, setLoad] = useState<EncounterLoad>({ state: "loading" })

  const fetchEncounters = useCallback(async () => {
    const report = (next: EncounterLoad) => {
      setLoad(next)
      onLoad(next)
    }
    report({ state: "loading" })
    try {
      report({ state: "loaded", encounters: await listEncounters() })
    } catch (err) {
      report({ state: "failed", message: err instanceof Error ? err.message : "Unknown error" })
    }
  }, [onLoad])

  useEffect(() => {
    void fetchEncounters()
  }, [fetchEncounters])

  if (load.state === "loading") return <Loader />

  if (load.state === "failed") {
    return (
      <EmptyState
        icon={<CalendarX className="h-10 w-10" />}
        message="The encounters could not be loaded."
        description={load.message}
        action={
          <Button variant="outline" onClick={() => void fetchEncounters()}>
            <RotateCw className="h-4 w-4 mr-2" />
            Try again
          </Button>
        }
      />
    )
  }

  if (load.encounters.length === 0) {
    return (
      <EmptyState
        data-testid="encounter-list-empty"
        icon={<CalendarX className="h-10 w-10" />}
        message="This patient has no encounters on record."
        description="The application can continue without an encounter in context."
      />
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {load.encounters.length === 1 ? "1 encounter" : `${load.encounters.length} encounters`}, most recent first
      </p>
      <ScrollArea className="max-h-[420px]">
        <div className="space-y-2 pr-1">
          {load.encounters.map((encounter) => (
            <EncounterRow
              key={encounter.id}
              encounter={encounter}
              isSelected={!!encounter.id && selected?.id === encounter.id}
              onSelect={onSelect}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function encounterTitle(encounter: Encounter): string {
  const type = encounter.type?.[0]
  return type?.text
    ?? type?.coding?.find((coding) => coding.display)?.display
    ?? encounter.serviceType?.text
    ?? encounter.class?.display
    ?? encounter.class?.code
    ?? "Encounter"
}

function encounterPeriod(encounter: Encounter): string | null {
  const start = formatDateTime(encounter.period?.start)
  const end = formatDateTime(encounter.period?.end)
  if (start && end) return `${start} to ${end}`
  if (start) return `Since ${start}`
  return end || null
}

function EncounterRow({ encounter, isSelected, onSelect }: {
  encounter: Encounter
  isSelected: boolean
  onSelect: (encounter: Encounter) => void
}) {
  const period = encounterPeriod(encounter)
  const place = encounter.location?.[0]?.location.display ?? encounter.serviceProvider?.display
  const kind = encounter.class?.display ?? encounter.class?.code

  return (
    <SelectableRow
      testId="encounter-row"
      resourceId={encounter.id}
      icon={Stethoscope}
      title={encounterTitle(encounter)}
      isSelected={isSelected}
      onSelect={() => onSelect(encounter)}
      facts={
        <>
          {period && <Fact icon={CalendarClock}>{period}</Fact>}
          {place && <Fact icon={Building2}>{place}</Fact>}
          {!period && !place && <Fact icon={Hash}>{encounter.id}</Fact>}
          <Badge variant="outline" className="text-xs px-1.5 py-0">{encounter.status}</Badge>
          {kind && <Badge variant="outline" className="text-xs px-1.5 py-0">{kind}</Badge>}
        </>
      }
    />
  )
}
