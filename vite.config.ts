import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Проксировать API запросы на Vercel Functions
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
    watch: {
      ignored: ["**/ai_docs/**"],
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
});
