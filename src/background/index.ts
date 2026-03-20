/**
 * Background service worker — AlgoVoi extension entry point.
 * Registers the message handler and Web3Wallet session restore.
 */

import { registerMessageHandler } from "./message-handler";
import { restoreWeb3WalletSessions, getActiveSessions, getActivePairings } from "./web3wallet-handler";
import { WC_PROJECT_ID } from "@shared/constants";

// Register the central message router
registerMessageHandler();

// The MV3 service worker is suspended by Chrome when idle.
// wallet-store.ts registers an onSuspend listener that clears all in-memory
// key material when the SW is suspended, so suspension is equivalent to an
// implicit lock.

// W3W keepalive alarm — fires every minute to prevent the MV3 service worker
// from being suspended while a WalletConnect session OR pairing is active.
// The handler checks both active sessions (established) and active pairings
// (QR shown, waiting for session_proposal) before clearing, so the SW stays
// alive during the full pairing window — not just after session approval.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "w3w-keepalive") return;
  const sessions = getActiveSessions();
  const pairings = getActivePairings();
  if (Object.keys(sessions).length === 0 && pairings === 0) {
    // No active sessions or pending pairings — SW can suspend naturally.
    chrome.alarms.clear("w3w-keepalive").catch(() => {});
  }
});

// Restore Web3Wallet sessions from previous SW lifecycle on startup.
// Non-blocking: if this fails, agent sessions will re-connect on next retry.
restoreWeb3WalletSessions(WC_PROJECT_ID).catch((err) => {
  console.warn("[AlgoVoi] Web3Wallet session restore failed:", err);
});
