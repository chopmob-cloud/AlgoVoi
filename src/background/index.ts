/**
 * Background service worker — AlgoVoi extension entry point.
 * Registers the message handler and periodic auto-lock alarm.
 */

import { registerMessageHandler } from "./message-handler";

// Register the central message router
registerMessageHandler();

// The MV3 service worker is suspended by Chrome when idle.
// wallet-store.ts registers an onSuspend listener that clears all in-memory
// key material when the SW is suspended, so suspension is equivalent to an
// implicit lock. No keepAlive alarm is needed — and Chrome Web Store policy
// prohibits artificially prolonging SW lifetime.
