import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { VitePWA } from "vite-plugin-pwa"

/**
 * Tailwind is a Vite plugin in v4 rather than a PostCSS step, and there is no
 * `tailwind.config.js`: the theme is declared in CSS (`styles/theme.css`), which
 * is what lets §13.2's token layers stay the single source of truth instead of
 * being mirrored into a JavaScript config that can drift from them.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      /*
       * Prompt, never `autoUpdate`.
       *
       * `autoUpdate` swaps the application under the user and reloads. On a
       * wallet that can happen while somebody is halfway through entering an
       * amount, and the reload discards what they typed with no explanation —
       * a silent failure of exactly the kind this codebase has been removing.
       * The prompt is a bar they can ignore.
       */
      registerType: "prompt",
      includeAssets: ["apple-touch-icon.png"],

      manifest: {
        name: "Wallet",
        short_name: "Wallet",
        description: "Raqamli hamyon — balans, o'tkazmalar, kurslar",
        lang: "uz",
        dir: "ltr",
        start_url: "/",
        scope: "/",
        display: "standalone",
        /*
         * The background is the *light* page colour, not the brand blue: this
         * paints the splash screen, and a blue flash before a white app is a
         * flash. `theme_color` is the brand, because that one colours the
         * system bars where the brand belongs.
         */
        background_color: "#fcfcfd",
        theme_color: "#175cd3",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },

      workbox: {
        /*
         * The application shell, and nothing else.
         *
         * `/api` is deliberately absent from every caching rule here. A service
         * worker that answers a balance request from its own cache produces
         * exactly the failure this product spent F3 preventing: a real number,
         * rendered in the present tense, with nothing on screen admitting how
         * old it is. FR-8.2's offline reads go through IndexedDB instead,
         * where each value carries the moment it was fetched and the interface
         * says so.
         *
         * ADR-0009 already sets `Cache-Control: no-store` on the API for the
         * same reason; this is the client half of that decision.
         */
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        navigateFallback: "/index.html",
        // Anything under /api falls through to the network, always.
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },

      devOptions: {
        // Off in development: a service worker caching a dev server's modules
        // turns every edit into "why is my change not showing".
        enabled: false,
      },
    }),
  ],
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
