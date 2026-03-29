/**
 * WC Relay Bridge — proxies WalletConnect relay WebSocket messages via HTTP.
 *
 * Chrome MV3 service workers cannot receive WebSocket push notifications.
 * This module opens a WebSocket to the WC relay on behalf of the extension,
 * stores incoming messages, and serves them via HTTP polling.
 *
 * The server generates its OWN JWT for relay auth (separate client identity)
 * so the relay treats it as an independent subscriber.
 */

import WebSocket from "ws";
import { generateKeyPair, signJWT } from "@walletconnect/relay-auth";
import { randomBytes, randomUUID } from "node:crypto";

const WC_PROJECT_ID = "6f4494fc63462bd664ca06f4c5b16463";
const RELAY_URL = "wss://relay.walletconnect.org";

/** Generate a fresh relay WebSocket URL with independent auth */
async function buildRelayWsUrl() {
  const seed = randomBytes(32);
  const keyPair = generateKeyPair(seed);
  const jwt = await signJWT(randomUUID(), RELAY_URL, 86400, keyPair);
  return `${RELAY_URL}/?auth=${jwt}&projectId=${WC_PROJECT_ID}&ua=wc-2/js-bridge`;
}

/** @type {Map<string, {ws: WebSocket|null, messages: Array, created: number}>} */
const listeners = new Map();

const MAX_LISTENER_AGE_MS = 10 * 60 * 1000; // 10 minutes
const MAX_MESSAGES = 50;

// Cleanup expired listeners every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [topic, listener] of listeners) {
    if (now - listener.created > MAX_LISTENER_AGE_MS) {
      stopListener(topic);
    }
  }
}, 60_000);

/**
 * Start listening on a WC relay topic.
 * @param {string} topic
 * @param {string} _wsUrl — Ignored; server generates its own auth
 */
export async function startListener(topic, _wsUrl) {
  if (listeners.has(topic)) stopListener(topic);

  const entry = { ws: null, messages: [], created: Date.now() };
  listeners.set(topic, entry);

  const connect = async () => {
    if (!listeners.has(topic)) return;

    let ws;
    try {
      const url = await buildRelayWsUrl();
      ws = new WebSocket(url);
    } catch (err) {
      console.error(`[wc-bridge] WS create failed for ${topic.slice(0, 8)}:`, err.message);
      return;
    }

    entry.ws = ws;

    ws.on("open", () => {
      console.log(`[wc-bridge] Connected for topic ${topic.slice(0, 8)}`);
      const sub = JSON.stringify({
        id: Date.now(),
        jsonrpc: "2.0",
        method: "irn_subscribe",
        params: { topic },
      });
      ws.send(sub);
    });

    ws.on("message", (data) => {
      try {
        const payload = JSON.parse(String(data));
        // Log ALL messages for debugging
        const method = payload.method || "response";
        const detail = payload.result ? `result=${JSON.stringify(payload.result).slice(0,80)}` : payload.error ? `error=${JSON.stringify(payload.error)}` : "";
        console.log(`[wc-bridge] msg for ${topic.slice(0, 8)}: method=${method} id=${payload.id || "?"} ${detail}`);
        if (payload.method && payload.method.endsWith("_subscription")) {
          const msgData = payload.params?.data;
          if (msgData?.topic && msgData?.message) {
            console.log(`[wc-bridge] Push for ${msgData.topic.slice(0, 8)} (${msgData.message.length} chars)`);
            entry.messages.push({
              topic: msgData.topic,
              message: msgData.message,
              publishedAt: msgData.publishedAt || Date.now(),
            });
            if (entry.messages.length > MAX_MESSAGES) {
              entry.messages.splice(0, entry.messages.length - MAX_MESSAGES);
            }
            // Acknowledge
            const ack = JSON.stringify({ id: payload.id, jsonrpc: "2.0", result: true });
            ws.send(ack);
          }
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on("close", () => {
      entry.ws = null;
      if (listeners.has(topic)) {
        setTimeout(() => connect().catch(() => {}), 2000);
      }
    });

    ws.on("error", (err) => {
      console.error(`[wc-bridge] WS error for ${topic.slice(0, 8)}:`, err.message);
    });
  };

  connect();
}

/**
 * Push a message into a topic's queue (called when agent POSTs directly).
 * @param {string} topic
 * @param {object} msg — { topic, message, publishedAt }
 */
export function pushMessage(topic, msg) {
  let entry = listeners.get(topic);
  if (!entry) {
    // Create a passive listener (no WebSocket) for direct-post mode
    entry = { ws: null, messages: [], created: Date.now() };
    listeners.set(topic, entry);
  }
  entry.messages.push(msg);
  if (entry.messages.length > MAX_MESSAGES) {
    entry.messages.splice(0, entry.messages.length - MAX_MESSAGES);
  }
}

/**
 * Get and clear stored messages for a topic.
 * @param {string} topic
 * @returns {Array<{topic: string, message: string, publishedAt: number}>}
 */
export function getMessages(topic) {
  const entry = listeners.get(topic);
  if (!entry) return [];
  return entry.messages.splice(0);
}

/**
 * Stop listening on a topic.
 * @param {string} topic
 */
export function stopListener(topic) {
  const entry = listeners.get(topic);
  if (!entry) return;
  try { entry.ws?.close(); } catch {}
  listeners.delete(topic);
  console.log(`[wc-bridge] Stopped listener for ${topic.slice(0, 8)}`);
}
