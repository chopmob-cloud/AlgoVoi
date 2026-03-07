/**
 * Background service worker — AlgoVoi extension entry point.
 * Registers the message handler and periodic auto-lock alarm.
 */

import { registerMessageHandler } from "./message-handler";

// Register the central message router
registerMessageHandler();

// Service workers can be terminated and restarted by Chrome.
// Use alarms to keep critical state alive.
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepAlive") {
    // No-op: just keeps the SW alive so wallet lock timers function correctly.
    // In a production build, consider persisting the lock state to storage.
  }
});
