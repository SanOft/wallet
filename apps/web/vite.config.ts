import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Tailwind is a Vite plugin in v4 rather than a PostCSS step, and there is no
 * `tailwind.config.js`: the theme is declared in CSS (`styles/theme.css`), which
 * is what lets §13.2's token layers stay the single source of truth instead of
 * being mirrored into a JavaScript config that can drift from them.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    /**
     * The API is reached at `/api` on this same origin, in development as in
     * production (ADR-0009). Proxying here rather than pointing the client at
     * `http://localhost:3000` keeps the refresh cookie same-site in both
     * environments — the difference between them is what made the production
     * cookie failure invisible in the first place.
     */
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
})
