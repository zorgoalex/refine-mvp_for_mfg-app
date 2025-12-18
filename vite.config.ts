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

          if (id.includes("@ant-design/icons")) return "antd-icons";
          if (id.includes("@rc-component") || id.includes("/rc-") || id.includes("\\rc-")) return "antd-rc";
          if (id.includes("@ant-design/cssinjs") || id.includes("@ant-design/colors")) return "antd-infra";
          if (id.includes("dayjs")) return "dayjs";
          if (id.includes("lodash")) return "lodash";
          if (id.includes("jszip")) return "jszip";

          if (id.includes("pdfjs-dist")) return "pdfjs";
          if (id.includes("xlsx")) return "xlsx";
          if (id.includes("exceljs")) return "exceljs";
          if (id.includes("react-dnd")) return "dnd";

          if (id.includes("@refinedev")) return "refine";
          if (id.includes("antd")) return "antd";
          if (id.includes("react") || id.includes("scheduler")) return "react-vendor";

          return "vendor";
        },
      },
    },
  },
});
