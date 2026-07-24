import React from "react";
import ReactDOM from "react-dom/client";
import { getLoadedRuntimeConfig, initializeRuntimeConfig } from "./config/runtimeConfig";
import { setDocumentUiVariant } from "./ui-variant/uiVariant";
import {
  resolveInitialUiVariant,
  seedLegacyAuthSession,
} from "./ui-variant/uiVariantBootstrap";

async function bootstrap() {
  try {
    await initializeRuntimeConfig();
  } catch {
    // Runtime config is optional; build-time VITE_* values remain the fallback.
  }

  // Legacy auth persists user/token in localStorage while permission helpers
  // read authSession. Seed it even when UI evolution is unavailable.
  seedLegacyAuthSession();

  const uiVariant = await resolveInitialUiVariant(getLoadedRuntimeConfig()?.ui);
  setDocumentUiVariant(uiVariant);

  const { default: App } = await import("./App");
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <React.StrictMode>
      <App initialUiVariant={uiVariant} />
    </React.StrictMode>
  );
}

void bootstrap();
