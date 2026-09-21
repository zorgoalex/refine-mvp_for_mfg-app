import React from "react";
import { installWorkspaceStateLifecycle } from "./workspace/workspaceStateLifecycle";
import ReactDOM from "react-dom/client";
import { getLoadedRuntimeConfig, initializeRuntimeConfig } from "./config/runtimeConfig";
import { setDocumentUiVariant } from "./ui-variant/uiVariant";
import {
  resolveInitialUiVariant,
  seedLegacyAuthSession,
} from "./ui-variant/uiVariantBootstrap";
import {
  handleVitePreloadError,
  reloadPageOnceForStaleChunk,
  type VitePreloadErrorEvent,
} from "./utils/staleChunkReload";
import { resolveOrderLifecycleCohort } from "./performance/orderLifecycleCohortStore";

window.addEventListener('vite:preloadError', (event) => {
  handleVitePreloadError(event as VitePreloadErrorEvent);
});

async function bootstrap() {
  try {
    await initializeRuntimeConfig();
  } catch {
    // Runtime config is optional; build-time VITE_* values remain the fallback.
  }

  // Legacy auth persists user/token in localStorage while permission helpers
  // read authSession. Seed it even when UI evolution is unavailable.
  // Install before any identity publication, independently of UI variant/device
  // bootstrap timing, so F5 can recover only the confirmed owner's drafts.
  installWorkspaceStateLifecycle();
  seedLegacyAuthSession();
  // Resolve the versioned lifecycle cohort before route rendering. Treatment
  // routes can then start their primary query before React invokes React.lazy;
  // control routes render with their historical page-owned request path.
  const orderLifecycleCohort = await resolveOrderLifecycleCohort();

  // Start treatment order reads before downloading and parsing the large App chunk.
  const initialPathname = window.location.pathname;
  if (
    orderLifecycleCohort === 'treatment'
    && /^\/orders(?:\/?$|\/(?:show|edit)\/)/.test(initialPathname)
  ) {
    const initialSearch = window.location.search;
    const navigationStartedAt = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
    try {
      const { startInitialOrderPrimaryBootstrap } = await import('./query/orderPrimaryBootstrap');
      void startInitialOrderPrimaryBootstrap({
        pathname: initialPathname,
        search: initialSearch,
        navigationStartedAt,
      })?.catch(() => undefined);
    } catch {
      // App remains the retry owner when optional early bootstrap cannot start.
    }
  }

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
