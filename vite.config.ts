import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;
/** The project folder with forward slashes, for watch patterns. */
const ROOT = __dirname.replace(/\\/g, "/");
const DEV_PORT = 14410;
const HMR_PORT = 14411;
const PREVIEW_PORT = 14412;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: HMR_PORT } : undefined,
    /**
     * Saved documents, exported images and Markdown docs in the project
     * folder must not reload the dev app (Tailwind also skips what
     * .gitignore lists, and looks only in src; see index.css).
     */
    watch: { ignored: ["**/src-tauri/**", "**/*.md", "**/*.imagesage", "**/*.imagesage.saving", ...["png", "jpg", "jpeg"].map((extension) => `${ROOT}/*.${extension}`)] }
  },
  preview: {
    port: PREVIEW_PORT,
    strictPort: true
  }
});
