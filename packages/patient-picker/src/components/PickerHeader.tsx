// SPDX-FileCopyrightText: Max Health Inc.
// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Commercial

import { AppHeader, type AppHeaderProps } from "@proxy-smart/shared-ui"

/** Mid-launch header: no link may leave the page before the selection is submitted. */
export function PickerHeader({ title, icon }: Pick<AppHeaderProps, "title" | "icon">) {
  return <AppHeader title={title} icon={icon} authenticated={false} homeUrl={false} maxWidth="max-w-2xl" />
}
