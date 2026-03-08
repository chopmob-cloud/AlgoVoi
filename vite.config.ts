import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "vite-plugin-web-extension";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@background": resolve(__dirname, "src/background"),
      "@content": resolve(__dirname, "src/content"),
      "@popup": resolve(__dirname, "src/popup"),
      "@approval": resolve(__dirname, "src/approval"),
      "@devtools": resolve(__dirname, "src/devtools"),
    },
  },
  plugins: [
    // WalletConnect Sign Client requires Node.js built-ins (buffer, events,
    // process, crypto) that aren't available in the browser. This polyfills them.
    // vm is explicitly excluded: its polyfill contains eval() which violates the
    // MV3 service-worker CSP (script-src 'self') and would be flagged in a review.
    // Nothing in the extension actually calls vm.Script.runInThisContext at runtime.
    nodePolyfills({
      globals: { Buffer: true, global: true, process: true },
      protocolImports: true,
      exclude: ["vm"],
    }),
    react(),
    webExtension({
      manifest: "manifest.json",
      // Additional entry points the manifest plugin doesn't auto-detect
      additionalInputs: [
        "src/inpage/index.ts",
        "src/devtools/panel.html",
        "src/approval/index.html",
      ],
      disableAutoLaunch: true,
      browser: "chrome",
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === "development",
    rollupOptions: {
      output: {
        // Keep chunks readable for debugging
        manualChunks: undefined,
      },
    },
  },
});
