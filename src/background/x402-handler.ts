/**
 * x402 HTTP Payment Protocol handler.
 *
 * Spec: github.com/coinbase/x402
 *
 * Header protocol (v1):
 *   402 response  →  PAYMENT-REQUIRED:  base64(PaymentRequired JSON)
 *   Client retry  →  PAYMENT-SIGNATURE: base64(X402PaymentPayload JSON)
 *
 * AVM payment payload (analogous to EVM EIP-3009):
 *   { x402Version: 1, scheme: "exact", network: "algorand-mainnet" | "voi-mainnet",
 *     payload: { transaction: base64(signed algosdk msgpack) } }
 *
 * Responsibilities:
 *  1. Parse PAYMENT-REQUIRED header → PaymentRequired → picks AVM-compatible accepts[] option
 *  2. Queue pending payment requests
 *  3. Open the approval popup
 *  4. On approval: build, sign, encode the AVM payment transaction
 *  5. Return the PAYMENT-SIGNATURE value to the content script for retry
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getSuggestedParams, hasOptedIn, submitTransaction, waitForConfirmation, waitForIndexed, getAccountState } from "./chain-clients";
import { X402_VERSION, APPROVAL_POPUP_WIDTH, APPROVAL_POPUP_HEIGHT, CHAINS } from "@shared/constants";
import { randomId } from "@shared/utils/crypto";
import type {
  PaymentRequired,
  PaymentRequirements,
  PendingX402Request,
  X402PaymentPayload,
} from "@shared/types/x402";
import type { ChainId } from "@shared/types/chain";

// ── AVM network identifiers ───────────────────────────────────────────────────

/** All network strings that map to Algorand mainnet */
const ALGORAND_NETWORKS = new Set([
  "algorand-mainnet",       // coinbase/x402 spec (hyphen)
  "algorand_mainnet",       // AlgoVoi platform gateway (underscore)
  "algorand:mainnet-v1.0",  // CAIP-2
  "algorand",               // MPP payment method identifier (chopmob-cloud/mpp)
]);
/** All network strings that map to Voi mainnet */
const VOI_NETWORKS = new Set([
  "voi-mainnet",            // coinbase/x402 spec (hyphen)
  "voi_mainnet",            // AlgoVoi platform gateway (underscore)
  "voi:voimain-v1.0",       // CAIP-2
  "voi",                    // MPP payment method identifier (chopmob-cloud/mpp)
]);

export function resolveChain(network: string): ChainId | null {
  if (ALGORAND_NETWORKS.has(network)) return "algorand";
  if (VOI_NETWORKS.has(network)) return "voi";
  return null;
}

// ── Pending request queue ─────────────────────────────────────────────────────

const _pendingRequests = new Map<string, PendingX402Request>();

export function getPendingRequest(id: string): PendingX402Request | null {
  return _pendingRequests.get(id) ?? null;
}

export function clearPendingRequest(id: string): void {
  _pendingRequests.delete(id);
}

// ── Parse PAYMENT-REQUIRED header ────────────────────────────────────────────

/**
 * Decode the PAYMENT-REQUIRED header value (base64 JSON) into a PaymentRequired object.
 * Per spec: PAYMENT-REQUIRED = base64(JSON.stringify({ x402Version, error, accepts: [] }))
 */
