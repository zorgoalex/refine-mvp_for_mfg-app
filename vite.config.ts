import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendApiTarget = env.VITE_API_URL || env.VITE_BACKEND_URL || "http://localhost:3000";
  const legacyApiTarget = env.VITE_LEGACY_API_URL || "http://localhost:3001";

  return {
    plugins: [react()],
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
