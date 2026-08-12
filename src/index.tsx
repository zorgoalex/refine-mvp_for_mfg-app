import React from "react";
import ReactDOM from "react-dom/client";
import { getLoadedRuntimeConfig, initializeRuntimeConfig } from "./config/runtimeConfig";
import { setDocumentUiVariant } from "./ui-variant/uiVariant";
import {
  resolveInitialUiVariant,
  seedLegacyAuthSession,
} from "./ui-variant/uiVariantBootstrap";
import { reloadPageOnceForStaleChunk } from "./utils/staleChunkReload";

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

  let App: typeof import("./App").default;
  try {
    ({ default: App } = await import("./App"));
  } catch (error) {
    if (reloadPageOnceForStaleChunk(error)) {
      return;
    }
    throw error;
  }

  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  root.render(
    <React.StrictMode>
      <App initialUiVariant={uiVariant} />
    </React.StrictMode>
  );
}

void bootstrap();
