/**
 * Central Chrome runtime message router.
 * All messages from content scripts, popup, and approval pages flow through here.
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getAccountState, getSuggestedParams, submitTransaction } from "./chain-clients";
import { CHAINS, X402_VERSION } from "@shared/constants";
import {
  handleX402,
  buildAndSignPayment,
  buildPaymentTxnForWC,
  getPendingRequest,
  clearPendingRequest,
  resolveChain,
} from "./x402-handler";
import { mcpResolveEnvoi } from "./mcp-client";
import { base64ToBytes } from "@shared/utils/crypto";
import type { X402PaymentPayload } from "@shared/types/x402";
import type { BgRequest } from "@shared/types/messages";
import type { ChainId } from "@shared/types/chain";

type SendResponse = (response: unknown) => void;

// ── Unlock rate-limiting ───────────────────────────────────────────────────────
// C2: Persisted in chrome.storage.session so brute-force counts survive SW suspension.
const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MS   = 30_000; // 30 seconds
const RATE_LIMIT_SESSION_KEY = "algovou_unlock_rate";
interface RateEntry { count: number; resetAt: number }

async function checkUnlockRate(key: string): Promise<void> {
  const now = Date.now();
  const stored = await chrome.storage.session.get(RATE_LIMIT_SESSION_KEY);
  const rateMap = (stored[RATE_LIMIT_SESSION_KEY] as Record<string, RateEntry> | undefined) ?? {};
  const entry = rateMap[key];
  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX_UNLOCK_ATTEMPTS) {
      const remaining = Math.ceil((entry.resetAt - now) / 1000);
      throw new Error(`Too many unlock attempts. Try again in ${remaining}s.`);
    }
    rateMap[key] = { count: entry.count + 1, resetAt: entry.resetAt };
  } else {
    rateMap[key] = { count: 1, resetAt: now + UNLOCK_LOCKOUT_MS };
  }
  await chrome.storage.session.set({ [RATE_LIMIT_SESSION_KEY]: rateMap });
}

async function clearUnlockRate(key: string): Promise<void> {
  const stored = await chrome.storage.session.get(RATE_LIMIT_SESSION_KEY);
  const rateMap = (stored[RATE_LIMIT_SESSION_KEY] as Record<string, RateEntry> | undefined) ?? {};
  delete rateMap[key];
  await chrome.storage.session.set({ [RATE_LIMIT_SESSION_KEY]: rateMap });
}

/** Parse decimal amount string → atomic BigInt without float rounding errors */
function parseDecimalToAtomic(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Invalid amount");
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  const atomic = BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
  // M1: Reject values that exceed the AVM uint64 maximum
  if (atomic > 18_446_744_073_709_551_615n) {
    throw new Error("Amount exceeds maximum representable value (uint64 overflow)");
  }
  return atomic;
}

export function registerMessageHandler(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: BgRequest,
      sender: chrome.runtime.MessageSender,
      sendResponse: SendResponse
    ) => {
      // Always use tabId from Chrome's sender object — never trust message payload
      const tabId = sender.tab?.id ?? -1;
      handleMessage(message, tabId, sender, sendResponse);
      return true; // keep message channel open for async response
    }
  );
}

