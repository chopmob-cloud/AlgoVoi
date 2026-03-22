/**
 * WalletConnect Web3Wallet handler — AlgoVoi as a WC *wallet*.
 *
 * This makes AlgoVoi the wallet role (not the dApp role). AI agents can
 * connect to AlgoVoi via WalletConnect and request transaction signing.
 * The user must approve each request in the popup — agents never touch keys.
 *
 * Supported chains (CAIP-2):
 *   algorand:mainnet-v1.0
 *   algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n  (Voi mainnet)
 *
 * Method: algo_signTxn (same as Pera/Defly/Voi Wallet).
 *
 * NOTE: The Web3Wallet WebSocket drops when the MV3 service worker suspends.
 * On next SW wake, restoreWeb3WalletSessions() re-initialises. Some agent
 * requests may be missed during suspension — this is acceptable for v0.1.4.
 * The alarms keepalive (w3w-keepalive, every 0.4 min) reduces suspension
 * frequency while agents are connected.
 */

import { Web3Wallet } from "@walletconnect/web3wallet";
import type { IWeb3Wallet } from "@walletconnect/web3wallet";
import { Core } from "@walletconnect/core";
// Web3Wallet uses default in-memory storage (not chromeStorage) to avoid
// keychain conflicts with the SignClient in the popup. Sessions are manually
// persisted to chrome.storage.local via storeSessions().
import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { APPROVAL_POPUP_WIDTH, APPROVAL_POPUP_HEIGHT, CHAINS } from "@shared/constants";
import { randomId } from "@shared/utils/crypto";
import { formatAmount } from "@shared/utils/format";
import { requestApproval } from "./approval-handler";
import type { AgentSignTxn, PendingAgentSignRequest } from "@shared/types/agent";
import type { PendingAgentSignApproval, TxnSummary } from "@shared/types/approval";

// ── CAIP-2 chain identifiers ──────────────────────────────────────────────────

const ALGO_CHAIN  = "algorand:mainnet-v1.0";
const VOI_CHAIN   = "algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n";
const SUPPORTED_CHAINS  = [ALGO_CHAIN, VOI_CHAIN];
const SUPPORTED_METHODS = ["algo_signTxn"];
const SUPPORTED_EVENTS  = ["accountsChanged"];

const W3W_METADATA = {
  name: "AlgoVoi",
  description: "Web3 wallet for Algorand + Voi",
  url: "https://chopmob-cloud.github.io/AlgoVoi",
  icons: ["https://chopmob-cloud.github.io/AlgoVoi/icon128.png"],
};

// Storage key for persisting active session topics across SW restarts
const W3W_SESSIONS_KEY = "algovou_w3w_sessions";

// Per-session rate limit: max pending agent sign requests
const MAX_PENDING_PER_SESSION = 10;

// ── Module state ──────────────────────────────────────────────────────────────

let _web3wallet: IWeb3Wallet | null = null;
let _projectId: string = "";
/** Guards restoreWeb3WalletSessions against concurrent invocations from the alarm */
let _restoring: boolean = false;

// ── Pending agent sign requests ───────────────────────────────────────────────

const _pendingAgentRequests = new Map<string, PendingAgentSignRequest>();
/** 6-minute TTL (1 min beyond the approval popup 5-min timeout) */
const AGENT_TTL_MS = 6 * 60 * 1000;

export function getPendingAgentSignRequest(id: string): PendingAgentSignRequest | null {
  return _pendingAgentRequests.get(id) ?? null;
}

export function clearPendingAgentSignRequest(id: string): void {
  _pendingAgentRequests.delete(id);
}

// ── Chain resolution ──────────────────────────────────────────────────────────

function resolveChainFromGenesisId(genesisId: string): "algorand" | "voi" | null {
  if (genesisId === CHAINS.algorand.genesisId) return "algorand";
  if (genesisId === CHAINS.voi.genesisId)      return "voi";
  return null;
}

