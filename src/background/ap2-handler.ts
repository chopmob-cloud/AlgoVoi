/**
 * AP2 (Agent Payments Protocol) handler.
 * https://github.com/google-agentic-commerce/AP2
 *
 * AlgoVoi acts as a credentials provider (wallet):
 *   1. Verifies CartMandates from merchants/agents
 *   2. Queues PendingAp2Approval for user confirmation
 *   3. Opens approval popup (kind=ap2_payment)
 *   4. On approval: builds and signs a PaymentMandate using the wallet's ed25519 key
 *   5. Returns the PaymentMandate to the inpage caller
 *
 * AP2 does NOT submit an AVM transaction — it only signs a credential.
 * The merchant/agent handles payment settlement separately.
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { randomId } from "@shared/utils/crypto";
import { requestApproval } from "./approval-handler";
import type {
  CartMandate,
  CartMandateContents,
  IntentMandate,
  PaymentMandate,
  PaymentMandateContents,
  PendingAp2Approval,
} from "@shared/types/ap2";

// ── base64url helpers ─────────────────────────────────────────────────────────

function encodeBase64url(input: string | Uint8Array): string {
  let b64: string;
  if (typeof input === "string") {
    b64 = btoa(input);
  } else {
    b64 = btoa(Array.from(input).map((b) => String.fromCharCode(b)).join(""));
  }
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── SHA-256 via Web Crypto ────────────────────────────────────────────────────

async function sha256Hex(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Pending request queue ─────────────────────────────────────────────────────

const _pendingAp2Requests = new Map<string, PendingAp2Approval>();

export function getPendingAp2Request(id: string): PendingAp2Approval | null {
  return _pendingAp2Requests.get(id) ?? null;
}

export function clearPendingAp2Request(id: string): void {
  _pendingAp2Requests.delete(id);
}

// ── IntentMandate storage ─────────────────────────────────────────────────────

// M2: IntentMandates contain payment metadata (amounts, merchant identity, address
// correlations). Store in chrome.storage.session — cleared on browser close — rather
// than chrome.storage.local, so payment history is never persisted unencrypted to disk.
const INTENT_MANDATE_STORAGE_KEY = "algovou_ap2_intent_mandates";

export async function getIntentMandates(): Promise<IntentMandate[]> {
  const stored = await chrome.storage.session.get(INTENT_MANDATE_STORAGE_KEY);
  const mandates = stored[INTENT_MANDATE_STORAGE_KEY];
  if (!Array.isArray(mandates)) return [];
  return mandates as IntentMandate[];
}

export async function storeIntentMandate(mandate: IntentMandate): Promise<void> {
  const existing = await getIntentMandates();
  // Replace if same id, otherwise append; cap at 100 entries (oldest dropped)
  const updated = existing.filter((m) => m.id !== mandate.id);
  updated.push(mandate);
  await chrome.storage.session.set({
    [INTENT_MANDATE_STORAGE_KEY]: updated.slice(-100),
  });
}

export async function removeIntentMandate(id: string): Promise<void> {
  const existing = await getIntentMandates();
  await chrome.storage.session.set({
    [INTENT_MANDATE_STORAGE_KEY]: existing.filter((m) => m.id !== id),
  });
}

// ── CartMandate verification ──────────────────────────────────────────────────

/**
 * Verify the CartMandate has required fields and is not expired.
 * Does NOT verify the merchant_authorization JWT signature — that is
 * the merchant/agent's responsibility; AlgoVoi trusts what is presented
 * and lets the user decide via the approval popup.
 *
 * Returns an error string if invalid, null if valid.
 */
