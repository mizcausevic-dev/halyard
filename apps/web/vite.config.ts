import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          const segment = id.split("node_modules/")[1] ?? "vendor";
          const name = segment.startsWith("@")
            ? segment.split("/").slice(0, 2).join("-")
            : segment.split("/")[0];
          return `pkg-${name.replace("@", "")}`;
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/hooks": "http://127.0.0.1:8787",
    },
  },
});
