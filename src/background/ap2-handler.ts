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

  // JWT structure + claims validation.
  // Full signature verification requires a merchant key registry (not yet available).
  // We validate: 3-part structure, base64url payload, exp/nbf, and cross-field
  // consistency between the JWT claims and CartMandateContents.
  {
    const parts = merchant_authorization.split(".");
    if (parts.length !== 3) {
      return "CartMandate: merchant_authorization is not a valid JWT (expected header.payload.signature)";
    }
    try {
      const pad = (s: string) =>
        s.replace(/-/g, "+").replace(/_/g, "/") +
        "==".slice(0, (4 - (s.length % 4)) % 4);
      const jwtPayload = JSON.parse(atob(pad(parts[1]))) as Record<string, unknown>;
      // exp check
      if (typeof jwtPayload.exp === "number" && Date.now() / 1000 > jwtPayload.exp) {
        return "CartMandate: merchant_authorization JWT has expired";
      }
      // nbf (not-before) check — allow 30 s clock skew
      if (typeof jwtPayload.nbf === "number" && Date.now() / 1000 < jwtPayload.nbf - 30) {
        return "CartMandate: merchant_authorization JWT is not yet valid (nbf)";
      }
      // merchant_id consistency
      if (
        contents.merchant_id &&
        typeof jwtPayload.merchant_id === "string" &&
        jwtPayload.merchant_id !== contents.merchant_id
      ) {
        return "CartMandate: merchant_authorization JWT merchant_id does not match contents";
      }
      // transaction_id consistency
      if (
        typeof jwtPayload.transaction_id === "string" &&
        jwtPayload.transaction_id !== contents.transaction_id
      ) {
        return "CartMandate: merchant_authorization JWT transaction_id does not match contents";
      }
    } catch {
      return "CartMandate: merchant_authorization JWT payload is not valid base64url JSON";
    }
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
  let signature: Uint8Array;
  try {
    signature = algosdk.signBytes(contentsBytes, sk);
  } finally {
    sk.fill(0); // XIV-1: wipe secret key after signing (always, even on error)
  }

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

  // ── Vault auto-approval: skip popup when agent key + IntentMandate available ─
  // The agent key is a standard ed25519 key that can sign AP2 credentials
  // autonomously. Auto-approval ONLY triggers when a stored IntentMandate covers
  // this cart (matching network, address, merchant restrictions, max_amount, expiry).
  // Without a matching IntentMandate the request falls through to the approval popup.
  // On any failure, fall through to the approval popup so the user can still approve.
  if (agentSignerAddr) {
    try {
      const intents = await getIntentMandates();
      const now = Date.now();
      const cartTotal = parseFloat(params.cartMandate.contents.total.value);
      const cartCurrency = params.cartMandate.contents.total.currency;
      const cartMerchantId = params.cartMandate.contents.merchant_id;

      const matchingIntent = intents.find((intent) => {
        // Must be for same network and agent address
        if (intent.network !== network || intent.address !== agentSignerAddr) return false;
        // Intent must not be expired
        if (intent.intent_expiry && new Date(intent.intent_expiry).getTime() < now) return false;
        // merchant_restrictions: if set, cartMandate's merchant_id must be in the list
        if (intent.merchant_restrictions && intent.merchant_restrictions.length > 0) {
          if (!cartMerchantId || !intent.merchant_restrictions.includes(cartMerchantId)) return false;
        }
        // max_amount: if set, cart total must not exceed intent cap (same currency only)
        if (intent.max_amount && intent.currency) {
          if (
            cartCurrency.toUpperCase() === intent.currency.toUpperCase() &&
            cartTotal > parseFloat(intent.max_amount)
          ) {
            return false;
          }
        }
        return true;
      });

      if (!matchingIntent) {
        // No IntentMandate covers this cart — require explicit user approval
        throw new Error("No matching IntentMandate for this cart");
      }

      const paymentMandate = await buildPaymentMandate({
        cartMandate: params.cartMandate,
        intentMandateId: matchingIntent.id,
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
      // Auto-sign failed or no matching IntentMandate — fall through to approval popup
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