export function parsePaymentRequired(base64Value: string): PaymentRequired | null {
  try {
    const json = atob(base64Value);
    const parsed = JSON.parse(json) as Partial<PaymentRequired> & Partial<PaymentRequirements>;
    // Support both v1 spec (accepts array) and bare PaymentRequirements (legacy)
    if (Array.isArray(parsed.accepts)) {
      return parsed as PaymentRequired;
    }
    // Legacy / non-spec: the header IS the PaymentRequirements directly
    if (parsed.scheme && parsed.network) {
      return {
        x402Version: 1,
        error: "Payment required",
        accepts: [parsed as unknown as PaymentRequirements],
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pick the best AVM-compatible PaymentRequirements from an accepts[] array.
 * Prefers Algorand over Voi if the active chain is Algorand, and vice versa.
 */
export function pickAVMOption(
  accepts: PaymentRequirements[],
  preferredChain?: ChainId
): PaymentRequirements | null {
  const avmOptions = accepts.filter((opt) => resolveChain(opt.network) !== null);
  if (avmOptions.length === 0) return null;
  if (!preferredChain) return avmOptions[0];
  // Prefer the active chain
  return (
    avmOptions.find((opt) => resolveChain(opt.network) === preferredChain) ??
    avmOptions[0]
  );
}

// ── Approval popup ────────────────────────────────────────────────────────────

async function openApprovalPopup(requestId: string): Promise<void> {
  const url = chrome.runtime.getURL("src/approval/index.html") + `?requestId=${requestId}`;
  await chrome.windows.create({
    url,
    type: "popup",
    width: APPROVAL_POPUP_WIDTH,
    height: APPROVAL_POPUP_HEIGHT,
    focused: true,
  });
}

// ── Payment construction ──────────────────────────────────────────────────────

/**
 * Safety caps for automatic x402 payments.
 * 10 ALGO/VOI  = 10_000_000 microunits (native coin, 6 decimals)
 * 10 USDC/aUSDC = 10_000_000 micro-units (ASA, 6 decimals)
 */
const SPENDING_CAP_NATIVE = 10_000_000n;
const SPENDING_CAP_ASA    = 10_000_000n;

/**
 * Shared validation + unsigned transaction builder.
 * Called by both vault signing and WalletConnect signing paths.
 */
async function buildPaymentTransaction(req: PendingX402Request): Promise<{
  txn: algosdk.Transaction;
  chain: ChainId;
  senderAddress: string;
}> {
  const pr = req.paymentRequirements;

  const chain = resolveChain(pr.network);
  if (!chain) throw new Error(`Unsupported x402 network: ${pr.network}`);

  if (!algosdk.isValidAddress(pr.payTo)) {
    throw new Error(`Invalid payment recipient address: ${pr.payTo}`);
  }

  const meta = await walletStore.getMeta();
  const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
  if (!senderAddress) throw new Error("No active account");

  const params = await getSuggestedParams(chain);

  const rawAmount = String(pr.maxAmountRequired);
  if (!/^\d+$/.test(rawAmount)) {
    throw new Error(`Invalid payment amount: ${rawAmount}`);
  }
  const amount = BigInt(rawAmount);

  const asaId = pr.asset === "0" || !pr.asset ? 0 : parseInt(pr.asset, 10);

  // Respect per-user configurable spending caps from wallet settings.
  // Validate cap values defensively: if stored value is missing, zero, or non-positive
  // fall back to the hardcoded default rather than allowing unbounded spending.
  function safeCap(stored: number | undefined, defaultCap: bigint): bigint {
    if (stored === undefined || stored <= 0 || !Number.isFinite(stored)) return defaultCap;
    try { const v = BigInt(Math.floor(stored)); return v > 0n ? v : defaultCap; } catch { return defaultCap; }
  }
  const cap = asaId !== 0
    ? safeCap(meta.spendingCaps?.asaMicrounits, SPENDING_CAP_ASA)
    : safeCap(meta.spendingCaps?.nativeMicrounits, SPENDING_CAP_NATIVE);

  if (amount > cap) {
    throw new Error(
      `Payment amount ${amount} microunits exceeds safety cap of ${cap}. ` +
      `Adjust the cap in settings or reject this payment.`
    );
  }

  // Pre-flight balance check — surface a clear error before the node rejects.
  // Fee is typically 1000 µ for a simple txn; use minFee from params if available.
  const fee = BigInt((params as { minFee?: number }).minFee ?? 1000);
  const accountState = await getAccountState(senderAddress, chain);
  const spendable = accountState.balance - accountState.minBalance;
  const needed = asaId !== 0 ? fee : amount + fee;
  if (spendable < needed) {
    const ticker = CHAINS[chain].ticker;
    throw new Error(
      `Insufficient ${ticker} balance. ` +
      `Need ${needed} µ${ticker} but only ${spendable} µ${ticker} spendable ` +
      `(balance: ${accountState.balance}, min balance: ${accountState.minBalance}).`
    );
  }

  let txn: algosdk.Transaction;

  if (asaId !== 0) {
    const optedIn = await hasOptedIn(chain, senderAddress, asaId);
    if (!optedIn) {
      throw new Error(
        `Account is not opted-in to asset ${asaId}. ` +
        `Open AlgoVoi, find the asset, and opt-in before paying.`
      );
    }
    // Encode to UTF-8 bytes first, then slice — prevents splitting multi-byte characters.
    const note = new TextEncoder().encode(`x402:${req.url}`).slice(0, 1000);
    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: pr.payTo,
      assetIndex: asaId,
      amount,
      note,
      suggestedParams: params,
    });
  } else {
    const note = new TextEncoder().encode(`x402:${req.url}`).slice(0, 1000);
    txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: pr.payTo,
      amount,
      note,
      suggestedParams: params,
    });
  }

  return { txn, chain, senderAddress };
}

