import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    // Node environment covers fetch (Node 18+), TextEncoder, crypto globals.
    // Chrome extension APIs (chrome.*) are stubbed per-test with vi.stubGlobal.
    environment: "node",
    globals: true,
    // Resolve @shared alias so imports inside src/background/* work in tests.
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
    coverage: {
      provider: "v8",
      include: [
        "src/background/approval-handler.ts",
        "src/background/mcp-client.ts",
        "src/background/message-handler.ts",
      ],
      reporter: ["text", "lcov"],
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  define: {
    // Stub Vite env vars used by src/shared/constants.ts so tests don't throw.
    "import.meta.env.VITE_WC_PROJECT_ID": JSON.stringify("test-wc-project-id"),
    "import.meta.env.VITE_WC_APP_URL": JSON.stringify("https://test.app"),
    "import.meta.env.VITE_WC_RELAY_URL": JSON.stringify("wss://relay.walletconnect.com"),
    "import.meta.env.VITE_MCP_ENDPOINT": JSON.stringify("https://mcp.ilovechicken.co.uk/mcp"),
    "import.meta.env.MODE": JSON.stringify("test"),
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "false",
  },
});
