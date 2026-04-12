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
import { getSuggestedParams, hasOptedIn, submitTransaction, submitTransactionGroup, waitForConfirmation, waitForIndexed, getAccountState } from "./chain-clients";
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
 *
 * Billing V1: when `pr.fees` is present and non-empty, builds an atomic
 * group of N+1 transactions: txns[0] = merchant payment, txns[1..N] = fee
 * leg(s) to operator wallets. The group is assigned a common group ID via
 * algosdk.assignGroupID(). When fees is absent/empty, returns a single-tx
 * array for backwards compatibility.
 */
async function buildPaymentTransaction(req: PendingX402Request): Promise<{
  txns: algosdk.Transaction[];
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

  // Parse fee legs (Billing V1).
  const feeLegsDefs = (pr.fees ?? []).filter((f) => {
    if (!f.to || !f.amount) return false;
    if (!algosdk.isValidAddress(f.to)) return false;
    const feeAmt = BigInt(f.amount);
    // Defensive: reject fee >= gross (belt-and-braces, same as gateway)
    if (feeAmt <= 0n || feeAmt >= amount) return false;
    return true;
  });
  const totalFees = feeLegsDefs.reduce((sum, f) => sum + BigInt(f.amount), 0n);

  // Merchant-absorbs model: customer pays maxAmountRequired total, split
  // between merchant (amount - totalFees) and operator (totalFees).
  // Customer's total outflow = amount (unchanged from pre-billing behavior).
  const merchantAmount = feeLegsDefs.length > 0 ? amount - totalFees : amount;
  if (merchantAmount <= 0n) {
    throw new Error(
      `Fee (${totalFees}) exceeds or equals payment amount (${amount}). Cannot proceed.`
    );
  }

  // Respect per-user configurable spending caps from wallet settings.
  function safeCap(stored: number | undefined, defaultCap: bigint): bigint {
    if (stored === undefined || stored <= 0 || !Number.isFinite(stored)) return defaultCap;
    try { const v = BigInt(Math.floor(stored)); return v > 0n ? v : defaultCap; } catch { return defaultCap; }
  }
  const cap = asaId !== 0
    ? safeCap(meta.spendingCaps?.asaMicrounits, SPENDING_CAP_ASA)
    : safeCap(meta.spendingCaps?.nativeMicrounits, SPENDING_CAP_NATIVE);

  // Spending cap covers the customer's total outflow = maxAmountRequired.
  if (amount > cap) {
    throw new Error(
      `Payment amount ${amount} microunits exceeds safety cap of ${cap}. ` +
      `Adjust the cap in settings or reject this payment.`
    );
  }

  // Pre-flight balance check — account for all legs + per-txn network fees.
  // Customer's total value outflow = amount (merchant gets amount-fees,
  // operator gets fees, total = amount). Network fees are additional.
  const groupSize = 1 + feeLegsDefs.length;
  const perTxnFee = BigInt((params as { minFee?: number }).minFee ?? 1000);
  const totalNetworkFees = perTxnFee * BigInt(groupSize);
  const accountState = await getAccountState(senderAddress, chain);
  const spendable = accountState.balance - accountState.minBalance;
  const needed = asaId !== 0 ? totalNetworkFees : amount + totalNetworkFees;
  if (spendable < needed) {
    const ticker = CHAINS[chain].ticker;
    throw new Error(
      `Insufficient ${ticker} balance. ` +
      `Need ${needed} µ${ticker} but only ${spendable} µ${ticker} spendable ` +
      `(balance: ${accountState.balance}, min balance: ${accountState.minBalance}).`
    );
  }

  // ── Build transaction array ─────────────────────────────────────────────
  const txns: algosdk.Transaction[] = [];
  const note = new TextEncoder().encode(`x402:${req.url}`).slice(0, 1000);

  if (asaId !== 0) {
    const optedIn = await hasOptedIn(chain, senderAddress, asaId);
    if (!optedIn) {
      throw new Error(
        `Account is not opted-in to asset ${asaId}. ` +
        `Open AlgoVoi, find the asset, and opt-in before paying.`
      );
    }
    // Merchant leg (ASA): receives amount - fees
    txns.push(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: pr.payTo,
      assetIndex: asaId,
      amount: merchantAmount,
      note,
      suggestedParams: params,
    }));
    // Fee legs (same ASA): operator receives fee portion
    for (const feeDef of feeLegsDefs) {
      txns.push(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: feeDef.to,
        assetIndex: asaId,
        amount: BigInt(feeDef.amount),
        suggestedParams: params,
      }));
    }
  } else {
    // Merchant leg (native ALGO/VOI): receives amount - fees
    txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: pr.payTo,
      amount: merchantAmount,
      note,
      suggestedParams: params,
    }));
    // Fee legs (native): operator receives fee portion
    for (const feeDef of feeLegsDefs) {
      txns.push(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: feeDef.to,
        amount: BigInt(feeDef.amount),
        suggestedParams: params,
      }));
    }
  }

  // Assign atomic group ID when there are multiple legs.
  if (txns.length > 1) {
    algosdk.assignGroupID(txns);
  }

  return { txns, chain, senderAddress };
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
  const { txns, senderAddress } = await buildPaymentTransaction(req);

  const sk = await walletStore.getActiveSecretKey();
  let signedGroup: Uint8Array[];
  let txId: string;
  try {
    signedGroup = txns.map((t) => t.signTxn(sk));
    txId = txns[0].txID(); // merchant leg = the proof tx_id
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
      transaction: btoa(String.fromCharCode(...signedGroup[0])),
    },
  };
  const paymentHeader = btoa(JSON.stringify(payload));

  // Submit proactively — tx (or atomic group) is in-flight when the server verifies.
  // M2: Swallow benign duplicate/already-submitted errors; propagate real failures.
  try {
    if (signedGroup.length > 1) {
      await submitTransactionGroup(chain, signedGroup);
    } else {
      await submitTransaction(chain, signedGroup[0]);
    }
  } catch (err) {
    const errMsg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const isDuplicate = /\b(already in ledger|txn already exists|duplicate transaction|transaction already)\b/i.test(errMsg);
    if (!isDuplicate) {
      throw new Error(
        `Transaction broadcast failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Wait for algod confirmation, then poll the indexer until the transaction
  // is indexed. The indexer can lag several seconds behind algod even after
  // block confirmation — waitForIndexed eliminates the fixed-delay guesswork.
  // For atomic groups, all legs confirm in the same round — only need to wait on merchant leg.
  await waitForConfirmation(chain, txId, 8);
  await waitForIndexed(chain, txId);

  // x402 spec §4.3: if the PaymentRequirements include a facilitator URL,
  // POST the payment proof to {facilitator}/settle for settlement confirmation.
  // Non-fatal — a facilitator failure should not block the retried resource request.
  if (pr.facilitator) {
    const settlePayload = JSON.stringify({
      x402Version: X402_VERSION,
      scheme: pr.scheme,
      network: pr.network,
      payload: { txId, payer: senderAddress },
    });
    fetch(`${pr.facilitator}/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: settlePayload,
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* best-effort — log silently */ });
  }

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
  /** When an atomic group is built, this array holds all unsigned txn B64 strings. */
  unsignedTxnsB64?: string[];
  chain: ChainId;
  signerAddress: string;
  sessionTopic: string;
}> {
  const { txns, chain, senderAddress } = await buildPaymentTransaction(req);

  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (activeAccount?.type !== "walletconnect" || !activeAccount.wcSessionTopic) {
    throw new Error("Active account is not a WalletConnect account");
  }

  // Encode all txns as base64 for the WC signing request.
  const unsignedTxnsB64 = txns.map((t) => btoa(String.fromCharCode(...t.toByte())));
  // Primary txn (merchant leg) = first in the group.
  const unsignedTxnB64 = unsignedTxnsB64[0];

  // Store expected bytes on the pending request so X402_WC_SIGNED can compare.
  // For atomic groups, store the full array; legacy single-tx code can still
  // check the scalar expectedUnsignedTxnB64 field.
  req.expectedUnsignedTxnB64 = unsignedTxnB64;
  req.wcAccountId = activeAccount.id;

  return {
    unsignedTxnB64,
    unsignedTxnsB64: unsignedTxnsB64.length > 1 ? unsignedTxnsB64 : undefined,
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


// ── Sponsored checkout payment ───────────────────────────────────────────────

/**
 * Build and sign a 0-fee payment transaction for sponsored checkout.
 * The platform backend wraps this in an atomic group with a fee-covering tx.
 *
 * Returns signed tx bytes (base64) — does NOT submit (platform submits the group).
 * Spending caps are still enforced. Approval popup is shown for user consent.
 */
export async function buildSponsoredPayment(params: {
  chain: string;
  receiver: string;
  amount: string;
  assetId: string;
  memo: string;
}): Promise<{ signedTxB64: string; senderAddress: string; chain: string }> {
  const chain = resolveChain(params.chain);
  if (!chain) throw new Error(`Unsupported network: ${params.chain}`);

  if (!algosdk.isValidAddress(params.receiver)) {
    throw new Error(`Invalid receiver address: ${params.receiver}`);
  }

  const meta = await walletStore.getMeta();
  const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
  if (!senderAddress) throw new Error("No active account");

  const rawAmount = String(params.amount);
  if (!/^\d+$/.test(rawAmount)) {
    throw new Error(`Invalid payment amount: ${rawAmount}`);
  }
  const amount = BigInt(rawAmount);

  const asaId = params.assetId === "0" || !params.assetId ? 0 : parseInt(params.assetId, 10);

  // Spending cap enforcement (same as x402)
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

  // Balance check — only need the amount (no fee for sponsored tx), plus min balance
  const accountState = await getAccountState(senderAddress, chain);
  const spendable = accountState.balance - accountState.minBalance;
  const needed = asaId !== 0 ? 0n : amount; // ASA transfers don't debit native coin
  if (needed > 0n && spendable < needed) {
    const ticker = CHAINS[chain].ticker;
    throw new Error(
      `Insufficient ${ticker} balance. ` +
      `Need ${needed} µ${ticker} but only ${spendable} µ${ticker} spendable.`
    );
  }

  // Build the 0-fee transaction
  const suggestedParams = await getSuggestedParams(chain);
  suggestedParams.fee = 0;
  suggestedParams.flatFee = true;

  const note = new TextEncoder().encode(params.memo).slice(0, 1000);

  let txn: algosdk.Transaction;
  if (asaId !== 0) {
    const optedIn = await hasOptedIn(chain, senderAddress, asaId);
    if (!optedIn) {
      throw new Error(
        `Account is not opted-in to asset ${asaId}. ` +
        `Open AlgoVoi, find the asset, and opt-in before paying.`
      );
    }
    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: params.receiver,
      assetIndex: asaId,
      amount,
      note,
      suggestedParams,
    });
  } else {
    txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: senderAddress,
      receiver: params.receiver,
      amount,
      note,
      suggestedParams,
    });
  }

  // Sign with vault key (WalletConnect not supported for sponsored — needs popup flow)
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (activeAccount?.type === "walletconnect") {
    throw new Error(
      "Sponsored checkout requires a local account. " +
      "WalletConnect accounts cannot be used for sponsored payments yet."
    );
  }

  const sk = await walletStore.getActiveSecretKey();
  let signedBytes: Uint8Array;
  try {
    signedBytes = txn.signTxn(sk);
  } finally {
    sk.fill(0); // XIV-1: wipe secret key after signing
  }

  const signedTxB64 = btoa(String.fromCharCode(...signedBytes));

  return { signedTxB64, senderAddress, chain: params.chain };
}