async function handleMessage(
  msg: BgRequest,
  tabId: number,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse
): Promise<void> {
  try {
    const result = await dispatch(msg, tabId, sender);
    sendResponse({ ok: true, data: result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendResponse({ ok: false, error });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatch(msg: BgRequest, tabId: number, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (msg.type) {
    // ── Wallet lifecycle ──────────────────────────────────────────────────────
    case "WALLET_STATE": {
      const initialized = await walletStore.isInitialized();
      const lockState = initialized ? walletStore.getLockState() : "uninitialized";
      const meta = initialized ? await walletStore.getMeta() : null;
      return { lockState, meta };
    }

    case "WALLET_GET_META":
      return { meta: await walletStore.getMeta() };

    case "WALLET_INIT": {
      const { account } = await walletStore.initialize(msg.password, msg.mnemonic);
      return { success: true, account };
    }

    case "WALLET_UNLOCK": {
      // Rate-limit unlock attempts (keyed by sender origin or extension self)
      const unlockKey = sender.url ? new URL(sender.url).origin : "popup";
      await checkUnlockRate(unlockKey); // C2: now async (session storage)
      try {
        await walletStore.unlock(msg.password);
      } catch (err) {
        throw err; // rate counter already incremented; propagate to caller
      }
      await clearUnlockRate(unlockKey); // C2: now async; reset on success
      broadcastLockState();
      return { success: true };
    }

    case "WALLET_LOCK":
      walletStore.lock();
      broadcastLockState();
      return { success: true };

    case "WALLET_CREATE_ACCOUNT": {
      const account = await walletStore.createAccount(msg.name);
      return { account };
    }

    case "WALLET_IMPORT_ACCOUNT": {
      const account = await walletStore.importAccount(msg.name, msg.mnemonic);
      return { account };
    }

    case "WALLET_REMOVE_ACCOUNT":
      await walletStore.removeAccount(msg.id);
      return { success: true };

    case "WALLET_RENAME_ACCOUNT":
      await walletStore.renameAccount(msg.id, msg.name);
      return { success: true };

    case "WALLET_SET_ACTIVE_ACCOUNT":
      await walletStore.setActiveAccount(msg.id);
      return { success: true };

    case "WALLET_SET_CHAIN": {
      const switchChain = msg.chain as ChainId;
      // H1: Verify the node we're switching to actually serves the expected chain.
      // Prevents a compromised/misconfigured node URL from silently redirecting funds.
      try {
        const params = await getSuggestedParams(switchChain);
        const expectedHash = CHAINS[switchChain].genesisHash;
        // params.genesisHash is a Uint8Array — encode to base64 for comparison
        const actualHash = btoa(String.fromCharCode(...params.genesisHash));
        if (actualHash !== expectedHash) {
          throw new Error(
            `Node genesis hash mismatch for ${switchChain}: ` +
            `expected ${expectedHash}, got ${actualHash}. ` +
            `The configured node URL may be incorrect.`
          );
        }
      } catch (err) {
        // Re-throw genesis mismatch; swallow unreachable-node errors to allow offline switch
        if (err instanceof Error && err.message.includes("genesis hash mismatch")) throw err;
        console.warn(`[AlgoVoi] Could not verify genesis hash for ${switchChain}:`, err);
      }
      await walletStore.setActiveChain(switchChain);
      broadcastChainChange(switchChain);
      return { success: true };
    }

    // ── Chain queries ─────────────────────────────────────────────────────────
    case "CHAIN_GET_ACCOUNT_STATE": {
      const state = await getAccountState(msg.address, msg.chain as ChainId);
      return { state };
    }

    // ── Native coin send ──────────────────────────────────────────────────────
    case "CHAIN_SEND_PAYMENT": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      // Validate destination address (throws if invalid)
      if (!algosdk.isValidAddress(msg.to)) throw new Error("Invalid destination address");
      const chain = msg.chain as ChainId;
      const meta = await walletStore.getMeta();
      const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!senderAddress) throw new Error("No active account");
      const sk = await walletStore.getActiveSecretKey();
      const params = await getSuggestedParams(chain);
      const cfg = CHAINS[chain];
      // BigInt-safe decimal → atomic conversion (avoids float rounding errors)
      const amountAtomic = parseDecimalToAtomic(msg.amount, cfg.decimals);
      // Bound note to 1024 bytes max (AVM limit is 1000, we leave headroom)
      const noteText = msg.note ? msg.note.slice(0, 1024) : undefined;
      const note = noteText ? new TextEncoder().encode(noteText) : undefined;
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: msg.to,
        amount: amountAtomic,
        note,
        suggestedParams: params,
      });
      const signedBytes = txn.signTxn(sk);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    // ── Submit pre-signed transaction (WalletConnect flow) ────────────────────
    case "CHAIN_SUBMIT_SIGNED": {
      // L5: Require wallet to be unlocked before submitting WC-signed transactions.
      // Closes the narrow window where a WC session could be used after auto-lock.
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const chain = msg.chain as ChainId;
      const signedBytes = base64ToBytes(msg.signedTxn);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    // ── WalletConnect account management ──────────────────────────────────────
    case "WC_ADD_ACCOUNT": {
      const account = await walletStore.addWCAccount(
        msg.name,
        msg.address,
        msg.sessionTopic,
        msg.peerName,
        msg.chain as ChainId | undefined
      );
      return { account };
    }

    // ── ARC-0027 dApp connector ───────────────────────────────────────────────
    case "ARC27_ENABLE": {
      // Use sender.url (Chrome-provided, unforgeable) — never trust msg.origin from content
      const senderOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!senderOrigin) throw new Error("Cannot determine requesting site origin");
      const meta = await walletStore.getMeta();
      const address = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!address) throw new Error("No active account");
      const addresses = msg.accounts ?? [address];
      await walletStore.addConnectedSite(senderOrigin, addresses);
      return { accounts: addresses };
    }

    case "ARC27_SIGN_TXNS": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const signMeta = await walletStore.getMeta();
      const activeChain = signMeta.activeChain as ChainId;
      const expectedGenesisId = CHAINS[activeChain].genesisId;
      const sk = await walletStore.getActiveSecretKey();
      const stxns = msg.txns.map((b64, i) => {
        if (msg.indexesToSign && !msg.indexesToSign.includes(i)) {
          return null; // caller will fill this slot
        }
        const txnBytes = base64ToBytes(b64);
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);
        // C1: Reject transactions targeting the wrong chain (genesisID mismatch)
        const txnGenesisId = (txn as unknown as { genesisID?: string }).genesisID ?? "";
        if (txnGenesisId && txnGenesisId !== expectedGenesisId) {
          throw new Error(
            `Transaction genesisID "${txnGenesisId}" does not match active chain ` +
            `"${expectedGenesisId}". Switch to the correct chain before signing.`
          );
        }
        return btoa(String.fromCharCode(...txn.signTxn(sk)));
      });
      return { stxns };
    }

    case "ARC27_SIGN_BYTES": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const sk = await walletStore.getActiveSecretKey();
      const dataBytes = base64ToBytes(msg.data);
      // Prefix with "MX" per ARC-1
      const prefixed = new Uint8Array([0x4d, 0x58, ...dataBytes]);
      const sig = algosdk.signBytes(prefixed, sk);
      return { sig: btoa(String.fromCharCode(...sig)) };
    }

    case "ARC27_DISCONNECT": {
      const disconnectOrigin = sender.url ? new URL(sender.url).origin : msg.origin;
      await walletStore.removeConnectedSite(disconnectOrigin);
      return { success: true };
    }

    // ── x402 ─────────────────────────────────────────────────────────────────
    case "X402_PAYMENT_NEEDED": {
      const requestId = await handleX402({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        method: msg.method,
        // The inpage script passes rawPaymentRequired (base64 PAYMENT-REQUIRED value)
        rawPaymentRequired: msg.paymentRequirements as unknown as string,
        // Reuse the inpage's requestId so X402_RESULT is keyed the same way
        // as the _pendingX402 map entry — without this the inpage fetch promise
        // never resolves and the page stays stuck at step 3.
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "X402_GET_PENDING": {
      const req = getPendingRequest(msg.requestId);
      return { request: req };
    }

    case "X402_APPROVE": {
      const req = getPendingRequest(msg.requestId);
      if (!req) throw new Error("Pending request not found");

      // Check if active account is WalletConnect — can't sign in background
      const approveMeta = await walletStore.getMeta();
      const activeAccount = approveMeta.accounts.find((a) => a.id === approveMeta.activeAccountId);

      if (activeAccount?.type === "walletconnect") {
        // Guard: WC sessions are chain-specific — reject before touching the WC SDK
        // if the payment's chain differs from the chain the session was approved for.
        const paymentChain = resolveChain(req.paymentRequirements.network);
        const accountChain = (activeAccount.wcChain ?? paymentChain ?? "algorand") as ChainId;
        // Only block when wcChain is explicitly recorded and mismatches the payment chain.
        // Accounts created before this field was added (wcChain undefined) skip the guard
        // and let the WC SDK validate the session namespaces directly.
        if (paymentChain && activeAccount.wcChain !== undefined && accountChain !== paymentChain) {
          throw new Error(
            `This payment requires ${CHAINS[paymentChain].name} but your wallet ` +
            `(${activeAccount.wcPeerName ?? "mobile wallet"}) was connected on ` +
            `${CHAINS[accountChain].name}.\n\n` +
            `To fix: remove this account (✕ next to the name), switch to the ` +
            `${CHAINS[paymentChain].name} chain, then use + Connect to re-pair your wallet.`
          );
        }
        // Build unsigned txn and return params to the approval popup.
        // The pending request is intentionally NOT cleared here —
        // it will be cleared by X402_WC_SIGNED once signing completes.
        const wcData = await buildPaymentTxnForWC(req);
        return { needsWcSign: true, ...wcData };
      }

      // Vault account — sign locally
      let paymentHeader: string, txId: string;
      ({ paymentHeader, txId } = await buildAndSignPayment(req));
      clearPendingRequest(msg.requestId);
      chrome.tabs.sendMessage(req.tabId, {
        type: "X402_RESULT",
        requestId: msg.requestId,
        approved: true,
        paymentHeader,
        txId,
      });
      return { paymentHeader, txId };
    }

    case "X402_WC_SIGNED": {
      const req = getPendingRequest(msg.requestId);
      if (!req) throw new Error("Pending request not found");

      const pr = req.paymentRequirements;
      const chain = resolveChain(pr.network);
      if (!chain) throw new Error(`Unsupported network: ${pr.network}`);

      const signedBytes = base64ToBytes(msg.signedTxnB64);

      // Re-encode as standard base64 in case Defly/Pera returned URL-safe base64
      const signedTxnStdB64 = btoa(String.fromCharCode(...signedBytes));
      const wcPayload: X402PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: pr.scheme,
        network: pr.network,
        payload: { transaction: signedTxnStdB64 },
      };
      const paymentHeader = btoa(JSON.stringify(wcPayload));

      await submitTransaction(chain, signedBytes);
      clearPendingRequest(msg.requestId);

      chrome.tabs.sendMessage(req.tabId, {
        type: "X402_RESULT",
        requestId: msg.requestId,
        approved: true,
        paymentHeader,
      });
      return { paymentHeader };
    }

    case "X402_REJECT": {
      const req = getPendingRequest(msg.requestId);
      if (req) {
        clearPendingRequest(msg.requestId);
        chrome.tabs.sendMessage(req.tabId, {
          type: "X402_RESULT",
          requestId: msg.requestId,
          approved: false,
        });
      }
      return { success: true };
    }

    case "X402_GET_HISTORY":
      // TODO: persist payment records in chrome.storage.session
      return { records: [] };

    // ── enVoi name resolution ─────────────────────────────────────────────────
    case "VOI_RESOLVE_NAME": {
      // Guard: only available on Voi chain with an unlocked wallet
      const resolveMeta = await walletStore.getMeta();
      if (resolveMeta.activeChain !== "voi") {
        throw new Error("Name service is only available on the Voi chain");
      }
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet is locked — unlock before resolving .voi names");
      }
      const { address, displayName } = await mcpResolveEnvoi(msg.name);
      return { address, displayName };
    }

    default:
      throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
  }
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastLockState(): void {
  const lockState = walletStore.getLockState();
  // Ignore "Receiving end does not exist" when no extension pages are open.
  chrome.runtime.sendMessage({ type: "LOCK_STATE_CHANGED", lockState }).catch(() => {});
}

function broadcastChainChange(chain: ChainId): void {
  // Only send to tabs with http/https — chrome://, new-tab, and PDF renderers
  // don't have our content script and throw "No such renderer" if messaged.
  chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "CHAIN_CHANGED", chain }).catch(() => {});
      }
    }
  });
}