// ── TxnSummary builder (mirrors ARC-27 logic in message-handler.ts) ──────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTxnSummary(txnBytes: Uint8Array, chain: "algorand" | "voi", skipped: boolean): TxnSummary {
  if (skipped) return { type: "skip", sender: "", skipped: true };
  try {
    const txn = algosdk.decodeUnsignedTransaction(txnBytes);
    const chainCfg = CHAINS[chain];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = txn as unknown as Record<string, any>;

    const type: string   = t.type ?? "unknown";
    const sender: string = t.from?.toString?.() ?? t.sender?.toString?.() ?? "";
    const receiver: string | undefined = t.to?.toString?.() ?? t.receiver?.toString?.();

    let amount: string | undefined;
    if (typeof t.amount === "bigint" || typeof t.amount === "number") {
      try {
        amount = `${formatAmount(BigInt(t.amount), chainCfg.decimals)} ${chainCfg.ticker}`;
      } catch { amount = String(t.amount); }
    }

    const assetId: number | undefined = t.assetIndex || undefined;
    const rekeyTo: string | undefined = t.rekeyTo?.toString?.() || undefined;
    const closeRemainderTo: string | undefined = t.closeRemainderTo?.toString?.() || undefined;
    const assetCloseTo: string | undefined = t.assetCloseTo?.toString?.() || undefined;

    const feeMicroalgos: number | undefined =
      typeof t.fee === "bigint" ? Number(t.fee)
      : typeof t.fee === "number" ? t.fee
      : undefined;

    const firstValid: number = typeof t.firstValid === "bigint" ? Number(t.firstValid)
      : typeof t.firstValid === "number" ? t.firstValid : 0;
    const lastValid: number  = typeof t.lastValid  === "bigint" ? Number(t.lastValid)
      : typeof t.lastValid  === "number" ? t.lastValid  : 0;
    const shortValidityWindow: true | undefined =
      firstValid > 0 && lastValid > 0 && (lastValid - firstValid) < 10 ? true : undefined;

    let note: string | undefined;
    const noteBytes = t.note as Uint8Array | undefined;
    if (noteBytes && noteBytes.length > 0) {
      try {
        note = new TextDecoder("utf-8", { fatal: true }).decode(noteBytes.slice(0, 200));
        if (note.length > 120) note = note.slice(0, 120) + "…";
      } catch {
        note = Array.from(noteBytes.slice(0, 24))
          .map((b) => (b as number).toString(16).padStart(2, "0")).join(" ")
          + (noteBytes.length > 24 ? " …" : "");
      }
    }

    const clawbackFrom: string | undefined =
      t.revocationTarget?.toString?.() || t.assetRevocationTarget?.toString?.() || undefined;

    const leaseBytes = t.lease as Uint8Array | undefined;
    const hasLease: true | undefined =
      leaseBytes && leaseBytes.length > 0 && leaseBytes.some((b: number) => b !== 0) ? true : undefined;

    const freezeTarget: string | undefined = type === "afrz"
      ? (t.freezeAccount?.toString?.() ?? t.freeze?.toString?.() ?? undefined)
      : undefined;
    const freezeStateRaw = t.assetFrozen ?? t.frozen;
    const freezing: boolean | undefined = type === "afrz" && freezeStateRaw !== undefined
      ? Boolean(freezeStateRaw) : undefined;

    const keyregOnline: boolean | undefined = type === "keyreg" ? !!(t.voteKey) : undefined;

    const OC_NAMES: Record<number, string> = {
      0: "NoOp", 1: "OptIn", 2: "CloseOut",
      3: "ClearState", 4: "UpdateApp", 5: "DeleteApp",
    };
    const applType: string | undefined = type === "appl" && typeof t.onComplete === "number"
      ? (OC_NAMES[t.onComplete] ?? String(t.onComplete)) : undefined;

    return {
      type, sender, receiver, amount, assetId,
      rekeyTo, closeRemainderTo, assetCloseTo,
      feeMicroalgos, note, applType, shortValidityWindow,
      clawbackFrom, hasLease, freezeTarget, freezing, keyregOnline,
    };
  } catch {
    return { type: "unknown", sender: "", blind: true };
  }
}

// ── Approval popup ────────────────────────────────────────────────────────────

async function openAgentSignPopup(requestId: string): Promise<void> {
  const url =
    chrome.runtime.getURL("src/approval/index.html") +
    `?requestId=${requestId}&kind=agent_sign`;
  await chrome.windows.create({
    url,
    type: "popup",
    width: APPROVAL_POPUP_WIDTH,
    height: APPROVAL_POPUP_HEIGHT,
    focused: true,
  });
}

// ── Session storage helpers ───────────────────────────────────────────────────

