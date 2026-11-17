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

/**
 * Prints what the dev app window reports (hot updates it applied, failed
 * updates, console errors) to the dev server output, so the dev log shows
 * whether an edit really reached the window. See src/main.tsx.
 */
const clientLog = {
  name: "imagesage-client-log",
  configureServer(server: import("vite").ViteDevServer) {
    server.ws.on("imagesage:log", (data: { message?: string }) => console.log(`[client] ${String(data?.message ?? "").slice(0, 4000)}`));
  }
};

/**
 * Dev only: `curl http://localhost:14410/__help-shots` tells the dev app
 * window to make the help pictures again (src/help/capture.ts). Add
 * `?only=paint` to make only the pictures whose name starts with "paint".
 * Pictures named "readme-..." are for README.md: they are made only when
 * asked for by name, and `&sample=/docs/readme/example-cabin.jpg` uses that
 * picture as the sample image. Move them from public/help to docs/readme.
 *
 * `curl "http://localhost:14410/__help-preview?chapter=paint-tools&scroll=600"`
 * opens the help window at that chapter and writes a picture of the window
 * to public/help/preview.png (not kept in Git), to check a chapter's layout.
 * The first call only opens the window; call it again for the picture.
 * Add `&zoom=0.4` to see a whole chapter in one picture.
 */
const helpShots = {
  name: "imagesage-help-shots",
  configureServer(server: import("vite").ViteDevServer) {
    server.middlewares.use("/__help-shots", (request, response) => {
      const query = new URL(request.url ?? "", "http://localhost").searchParams;
      server.ws.send({ type: "custom", event: "imagesage:help-shots", data: { only: query.get("only") ?? "", sample: query.get("sample") ?? "" } });
      response.end("The dev app makes the help pictures now. The dev log shows each one.\n");
    });
    server.middlewares.use("/__help-preview", (request, response) => {
      const query = new URL(request.url ?? "", "http://localhost").searchParams;
      server.ws.send({ type: "custom", event: "imagesage:help-preview", data: { chapter: query.get("chapter") ?? "", scroll: Number(query.get("scroll")) || 0, zoom: Number(query.get("zoom")) || 1 } });
      response.end("The help window writes public/help/preview.png now.\n");
    });
  }
};

export default defineConfig({
  plugins: [react(), tailwindcss(), clientLog, helpShots],
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
