import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { TooltipProvider, ErrorBoundary, Toaster } from "@max-health-inc/shared-ui"
import App from "./App"

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <TooltipProvider>
          <App />
          <Toaster theme="system" />
        </TooltipProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}