/**
 * Build, sign (vault key), and encode the AVM x402 payment.
 * Used when the active account is a mnemonic/vault account.
 *
 * The PAYMENT-SIGNATURE payload includes:
 *   - txId:  the submitted transaction ID (production proof)
 *   - payer: the sender address
 *   - transaction: legacy base64 signed bytes (compat; remove after server migration)
 */
export async function buildAndSignPayment(
  req: PendingX402Request
): Promise<{ paymentHeader: string; txId: string }> {
  const pr    = req.paymentRequirements;
  const chain = resolveChain(pr.network);
  if (!chain) throw new Error(`Unsupported x402 network: ${pr.network}`);

  const asaId  = pr.asset === "0" || !pr.asset ? 0 : parseInt(pr.asset, 10);
  const amount = BigInt(String(pr.maxAmountRequired));

  // Vault auto-pay disabled for x402 — x402 servers expect standard Payment/
  // AssetTransfer transactions, not application calls with inner transactions.

  // ── Standard owner key path ──────────────────────────────────────────────
  const { txn, senderAddress } = await buildPaymentTransaction(req);

  const sk = await walletStore.getActiveSecretKey();
  let signedBytes: Uint8Array;
  let txId: string;
  try {
    signedBytes = txn.signTxn(sk);
    txId = txn.txID();
  } finally {
    sk.fill(0); // XIV-1: wipe secret key after signing (always, even on error)
  }

  const payload: X402PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: pr.scheme,
    network: pr.network,
    payload: {
      txId,
      payer: senderAddress,
      // Included during rollout for backward compat with pre-production servers.
      // Remove once all servers verify via txId only.
      transaction: btoa(String.fromCharCode(...signedBytes)),
    },
  };
  const paymentHeader = btoa(JSON.stringify(payload));

  // Submit proactively — tx is in-flight when the server verifies.
  // M2: Swallow benign duplicate/already-submitted errors; propagate real failures.
  try {
    await submitTransaction(chain, signedBytes);
  } catch (err) {
    const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    // Use anchored patterns to avoid matching unrelated errors that happen to
    // contain these substrings (e.g. "This is already the best transaction").
    const isDuplicate = /\b(already in ledger|txn already exists|duplicate transaction|transaction already)\b/i.test(errMsg);
    if (!isDuplicate) {
      throw new Error(
        `Transaction broadcast failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Duplicate/already-submitted is expected for retried x402 payments — not an error.
  }

  // Wait for algod confirmation, then poll the indexer until the transaction
  // is indexed. The indexer can lag several seconds behind algod even after
  // block confirmation — waitForIndexed eliminates the fixed-delay guesswork.
  await waitForConfirmation(chain, txId, 8);
  await waitForIndexed(chain, txId);

  return { paymentHeader, txId };
}

/**
 * Build the unsigned payment transaction for a WalletConnect account.
 * Returns base64 unsigned txn bytes + the WC session details the approval
 * popup needs to route the signing request to Defly / Pera.
 *
 * Does NOT sign or submit — the approval popup calls signTransactionWithWC()
 * and then sends X402_WC_SIGNED back to the background.
 */
export async function buildPaymentTxnForWC(req: PendingX402Request): Promise<{
  unsignedTxnB64: string;
  chain: ChainId;
  signerAddress: string;
  sessionTopic: string;
}> {
  const { txn, chain, senderAddress } = await buildPaymentTransaction(req);

  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (activeAccount?.type !== "walletconnect" || !activeAccount.wcSessionTopic) {
    throw new Error("Active account is not a WalletConnect account");
  }

  const txnBytes = txn.toByte();
  const unsignedTxnB64 = btoa(String.fromCharCode(...txnBytes));

  // Store expected bytes on the pending request so X402_WC_SIGNED can compare
  // the unsigned txn extracted from the signed bytes against what we built.
  req.expectedUnsignedTxnB64 = unsignedTxnB64;
  // Store the account ID so X402_WC_SIGNED can assert the active account hasn't
  // changed between the WC signing request and the signed-result callback.
  req.wcAccountId = activeAccount.id;

  return {
    unsignedTxnB64,
    chain,
    signerAddress: senderAddress,
    sessionTopic: activeAccount.wcSessionTopic,
  };
}

// ── Main entry: handle an incoming 402 ───────────────────────────────────────

/**
 * Called by the message handler when the content script reports a 402.
 * Parses the PAYMENT-REQUIRED header, picks the best AVM option from
 * the accepts[] array, queues the request, and opens the approval popup.
 * Returns the requestId that ties the approval popup back to this request.
 */
export async function handleX402(params: {
  tabId: number;
  url: string;
  method: string;
  /** Raw base64 value of the PAYMENT-REQUIRED header */
  rawPaymentRequired: string;
  /**
   * The requestId already generated by the inpage script.
   * When provided, we reuse it so that X402_RESULT is sent back with the
   * same key that _pendingX402 in the inpage was stored under.
   * Without this, the inpage can never resolve the pending fetch promise.
   */
  inpageRequestId?: string;
}): Promise<string> {
  const paymentRequired = parsePaymentRequired(params.rawPaymentRequired);
  if (!paymentRequired) {
    throw new Error("Failed to parse PAYMENT-REQUIRED header");
  }

  // Get the user's active chain preference for option selection
  const meta = await walletStore.getMeta();
  const preferredChain = meta.activeChain as ChainId;

  const chosen = pickAVMOption(paymentRequired.accepts, preferredChain);
  if (!chosen) {
    throw new Error(
      `AlgoVoi does not support any of the payment options offered by this server. ` +
      `Supported: algorand-mainnet, voi-mainnet. ` +
      `Offered: ${paymentRequired.accepts.map((a) => a.network).join(", ")}`
    );
  }

  // H3: Per-origin queue cap — prevents a site from flooding the approval queue.
  const PENDING_CAP_PER_ORIGIN = 5;
  // M1: Derive the request origin from the Chrome-provided tab URL (unforgeable),
  // not from params.url which is controlled by the inpage script.  An attacker could
  // set params.url = "https://trusted.com/foo" to count their requests against
  // trusted.com's cap, starving it, or to bypass their own cap entirely.
  // chrome.tabs.get(tabId) returns the real URL that Chrome navigated to.
  let requestOrigin: string;
  try {
    const tab = await chrome.tabs.get(params.tabId);
    requestOrigin = tab.url ? new URL(tab.url).origin : new URL(params.url).origin;
  } catch {
    // Tab closed or no tabs permission; fall back to inpage URL as a best-effort.
    try {
      requestOrigin = new URL(params.url).origin;
    } catch {
      requestOrigin = "unknown";
    }
  }
  let originPendingCount = 0;
  for (const req of _pendingRequests.values()) {
    // Prefer the stored tabOrigin (Chrome-verified); fall back to URL-derived origin
    // for requests created before this field was introduced.
    const storedOrigin = req.tabOrigin ?? (() => {
      try { return new URL(req.url).origin; } catch { return null; }
    })();
    if (storedOrigin === requestOrigin) originPendingCount++;
  }
  if (originPendingCount >= PENDING_CAP_PER_ORIGIN) {
    throw new Error(
      `Too many pending payment requests from ${requestOrigin}. ` +
      `Complete or reject existing requests before initiating new ones.`
    );
  }

  // Always generate our own internal ID — never trust the inpage-controlled value as a map key.
  const requestId = randomId();
  const pending: PendingX402Request = {
    id: requestId,
    tabId: params.tabId,
    url: params.url,
    method: params.method,
    headers: {},
    paymentRequirements: chosen,
    allRequirements: paymentRequired.accepts,
    timestamp: Date.now(),
    // M1: Store the Chrome-verified origin so the cap counter uses it on subsequent requests.
    tabOrigin: requestOrigin,
    // Store inpage-provided ID for tab routing only (see X402_RESULT in message-handler).
    inpageRequestId: params.inpageRequestId,
    // Validated above via parsePaymentRequired(); stored verbatim so it can be
    // echoed as the PAYMENT-REQUIRED header on retry for server-side correlation.
    rawPaymentRequired: params.rawPaymentRequired,
  };

  // ── Standard approval popup path ─────────────────────────────────────────
  _pendingRequests.set(requestId, pending);
  await openApprovalPopup(requestId);
  return requestId;
}