export function verifyCartMandate(cartMandate: CartMandate): string | null {
  const { contents, merchant_authorization } = cartMandate;

  if (!contents || typeof contents !== "object") {
    return "CartMandate: missing or invalid contents";
  }

  if (!contents.transaction_id || typeof contents.transaction_id !== "string") {
    return "CartMandate: missing transaction_id";
  }

  if (!Array.isArray(contents.items) || contents.items.length === 0) {
    return "CartMandate: items must be a non-empty array";
  }

  for (let i = 0; i < contents.items.length; i++) {
    const item = contents.items[i];
    if (!item.label || typeof item.label !== "string") {
      return `CartMandate: item[${i}] missing label`;
    }
    if (
      !item.amount ||
      typeof item.amount.currency !== "string" ||
      typeof item.amount.value !== "string"
    ) {
      return `CartMandate: item[${i}] missing valid amount`;
    }
  }

  if (
    !contents.total ||
    typeof contents.total.currency !== "string" ||
    typeof contents.total.value !== "string"
  ) {
    return "CartMandate: missing or invalid total";
  }

  // Validate numeric format on item amounts and total (rejects "NaN", "Infinity", etc.)
  const numericRe = /^\d+(\.\d+)?$/;
  if (!numericRe.test(contents.total.value)) {
    return `CartMandate: total.value is not a valid number: "${contents.total.value}"`;
  }
  for (let i = 0; i < contents.items.length; i++) {
    if (!numericRe.test(contents.items[i].amount.value)) {
      return `CartMandate: item[${i}].amount.value is not a valid number`;
    }
  }

  if (!merchant_authorization || typeof merchant_authorization !== "string") {
    return "CartMandate: missing merchant_authorization";
  }

  // Expiry check
  if (contents.expiry) {
    const expiresAt = new Date(contents.expiry).getTime();
    if (!isNaN(expiresAt) && Date.now() > expiresAt) {
      return "CartMandate has expired";
    }
  }

  return null;
}

// ── PaymentMandate construction ───────────────────────────────────────────────

/**
 * Build and sign a PaymentMandate.
 *
 * Signs JSON.stringify(contents) with algosdk.signBytes (ed25519) using the
 * active vault key. Does NOT submit any AVM transaction.
 *
 * user_authorization format:
 *   base64url(JSON.stringify(contents)) + "." + base64url(signature_bytes)
 */
export async function buildPaymentMandate(params: {
  cartMandate: CartMandate;
  intentMandateId: string;
  network: "algorand" | "voi";
  address: string;
}): Promise<PaymentMandate> {
  if (walletStore.getLockState() !== "unlocked") {
    throw new Error("Wallet is locked");
  }

  // Determine signing key: agent key (vault) takes priority over active account key.
  // Check this BEFORE the WC account guard so vault users with a WC active account
  // can still sign AP2 credentials autonomously via the agent key.
  const agentAddr = walletStore.getAgentAddress();
  const useAgent  = !!(agentAddr && params.address === agentAddr);

  if (!useAgent) {
    const meta = await walletStore.getMeta();
    const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
    if (!activeAccount) throw new Error("No active account");

    if (activeAccount.type === "walletconnect") {
      throw new Error(
        "⚠ WalletConnect accounts cannot sign AP2 credentials. AP2 requires " +
        "ed25519 byte signing which WalletConnect mobile wallets do not support. " +
        "Switch to a vault (mnemonic) account in AlgoVoi settings to use AP2."
      );
    }

    if (params.address !== activeAccount.address) {
      throw new Error(
        `AP2: requested signer ${params.address} does not match active account ${activeAccount.address}`
      );
    }
  }

  // Hash the CartMandate for tamper detection
  const cartMandateJson = JSON.stringify(params.cartMandate);
  const cartMandateHash = await sha256Hex(cartMandateJson);

  const contents: PaymentMandateContents = {
    payment_id: randomId(),
    cart_mandate_hash: cartMandateHash,
    intent_mandate_id: params.intentMandateId,
    amount: params.cartMandate.contents.total,
    network: params.network,
    address: params.address,
    timestamp: Date.now(),
  };

  const contentsJson = JSON.stringify(contents);
  const contentsBytes = new TextEncoder().encode(contentsJson);

  const sk = useAgent
    ? await walletStore.getAgentSecretKey()
    : await walletStore.getActiveSecretKey();

  // algosdk.signBytes signs the raw bytes with the ed25519 key.
  // We do NOT use signBytes' built-in "MX" prefix (ARC-1) because
  // this is not an ARC-0027 operation — it's an AP2 credential.
  const signature = algosdk.signBytes(contentsBytes, sk);

  const userAuthorization =
    encodeBase64url(contentsJson) + "." + encodeBase64url(signature);

  return {
    contents,
    user_authorization: userAuthorization,
  };
}

