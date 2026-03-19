import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/sessions": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/artifacts": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/progress": { target: "http://127.0.0.1:8787", ws: false }
    }
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["tests/**"]
  }
});
