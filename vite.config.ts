import { defineConfig } from "vite";

// Vite config tuned for Tauri: fixed dev port, no clobbering the terminal,
// and a build target the WebView2/WKWebView engines understand.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "chrome110",
    minify: process.env.TAURI_DEBUG ? false : "esbuild",
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