// ── Main entry: handle an incoming AP2 payment request ────────────────────────

/**
 * Called by the message handler when the inpage script calls
 * window.algorand.ap2.requestPayment(cartMandate).
 *
 * Validates the CartMandate, queues a PendingAp2Approval, and opens the
 * approval popup. Returns the requestId so the message handler can
 * route the AP2_RESULT notification back to the correct inpage tab.
 */
export async function handleAp2Payment(params: {
  tabId: number;
  url: string;
  cartMandate: CartMandate;
  inpageRequestId: string;
}): Promise<string> {
  // Validate CartMandate structure and expiry
  const validationError = verifyCartMandate(params.cartMandate);
  if (validationError) {
    throw new Error(`Invalid CartMandate: ${validationError}`);
  }

  // Determine signer: prefer agent key (vault) for autonomous operation
  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");

  const agentSignerAddr = walletStore.getAgentAddress();
  const isWalletConnect = activeAccount.type === "walletconnect";
  const network = (meta.activeChain as "algorand" | "voi") ?? "algorand";
  // Use agent address when vault is deployed — enables autonomous AP2 signing
  const address = agentSignerAddr ?? activeAccount.address;

  // M1: Per-origin queue cap — compare origins, not full URLs, so different paths
  // on the same site count toward the same cap and cannot bypass it.
  const PENDING_CAP = 5;
  let ap2PendingOrigin: string;
  try { ap2PendingOrigin = new URL(params.url).origin; } catch { ap2PendingOrigin = params.url; }
  let tabPendingCount = 0;
  for (const req of _pendingAp2Requests.values()) {
    try {
      if (new URL(req.url).origin === ap2PendingOrigin) tabPendingCount++;
    } catch {
      if (req.url === params.url) tabPendingCount++;
    }
  }
  if (tabPendingCount >= PENDING_CAP) {
    throw new Error(
      "Too many pending AP2 payment requests from this origin. " +
        "Complete or reject existing requests before initiating new ones."
    );
  }

  const requestId = randomId();
  const contents = params.cartMandate.contents;

  const pending: PendingAp2Approval = {
    kind: "ap2_payment",
    id: requestId,
    tabId: params.tabId,
    url: params.url,
    cartMandate: params.cartMandate,
    merchant_id: contents.merchant_id,
    transaction_id: contents.transaction_id,
    items: contents.items,
    total: contents.total,
    inpageRequestId: params.inpageRequestId,
    network,
    address,
    expiry: contents.expiry,
    timestamp: Date.now(),
    isWalletConnect,
  };
  _pendingAp2Requests.set(requestId, pending);

  // Safety TTL — 6 min (1 min beyond approval popup's 5-min TTL)
  const TTL_MS = 6 * 60 * 1000;
  setTimeout(() => {
    _pendingAp2Requests.delete(requestId);
  }, TTL_MS);

  // ── Vault auto-approval: skip popup when agent key is available ───────────
  // The agent key is a standard ed25519 key that can sign AP2 credentials
  // autonomously. No AVM transaction needed — AP2 is credential-only.
  // On failure, fall through to the approval popup so the user can still approve.
  if (agentSignerAddr) {
    try {
      const intentMandateId = randomId();
      const paymentMandate  = await buildPaymentMandate({
        cartMandate: params.cartMandate,
        intentMandateId,
        network,
        address: agentSignerAddr,
      });
      _pendingAp2Requests.delete(requestId);
      chrome.tabs.sendMessage(params.tabId, {
        type: "AP2_RESULT",
        requestId: params.inpageRequestId,
        approved: true,
        paymentMandate,
      }).catch(() => {});
      return requestId;
    } catch {
      // Auto-sign failed — fall through to approval popup
    }
  }

  // ── Standard approval popup path ─────────────────────────────────────────
  // Queue in the unified approval handler — it opens the popup and manages the TTL.
  // On TTL expiry or popup-open failure, clear the request from our map too.
  requestApproval(pending).catch(() => {
    _pendingAp2Requests.delete(requestId);
  });

  return requestId;
}

// ── Exported helpers for CartMandateContents type access ──────────────────────

export type { CartMandateContents };
