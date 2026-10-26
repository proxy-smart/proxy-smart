import { useEffect, useState } from "react"
import { Button, Loader } from "@max-health-inc/shared-ui"
import { Stethoscope, HeartPulse, Users, type LucideIcon } from "lucide-react"
import { fetchIdentityOptions, type Identity } from "@/lib/api-client"

/** Labelled by ROLE, never by name: every option is the same person. */
const ROLES: Record<string, { title: string; blurb: string; icon: LucideIcon }> = {
  Patient: {
    title: "Your own health record",
    blurb: "The app sees you as a patient, and acts on your record.",
    icon: HeartPulse,
  },
  Practitioner: {
    title: "Your clinician account",
    blurb: "The app sees you as a practitioner, and acts on the records you care for.",
    icon: Stethoscope,
  },
  RelatedPerson: {
    title: "Someone you care for",
    blurb: "The app sees you acting on behalf of a person you are related to.",
    icon: Users,
  },
}

export function IdentityList({ onSelect, selected }: {
  onSelect: (identity: Identity) => void
  selected: Identity | null
}) {
  const [identities, setIdentities] = useState<Identity[] | null>(null)

  useEffect(() => {
    let active = true
    fetchIdentityOptions()
      .then((list) => { if (active) setIdentities(list) })
      .catch(() => { if (active) setIdentities([]) })
    return () => { active = false }
  }, [])

  if (identities === null) return <Loader />

  if (identities.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This sign-in offered no identities to choose from. Start the launch again.
      </p>
    )
  }

  return (
    <ul className="flex flex-col gap-3">
      {identities.map((identity) => {
        const role = ROLES[identity.resourceType]
        const Icon = role?.icon ?? Users
        const isSelected = selected?.reference === identity.reference
        return (
          <li key={identity.reference}>
            <Button
              type="button"
              variant={isSelected ? "default" : "outline"}
              className="w-full h-auto justify-start gap-3 p-4 text-left"
              onClick={() => onSelect(identity)}
              data-testid={`identity-option-${identity.resourceType}`}
            >
              <Icon className="h-5 w-5 shrink-0" />
              <span className="min-w-0">
                <span className="block font-medium">{role?.title ?? identity.resourceType}</span>
                <span className="block text-xs opacity-80">{role?.blurb ?? identity.reference}</span>
              </span>
            </Button>
          </li>
        )
      })}
    </ul>
  )
}
