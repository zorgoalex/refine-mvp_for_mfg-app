import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

const FRONTEND_PUBLIC_ENV_KEYS = [
  "VITE_API_URL",
  "VITE_BITRIX24_LABEL",
  "VITE_BITRIX24_URL",
  "VITE_CURRENCY_CODE",
  "VITE_CURRENCY_NAME",
  "VITE_CURRENCY_SYMBOL",
  "VITE_ENABLE_LEGACY_HASURA",
  "VITE_HASURA_GRAPHQL_URL",
  "VITE_ORDER_REALTIME",
  "VITE_ORDER_STATUS_BOARD",
  "VITE_PDF_IMPORT_LAYOUT_PATTERNS",
  "VITE_RUNTIME_CONFIG_URL",
  "VITE_SHEET_MATERIALS_READS",
  "VITE_STATUS_AUTOMATION",
  "VITE_UI_EVOLUTION",
  "VITE_USE_BACKEND_AUTH",
  "VITE_USE_BACKEND_BAZIS",
  "VITE_USE_BACKEND_BAZIS_CUT",
  "VITE_USE_BACKEND_CLIENT_PHONES",
  "VITE_USE_BACKEND_CNC_TELEGRAM",
  "VITE_USE_BACKEND_CUT",
  "VITE_USE_BACKEND_DEADLINES",
  "VITE_USE_BACKEND_GROUPS",
  "VITE_USE_BACKEND_LABELS",
  "VITE_USE_BACKEND_ORDERS",
  "VITE_USE_BACKEND_ORDERS_READ",
  "VITE_USE_BACKEND_ORDERS_WRITE",
  "VITE_USE_BACKEND_ORDER_EXPORT",
  "VITE_USE_BACKEND_PAYMENTS",
  "VITE_USE_BACKEND_PERMISSIONS",
  "VITE_USE_BACKEND_PRODUCTION_ACTIONS",
  "VITE_USE_BACKEND_REFERENCES",
  "VITE_USE_BACKEND_USERS",
  "VITE_USE_BACKEND_VLM",
  "VITE_USE_PROJECTS",
  "VITE_WORKOS_AUTH",
] as const;

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendApiTarget = env.VITE_API_URL || env.VITE_BACKEND_URL || "http://localhost:3000";
  const legacyApiTarget = env.VITE_LEGACY_API_URL || "http://localhost:3001";
  const publicEnv = Object.fromEntries(
    FRONTEND_PUBLIC_ENV_KEYS.flatMap((key) => env[key] === undefined ? [] : [[key, env[key]]]),
  );

  return {
    plugins: [react()],
    // VITE_* is not a security boundary. Disable Vite's broad automatic exposure
    // and inject only explicitly approved browser-safe values.
    envPrefix: "ERP_PUBLIC_",
    define: {
      "import.meta.env": JSON.stringify({
        BASE_URL: "/",
        MODE: mode,
        DEV: mode !== "production",
        PROD: mode === "production",
        SSR: false,
        ...publicEnv,
      }),
    },
    worker: {
      format: "es",
    },
    resolve: {
      alias: {
        // Shared pure-TS geometry/validation module (no FE/BE deps).
        // Lives under backend/src/shared so the backend Docker build context
        // (backend/ only) includes it. Task 9 imports:
        //   import { ... } from '@shared/cut-geometry'
        "@shared": resolve(__dirname, "backend/src/shared"),
      },
    },
    server: {
      fs: {
        // backend/src is already under the Vite root (repo root); this keeps
        // the dev server allowed to serve the shared module from there.
        allow: [resolve(__dirname)],
      },
      port: 5173,
      proxy: {
        // New backend endpoints are versioned and served by NestJS.
        "/api/v1": {
          target: backendApiTarget,
          changeOrigin: true,
        },
        "/health": {
          target: backendApiTarget,
          changeOrigin: true,
        },
        // Runtime frontend flags are served by Vercel dev/prod, not baked into the Vite bundle.
        "/runtime-config.json": {
          target: legacyApiTarget,
          changeOrigin: true,
        },
        // Legacy Vercel endpoints stay available while non-cutover flows use feature flags.
        "/api": {
          target: legacyApiTarget,
          changeOrigin: true,
        },
      },
      watch: {
        ignored: ["**/ai_docs/**", "**/.worktrees/**"],
      },
    },
    build: {
      chunkSizeWarningLimit: 1100,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return;

            const [, nodeModulesPath] = id.split("node_modules/");
            if (!nodeModulesPath) return;

            const parts = nodeModulesPath.split(/[\\/]/g);
            const pkg = parts[0]?.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
            if (!pkg) return;

            // Keep manual chunking minimal and safe; aggressive splitting can create chunk cycles
            // and runtime errors in production deployments (e.g. React exports becoming undefined).
            if (pkg === "pdfjs-dist") return "pdfjs";
            if (pkg === "xlsx") return "xlsx";
            if (pkg === "exceljs") return "exceljs";

            // Let Rollup decide the rest for correct execution order.
            return;
          },
        },
      },
    },
  };
});
