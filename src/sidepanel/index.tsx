import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../popup/index.css";
import App from "../popup/App";

// Suppress benign WalletConnect "No matching key" rejections (same as popup).
window.addEventListener("unhandledrejection", (event) => {
  const msg: string =
    (event.reason as { message?: string } | null)?.message ??
    String(event.reason ?? "");
  if (msg.includes("No matching key")) {
    event.preventDefault();
  }
});

// Keep the MV3 service worker alive while the side panel is open.
// An open runtime port prevents Chrome from suspending the SW, so the
// wallet stays unlocked (subject to the normal auto-lock timer) as long
// as the side panel remains visible — matching Rabby's session behaviour.
const _keepAlivePort = chrome.runtime.connect({ name: "sidepanel-keepalive" });
// Disconnect explicitly on unload so the background can react immediately.
window.addEventListener("beforeunload", () => _keepAlivePort.disconnect());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