async function storeSessions(topics: string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [W3W_SESSIONS_KEY]: topics }, resolve);
  });
}

async function getStoredTopics(): Promise<string[]> {
  return new Promise((resolve) => {
    chrome.storage.local.get(W3W_SESSIONS_KEY, (result) => {
      const topics = result[W3W_SESSIONS_KEY];
      resolve(Array.isArray(topics) ? topics : []);
    });
  });
}

// ── Event handler registration ────────────────────────────────────────────────

function registerEventHandlers(w3w: IWeb3Wallet): void {
  // ── session_proposal ──────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  w3w.on("session_proposal", async (proposal: any) => {
    try {
      const { id, params } = proposal;

      // Validate that the dApp only requests the "algorand" namespace
      const requestedNs = params?.requiredNamespaces ?? {};
      if (!requestedNs.algorand) {
        await w3w.rejectSession({
          id,
          reason: { code: 5100, message: "Unsupported namespace — AlgoVoi only supports algorand namespace" },
        });
        return;
      }

      // Get active account address
      let address: string | null = null;
      try {
        const meta = await walletStore.getMeta();
        const active = meta.accounts.find((a) => a.id === meta.activeAccountId);
        if (active?.type === "walletconnect") {
          await w3w.rejectSession({
            id,
            reason: { code: 5100, message: "Agent connections require a vault account. Switch to a mnemonic-backed account." },
          });
          return;
        }
        address = active?.address ?? null;
      } catch (err) {
        console.error("[AlgoVoi W3W] Failed to get active account:", err);
      }

      if (!address) {
        await w3w.rejectSession({
          id,
          reason: { code: 5100, message: "No active vault account found" },
        });
        return;
      }

      // Build approved namespaces with both chains, both accounts
      const approvedNamespaces = {
        algorand: {
          chains: SUPPORTED_CHAINS,
          methods: SUPPORTED_METHODS,
          events: SUPPORTED_EVENTS,
          accounts: SUPPORTED_CHAINS.map((chain) => `${chain}:${address}`),
        },
      };

      const session = await w3w.approveSession({ id, namespaces: approvedNamespaces });
      const topic = session.topic;

      // Persist the new session topic
      const existing = await getStoredTopics();
      if (!existing.includes(topic)) {
        await storeSessions([...existing, topic]);
      }

      // Notify popup tabs so they can refresh the session list
      chrome.runtime.sendMessage({
        type: "W3W_SESSION_APPROVED",
        topic,
        agentName: session.peer.metadata.name,
      }).catch(() => {}); // ignore if no popup open

      // Start keepalive alarm now that we have an active session.
      // periodInMinutes: 1 — Chrome clamps sub-1-minute alarms to 1 min anyway;
      // using 1 explicitly avoids CWS reviewer concern about aggressive keepalive.
      chrome.alarms.create("w3w-keepalive", { periodInMinutes: 1 });

      console.info(`[AlgoVoi W3W] Agent session approved: ${topic} (${session.peer.metadata.name})`);
    } catch (err) {
      console.error("[AlgoVoi W3W] session_proposal handler error:", err);
    }
  });

  // ── session_request ───────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  w3w.on("session_request", async (event: any) => {
    const { id: wcRequestId, topic, params } = event;
    const { request } = params;

    if (request.method !== "algo_signTxn") {
      // Unsupported method
      await w3w.respondSessionRequest({
        topic,
        response: {
          id: wcRequestId,
          error: { code: 4200, message: `Unsupported method: ${request.method}` },
          jsonrpc: "2.0",
        },
      }).catch(() => {});
      return;
    }

    try {
      // algo_signTxn params: array of arrays of { txn: string, signers?: string[] }
      // Some agents send a flat array, others send a nested array — normalise.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rawTxns: any[] = request.params ?? [];
      // Some agents nest transactions in an outer array: [[{txn,signers},…]]
      // Others send a flat array: [{txn,signers},…]
      // Normalise by unwrapping one level if the first element is an array.
      if (Array.isArray(rawTxns[0])) {
        rawTxns = rawTxns[0]; // unwrap the outer array
      }

      const txns: AgentSignTxn[] = rawTxns.map((item) => ({
        txn: typeof item === "string" ? item : item.txn,
        signers: item.signers,
      }));

      if (txns.length === 0) {
        throw new Error("Empty transaction list");
      }

      // Rate limit: max pending requests per session
      let sessionPendingCount = 0;
      for (const req of _pendingAgentRequests.values()) {
        if (req.topic === topic) sessionPendingCount++;
      }
      if (sessionPendingCount >= MAX_PENDING_PER_SESSION) {
        throw new Error("Too many pending signing requests. Please wait for existing requests to complete.");
      }

      // Get active account to know the signing address
      const meta = await walletStore.getMeta();
      const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
      if (!activeAccount) throw new Error("No active account");
      if (activeAccount.type === "walletconnect") {
        throw new Error("Agent connections require a vault account");
      }

      // Determine chain from first signable transaction's genesisID
      let chain: "algorand" | "voi" = meta.activeChain === "voi" ? "voi" : "algorand";
      for (const item of txns) {
        const isEmpty = Array.isArray(item.signers) && item.signers.length === 0;
        if (isEmpty) continue;
        try {
          // Handle both standard base64 and base64url
          const b64 = item.txn.replace(/-/g, "+").replace(/_/g, "/");
          const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
          const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
          const txn = algosdk.decodeUnsignedTransaction(bytes);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const genesisId = (txn as unknown as Record<string, any>).genesisID ?? "";
          const resolved = resolveChainFromGenesisId(genesisId);
          if (resolved) { chain = resolved; break; }
        } catch { /* try next */ }
      }

      // Decode transactions for display summaries
      const decodedTxns: Record<string, unknown>[] = [];
      const txnSummaries: TxnSummary[] = txns.map((item) => {
        const isRef = Array.isArray(item.signers) && item.signers.length === 0;
        if (isRef) {
          decodedTxns.push({});
          return { type: "skip", sender: "", skipped: true };
        }
        try {
          const b64 = item.txn.replace(/-/g, "+").replace(/_/g, "/");
          const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
          const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const decoded = algosdk.decodeUnsignedTransaction(bytes) as unknown as Record<string, any>;
          decodedTxns.push(decoded);
          return buildTxnSummary(bytes, chain, false);
        } catch {
          decodedTxns.push({});
          return { type: "unknown", sender: "", blind: true };
        }
      });

      // Get session peer metadata for display
      const sessions = w3w.getActiveSessions();
      const session = sessions[topic];
      const agentName = session?.peer?.metadata?.name ?? "Unknown Agent";
      const agentUrl  = session?.peer?.metadata?.url  ?? "";

      // Capture the active accountId so W3W_AGENT_SIGN_APPROVE can assert it hasn't changed
      let agentActiveAccountId: string | undefined;
      try {
        const agentMeta = await walletStore.getMeta();
        agentActiveAccountId = agentMeta.activeAccountId ?? undefined;
      } catch { /* non-fatal */ }

      const requestId = randomId();
      const pending: PendingAgentSignRequest = {
        id: requestId,
        wcRequestId,
        topic,
        tabId: -1,
        inpageRequestId: requestId,
        agentName,
        agentUrl,
        chain,
        txns,
        decodedTxns,
        timestamp: Date.now(),
        accountId: agentActiveAccountId,
      };
      _pendingAgentRequests.set(requestId, pending);

      // TTL cleanup
      setTimeout(() => {
        if (_pendingAgentRequests.has(requestId)) {
          _pendingAgentRequests.delete(requestId);
          // Auto-reject via WC so the agent gets a timely error
          w3w.respondSessionRequest({
            topic,
            response: {
              id: wcRequestId,
              error: { code: 4001, message: "User did not respond in time" },
              jsonrpc: "2.0",
            },
          }).catch(() => {});
        }
      }, AGENT_TTL_MS);

      // Queue approval (fire-and-forget; popup communicates back via W3W_AGENT_SIGN_APPROVE/REJECT)
      const agentApproval: PendingAgentSignApproval = {
        kind: "agent_sign",
        id: requestId,
        agentName,
        agentUrl,
        chain,
        txCount: txns.length,
        txnSummaries,
        timestamp: Date.now(),
      };
      requestApproval(agentApproval).catch(() => {
        _pendingAgentRequests.delete(requestId);
      });

      // Notify popup so it can badge/highlight
      chrome.runtime.sendMessage({ type: "W3W_SESSION_REQUEST", requestId }).catch(() => {});

      // Open approval popup
      await openAgentSignPopup(requestId);

      // Respond will be called by W3W_AGENT_SIGN_APPROVE or W3W_AGENT_SIGN_REJECT message handlers
      // (in message-handler.ts) which call respondAgentSignRequest() below.

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[AlgoVoi W3W] session_request error:", msg);
      await w3w.respondSessionRequest({
        topic,
        response: {
          id: wcRequestId,
          error: { code: 4001, message: msg },
          jsonrpc: "2.0",
        },
      }).catch(() => {});
    }
  });

  // ── session_delete / session_expire ───────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  w3w.on("session_delete", async (event: any) => {
    const topic: string = event?.topic ?? "";
    if (topic) {
      const topics = await getStoredTopics();
      await storeSessions(topics.filter((t) => t !== topic));
      console.info(`[AlgoVoi W3W] Session deleted by peer: ${topic}`);
      // Stop keepalive only if no sessions AND no pending pairings remain
      const remaining = w3w.getActiveSessions();
      if (Object.keys(remaining).length === 0 && getActivePairings() === 0) {
        chrome.alarms.clear("w3w-keepalive").catch(() => {});
      }
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the Web3Wallet instance for the given WC project ID.
 * Idempotent — if already initialised with the same projectId, returns existing instance.
 */
export async function initWeb3Wallet(projectId: string): Promise<IWeb3Wallet> {
  if (_web3wallet && _projectId === projectId) return _web3wallet;

  _projectId = projectId;

  const core = new Core({ projectId });
  const w3w = await Web3Wallet.init({ core, metadata: W3W_METADATA });

  registerEventHandlers(w3w);
  _web3wallet = w3w;

  return w3w;
}

/**
 * Generate a fresh WC pairing URI for agents to scan/paste.
 * Initialises Web3Wallet if not already done.
 */
export async function generatePairingUri(projectId: string): Promise<string> {
  // Guard: only vault accounts can be used for agent signing
  const meta = await walletStore.getMeta();
  const active = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (active?.type === "walletconnect") {
    throw new Error("Agent connections require a vault account. Switch to a mnemonic-backed account.");
  }

  const w3w = await initWeb3Wallet(projectId);
  const { uri } = await w3w.core.pairing.create();
  if (!uri) throw new Error("Failed to generate pairing URI");

  // Start keepalive immediately so the SW stays alive during the pairing window.
  // Without this, Chrome can suspend the SW within ~30 s of idling, dropping the
  // relay WebSocket before session_proposal arrives from the agent.
  // The alarm handler will self-clear once all sessions AND pairings are gone.
  chrome.alarms.create("w3w-keepalive", { periodInMinutes: 1 });

  return uri;
}

/**
 * Return all active WC sessions (agents connected to AlgoVoi as wallet).
 */
export function getActiveSessions(): Record<string, unknown> {
  if (!_web3wallet) return {};
  return _web3wallet.getActiveSessions() as unknown as Record<string, unknown>;
}

/**
 * Return the number of active (non-expired) WC pairings.
 * Used by the keepalive alarm handler to stay alive during the pairing window
 * (after generatePairingUri returns but before session_proposal arrives).
 */
export function getActivePairings(): number {
  if (!_web3wallet) return 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pairings: any[] = _web3wallet.core.pairing.getPairings();
  return pairings.filter((p) => p.active).length;
}

/**
 * Disconnect an agent session by topic.
 */
export async function disconnectAgentSession(topic: string): Promise<void> {
  if (!_web3wallet) return;
  try {
    await _web3wallet.disconnectSession({
      topic,
      reason: { code: 6000, message: "User disconnected" },
    });
  } catch (err) {
    // Log but don't throw — the session may already be gone
    console.warn("[AlgoVoi W3W] disconnectSession error:", err);
  }
  // Remove from persisted topics
  const topics = await getStoredTopics();
  await storeSessions(topics.filter((t) => t !== topic));
  // Stop keepalive only if no sessions AND no pending pairings remain
  const remaining = getActiveSessions();
  if (Object.keys(remaining).length === 0 && getActivePairings() === 0) {
    chrome.alarms.clear("w3w-keepalive").catch(() => {});
  }
}

/**
 * Sign agent transactions (called from message-handler on W3W_AGENT_SIGN_APPROVE).
 * Returns base64-encoded signed transactions (or null for reference txns).
 */
export async function approveAgentSignRequest(
  requestId: string,
  sk: Uint8Array,
  signerAddress: string
): Promise<(string | null)[]> {
  const req = _pendingAgentRequests.get(requestId);
  if (!req || !_web3wallet) throw new Error("Pending agent request not found");

  const chainCfg = CHAINS[req.chain];

  const signedTxns: (string | null)[] = req.txns.map((item) => {
    // Reference transaction — don't sign, return null
    if (Array.isArray(item.signers) && item.signers.length === 0) return null;

    // If signers is specified and doesn't include our address, don't sign
    if (Array.isArray(item.signers) && item.signers.length > 0) {
      if (!item.signers.includes(signerAddress)) return null;
    }

    try {
      const b64 = item.txn.replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      const txn = algosdk.decodeUnsignedTransaction(bytes);

      // Defence-in-depth genesis check (same pattern as ARC-27 post-approval check)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const genesisId = (txn as unknown as Record<string, any>).genesisID ?? "";
      if (genesisId && genesisId !== chainCfg.genesisId) {
        throw new Error(
          `Transaction genesisID "${genesisId}" does not match expected "${chainCfg.genesisId}"`
        );
      }

      const signedBytes = txn.signTxn(sk);
      return btoa(String.fromCharCode(...signedBytes));
    } catch (err) {
      throw new Error(`Failed to sign transaction: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Respond to the WC request
  await _web3wallet.respondSessionRequest({
    topic: req.topic,
    response: {
      id: req.wcRequestId,
      result: signedTxns,
      jsonrpc: "2.0",
    },
  });

  _pendingAgentRequests.delete(requestId);
  return signedTxns;
}

/**
 * Reject an agent sign request (user clicked Reject in popup, or TTL fired).
 */
export async function rejectAgentSignRequest(requestId: string): Promise<void> {
  const req = _pendingAgentRequests.get(requestId);
  if (!req || !_web3wallet) {
    _pendingAgentRequests.delete(requestId);
    return;
  }

  await _web3wallet.respondSessionRequest({
    topic: req.topic,
    response: {
      id: req.wcRequestId,
      error: { code: 4001, message: "User rejected the request" },
      jsonrpc: "2.0",
    },
  }).catch(() => {});

  _pendingAgentRequests.delete(requestId);
}

/**
 * Re-initialise Web3Wallet on SW startup and restore active sessions.
 * Called from background/index.ts after registering message handlers.
 *
 * Sessions may have been active before the SW was suspended. Re-registering
 * event handlers re-subscribes to the relay. Pending WC requests from the
 * suspension window are lost (acceptable for v0.1.4 — documented above).
 */
export async function restoreWeb3WalletSessions(projectId: string): Promise<void> {
  // Re-entrancy guard: the alarm fires every 60 s; skip if a restore is
  // already in flight (relay init + topic fetch can take several seconds).
  if (_restoring) return;
  _restoring = true;

  try {
    const topics = await getStoredTopics();
    if (topics.length === 0 && !projectId) return; // nothing to restore

    try {
      await initWeb3Wallet(projectId);
      const activeSessions = _web3wallet?.getActiveSessions() ?? {};
      const activeTopics = Object.keys(activeSessions);

      // Clean up stored topics that no longer exist in the WC relay
      const validTopics = topics.filter((t) => activeTopics.includes(t));
      if (validTopics.length !== topics.length) {
        await storeSessions(validTopics);
      }

      if (validTopics.length > 0) {
        // Active sessions present — keep the alarm alive
        chrome.alarms.create("w3w-keepalive", { periodInMinutes: 1 });
        console.info(`[AlgoVoi W3W] Restored ${validTopics.length} agent session(s)`);
      } else {
        // No active sessions — check for pending pairings (QR shown, awaiting scan)
        const pendingPairings = getActivePairings();
        if (pendingPairings === 0) {
          // Nothing active at all — clear the alarm so the SW can suspend normally.
          // This handles the case where a pairing was created but the agent never
          // connected and the pairing expired via WC TTL (session_delete won't fire).
          chrome.alarms.clear("w3w-keepalive").catch(() => {});
        }
      }
    } catch (err) {
      console.warn("[AlgoVoi W3W] restoreWeb3WalletSessions failed:", err);
      // Non-fatal: agent sessions will re-connect when the agent retries
    }
  } finally {
    _restoring = false;
  }
}
