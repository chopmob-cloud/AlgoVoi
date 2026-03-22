import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// Suppress the benign WalletConnect "No matching key" unhandled rejection.
//
// Root cause: when the popup has an active SignClient from a previous pairing
// (held in useWalletConnect's clientRef) AND wc-sign-group.ts creates a second
// fresh client for swap signing, both clients subscribe to the relay on the
// same session topic. When the wallet app responds, the relay delivers the
// message to BOTH clients. The hook's idle client throws "No matching key"
// because it didn't dispatch the request and has no pending history entry for
// it. The signing itself succeeds in wc-sign-group.ts — this rejection is
// purely noise. Suppressing it here prevents it from appearing in
// chrome://extensions → Errors.
window.addEventListener("unhandledrejection", (event) => {
  const msg: string =
    (event.reason as { message?: string } | null)?.message ??
    String(event.reason ?? "");
  if (msg.includes("No matching key")) {
    event.preventDefault();
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
