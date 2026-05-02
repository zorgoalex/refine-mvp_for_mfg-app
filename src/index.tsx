import React from "react";
import ReactDOM from "react-dom/client";
import { initializeRuntimeConfig } from "./config/runtimeConfig";

async function bootstrap() {
  try {
    await initializeRuntimeConfig();
  } catch {
    // Runtime config is optional; build-time VITE_* values remain the fallback.
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
