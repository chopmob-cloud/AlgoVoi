/**
 * Background service worker — AlgoVoi extension entry point.
 * Registers the message handler and Web3Wallet session restore.
 */

import { registerMessageHandler } from "./message-handler";
import { restoreWeb3WalletSessions } from "./web3wallet-handler";
import { WC_PROJECT_ID } from "@shared/constants";

// Register the central message router
registerMessageHandler();

// The MV3 service worker is suspended by Chrome when idle.
// wallet-store.ts registers an onSuspend listener that clears all in-memory
// key material when the SW is suspended, so suspension is equivalent to an
// implicit lock.

// W3W keepalive alarm — no-op handler; the alarm itself prevents SW suspension
// while AI agents are connected. Created by web3wallet-handler.ts after
// session_proposal succeeds. Chrome Web Store policy permits alarms for
// extension-functionality reasons (active user-approved sessions).
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "w3w-keepalive") {
    // No-op — just keeping the SW alive for active agent sessions.
  }
});

// Restore Web3Wallet sessions from previous SW lifecycle on startup.
// Non-blocking: if this fails, agent sessions will re-connect on next retry.
restoreWeb3WalletSessions(WC_PROJECT_ID).catch((err) => {
  console.warn("[AlgoVoi] Web3Wallet session restore failed:", err);
});
