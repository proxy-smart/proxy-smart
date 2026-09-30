// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { useState, useMemo, useEffect } from "react"
import { getPickerParams, getPickerError, isIdentityMode } from "@/lib/picker-params"
import { submitPatientSelection, submitIdentitySelection, fetchBrandContext } from "@/lib/api-client"
import { PatientList } from "@/components/PatientList"
import { IdentityList } from "@/components/IdentityList"
import { formatHumanName, Button, onAuthError, useScene } from "@proxy-smart/shared-ui"
import { PickerHeader } from "@/components/PickerHeader"
import { UserSearch, TriangleAlert, CircleCheck, LogIn, CircleUser } from "lucide-react"
import type { Patient, Identity } from "@/lib/api-client"
import "./index.css"

export default function App() {
  useScene({ defaultScene: "perspective-grid" })
  const params = useMemo(() => getPickerParams(), [])
  const pickerError = useMemo(() => getPickerError(), [])
  const identityMode = useMemo(() => isIdentityMode(), [])
  const [selected, setSelected] = useState<Patient | null>(null)
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  // Subscribe to shared-ui's centralized auth-error bus
  useEffect(() => {
    onAuthError((message) => {
      setAuthError(message)
      setTimeout(() => { window.location.href = window.location.origin }, 4000)
    })
  }, [])

  // Theme the picker to the launching org's brand colour for this launch only.
  // --maxhealth is the deprecated alias of --main; set both so either follows.
  useEffect(() => {
    fetchBrandContext().then((brand) => {
      if (!brand?.primaryColor) return
      const root = document.documentElement
      for (const token of ["--primary", "--main", "--maxhealth"]) {
        root.style.setProperty(token, brand.primaryColor)
      }
    })
  }, [])

  // ── Error from URL params (backend redirected here with ?error=...) ────
  if (pickerError) {
    const isSessionExpired = pickerError.error === "session_expired"
    return (
      <ErrorScreen
        title={isSessionExpired ? "Session Expired" : "Request Error"}
        message={pickerError.errorDescription}
        variant={isSessionExpired ? "warning" : "destructive"}
      />
    )
  }

  // ── Auth error caught by shared-ui bus (API returned session_expired) ──
  if (authError) {
    return (
      <ErrorScreen
        title="Session Expired"
        message={authError}
        variant="warning"
        showRedirectHint
      />
    )
  }

  // ── Missing URL params (direct navigation without SMART flow) ──────────
  if (!params) {
    return (
      <ErrorScreen
        title="Invalid Request"
        message="Missing session, code, or aud parameter. This page should only be accessed during a SMART authorization flow."
        variant="destructive"
        showReturnButton={false}
      />
    )
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    try {
      const redirectUrl = identityMode
        ? await submitIdentitySelection(params.session, params.code, identity?.reference ?? "")
        : await submitPatientSelection(params.session, params.code, selected?.id ?? "")
      window.location.href = redirectUrl
    } catch {
      // Error already reported via reportAuthError → onAuthError bus
      setSubmitting(false)
    }
  }

  if (identityMode) {
    return (
      <div className="min-h-screen bg-background">
        <PickerHeader title="Continue as" icon={CircleUser} />

        <main className="max-w-2xl mx-auto px-4 py-6">
          <div className="mb-6">
            <p className="text-muted-foreground text-sm">
              You are both a patient and a clinician here. Choose which of your records this
              application should be given access to.
            </p>
          </div>

          <IdentityList onSelect={setIdentity} selected={identity} />

          {identity && (
            <Button
              data-testid="identity-picker-submit"
              size="lg"
              className="w-full mt-6"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Continuing..." : "Continue"}
            </Button>
          )}
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <PickerHeader title="Select Patient" icon={UserSearch} />

      <main className="max-w-2xl mx-auto px-4 py-6">
        <div className="mb-6">
          <p className="text-muted-foreground text-sm">
            This application is requesting patient context. Search and select the patient whose data you want to access.
          </p>
        </div>

        <PatientList onSelect={setSelected} selected={selected} />

        {selected && (
          <div className="mt-6 flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-accent/30 rounded-lg p-3">
              <CircleCheck className="h-4 w-4 text-primary shrink-0" />
              <span>
                Selected: <strong className="text-foreground">{formatHumanName(selected.name)}</strong>
                {" "}({selected.id})
              </span>
            </div>
            <Button
              data-testid="patient-picker-submit"
              size="lg"
              className="w-full"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Continuing..." : "Continue with selected patient"}
            </Button>
          </div>
        )}
      </main>
    </div>
  )
}

// ── Reusable Error Screen ───────────────────────────────────────────────────

function ErrorScreen({ title, message, variant, showReturnButton = true, showRedirectHint = false }: {
  title: string
  message: string
  variant: "warning" | "destructive"
  showReturnButton?: boolean
  showRedirectHint?: boolean
}) {
  return (
    <div className="min-h-screen bg-background">
      <PickerHeader title={title} icon={UserSearch} />
      <main className="max-w-2xl mx-auto px-4 py-12">
        <div className="flex flex-col items-center gap-4 text-center">
          <TriangleAlert className={`h-12 w-12 text-${variant}`} />
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-muted-foreground">{message}</p>
          {showReturnButton && (
            <Button variant="default" size="lg" onClick={() => { window.location.href = window.location.origin }} className="mt-2">
              <LogIn className="h-4 w-4 mr-2" />
              Return to Login
            </Button>
          )}
          {showRedirectHint && (
            <p className="text-xs text-muted-foreground">Redirecting automatically...</p>
          )}
        </div>
      </main>
    </div>
  )
}
