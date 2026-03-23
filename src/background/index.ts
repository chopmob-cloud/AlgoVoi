/**
 * Background service worker — AlgoVoi extension entry point.
 * Registers the message handler and Web3Wallet session restore.
 */

import { registerMessageHandler } from "./message-handler";
import { restoreWeb3WalletSessions } from "./web3wallet-handler";
import { WC_PROJECT_ID } from "@shared/constants";

// Suppress benign WC "No matching key" unhandled rejections in the SW context.
// The WC relay delivers responses to all subscribed clients; clients that didn't
// send the request throw "No matching key" which is harmless but pollutes
// chrome://extensions errors.
self.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const msg: string =
    (event.reason as { message?: string } | null)?.message ??
    String(event.reason ?? "");
  if (msg.includes("No matching key")) {
    event.preventDefault();
  }
});

// Validate WC project ID at startup — empty string will cause silent WC failures
if (!WC_PROJECT_ID) {
  console.error("[AlgoVoi] VITE_WC_PROJECT_ID is not set — WalletConnect will not function.");
}

// Register the central message router
registerMessageHandler();

// The MV3 service worker is suspended by Chrome when idle.
// wallet-store.ts registers an onSuspend listener that clears all in-memory
// key material when the SW is suspended, so suspension is equivalent to an
// implicit lock.

// W3W keepalive alarm — fires every minute while a WalletConnect session or
// pairing is active to prevent the MV3 service worker from being suspended
// (which would drop the relay WebSocket).
//
// The handler calls restoreWeb3WalletSessions() on each tick. This is
// intentionally idempotent: if _web3wallet is already initialised it returns
// immediately; if the SW was suspended and restarted it re-connects the relay
// so that any queued session_proposals or session_requests are delivered.
//
// Alarm cleanup is handled by the session_delete event handler and
// disconnectAgentSession(), which call chrome.alarms.clear() once all sessions
// are gone. We do NOT attempt to clear the alarm here based on runtime state
// because _web3wallet is null immediately after a SW wake-up (async init has
// not completed yet), which would cause a false-clear on every tick.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "w3w-keepalive") return;
  restoreWeb3WalletSessions(WC_PROJECT_ID).catch(() => {});
});

// Restore Web3Wallet sessions from previous SW lifecycle on startup.
// Non-blocking: if this fails, agent sessions will re-connect on next retry.
restoreWeb3WalletSessions(WC_PROJECT_ID).catch((err) => {
  console.warn("[AlgoVoi] Web3Wallet session restore failed:", err);
});
