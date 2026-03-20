/**
 * Background service worker — AlgoVoi extension entry point.
 * Registers the message handler and Web3Wallet session restore.
 */

import { registerMessageHandler } from "./message-handler";
import { restoreWeb3WalletSessions, getActiveSessions } from "./web3wallet-handler";
import { WC_PROJECT_ID } from "@shared/constants";

// Register the central message router
registerMessageHandler();

// The MV3 service worker is suspended by Chrome when idle.
// wallet-store.ts registers an onSuspend listener that clears all in-memory
// key material when the SW is suspended, so suspension is equivalent to an
// implicit lock.

// W3W keepalive alarm — fires every minute while an agent session is active to
// prevent the MV3 service worker from being suspended (which would drop the
// WalletConnect WebSocket). The handler actively checks whether sessions still
// exist and clears the alarm automatically when none remain, so the SW can
// suspend normally once all agents have disconnected.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "w3w-keepalive") return;
  const sessions = getActiveSessions();
  if (Object.keys(sessions).length === 0) {
    // No active agent sessions — stop the keepalive so Chrome can suspend the SW.
    chrome.alarms.clear("w3w-keepalive").catch(() => {});
  }
});

// Restore Web3Wallet sessions from previous SW lifecycle on startup.
// Non-blocking: if this fails, agent sessions will re-connect on next retry.
restoreWeb3WalletSessions(WC_PROJECT_ID).catch((err) => {
  console.warn("[AlgoVoi] Web3Wallet session restore failed:", err);
});
