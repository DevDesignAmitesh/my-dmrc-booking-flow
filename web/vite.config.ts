import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The web app only ever talks to our BAP, never to ONDC/DMRC directly.
    proxy: { "/metro": "http://localhost:4000" },
  },
});
