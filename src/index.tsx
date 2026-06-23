import React from "react";
import ReactDOM from "react-dom/client";
import { initializeRuntimeConfig } from "./config/runtimeConfig";
import { featureFlags } from "./config/featureFlags";
import { authSession } from "./api/authSession";
import { authStorage } from "./utils/auth";

async function bootstrap() {
  try {
    await initializeRuntimeConfig();
  } catch {
    // Runtime config is optional; build-time VITE_* values remain the fallback.
  }

  // Variant B bootstrap fix: when using the legacy (non-backend) auth path,
  // authSession is never populated on page reload (the user lives in localStorage
  // only). can() / canAny() read from authSession, so they always return false
  // after a page reload in legacy mode — the sheet picker would have no options.
  // Sync authSession from authStorage once at boot so permission checks work.
  if (!featureFlags.useBackendAuth) {
    const storedUser = authStorage.getUser();
    if (storedUser) {
      authSession.setUser(storedUser);
    }
  }

  const { default: App } = await import("./App");
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
