/**
 * MPP (Machine Payments Protocol) handler — custom "avm" payment method.
 *
 * Spec: https://mpp.dev / https://paymentauth.org
 *
 * Header protocol:
 *   402 response:  WWW-Authenticate: Payment id="...", realm="...", method="avm",
 *                    intent="charge", request="<base64url-json>"
 *   Client retry:  Authorization: Payment <base64url-json({ challenge, source, payload })>
 *
 * Responsibilities:
 *  1. Parse WWW-Authenticate: Payment header → MppChallenge + MppAvmRequest
 *  2. Queue pending MPP payment requests
 *  3. Open the approval popup (kind=mpp_charge)
 *  4. On approval: build, sign, submit AVM txn → encode MPP credential
 *  5. Return the Authorization header value to the content script for retry
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import {
  getSuggestedParams,
  hasOptedIn,
  submitTransaction,
  waitForConfirmation,
  waitForIndexed,
  getAccountState,
} from "./chain-clients";
import { APPROVAL_POPUP_WIDTH, APPROVAL_POPUP_HEIGHT, CHAINS } from "@shared/constants";
import { randomId } from "@shared/utils/crypto";
import { requestApproval } from "./approval-handler";
import type { MppChallenge, MppAvmRequest, MppCredential, PendingMppRequest } from "@shared/types/mpp";
import type { PendingMppApproval } from "@shared/types/approval";
import type { ChainId } from "@shared/types/chain";

// ── Network resolution ────────────────────────────────────────────────────────

/** Map MPP avm network string → ChainId */
export function resolveMppChain(network: string): ChainId | null {
  if (network === "algorand") return "algorand";
  if (network === "voi") return "voi";
  return null;
}

// ── base64url helpers ─────────────────────────────────────────────────────────

function decodeBase64url(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return atob(padded);
}

function encodeBase64url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ── WWW-Authenticate: Payment parser ─────────────────────────────────────────

/**
 * Parse a `WWW-Authenticate: Payment ...` header into an MppChallenge.
 * Returns null if the header does not contain a valid Payment challenge.
 *
 * The header format follows RFC 9110 §11.6.1 (WWW-Authenticate) with
 * "Payment" as the auth-scheme and auth-params as key="value" pairs.
 */
export function parseMppChallenge(headerValue: string): MppChallenge | null {
  // Locate the "Payment" scheme (case-insensitive, may be preceded by other schemes)
  const schemeMatch = headerValue.match(/(?:^|,)\s*(Payment)\s+/i);
  if (!schemeMatch) return null;

  // Extract the substring after "Payment " for param parsing
  const startIdx = (schemeMatch.index ?? 0) + schemeMatch[0].length;
  const paramStr = headerValue.slice(startIdx);

  // Parse key="value" pairs — handle escaped characters inside quoted strings
  const params: Record<string, string> = {};
  const paramRegex = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let m: RegExpExecArray | null;
  while ((m = paramRegex.exec(paramStr)) !== null) {
    const key = m[1];
    // Quoted value: unescape \X sequences. Unquoted value: take as-is.
    const value = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
    params[key] = value;
  }

  // Validate required fields
  if (!params["id"] || !params["realm"] || !params["method"] || !params["intent"] || !params["request"]) {
    return null;
  }

  return {
    id: params["id"],
    realm: params["realm"],
    method: params["method"],
    intent: params["intent"],
    request: params["request"],
    expires: params["expires"],
    digest: params["digest"],
    description: params["description"],
    opaque: params["opaque"],
  };
}

/**
 * Decode the base64url `request` field of an MPP avm challenge.
 * Returns null if the request is not a valid MppAvmRequest.
 */
export function decodeMppAvmRequest(requestB64url: string): MppAvmRequest | null {
  try {
    const json = decodeBase64url(requestB64url);
    const parsed = JSON.parse(json) as Partial<MppAvmRequest>;
    if (
      typeof parsed.amount !== "string" ||
      typeof parsed.currency !== "string" ||
      typeof parsed.recipient !== "string" ||
      typeof parsed.network !== "string"
    ) {
      return null;
    }
    return parsed as MppAvmRequest;
  } catch {
    return null;
  }
}

// ── Credential serialization ──────────────────────────────────────────────────

/**
 * Encode an MppCredential as the value for the Authorization: Payment header.
 * Returns: "Payment <base64url-no-padding(JSON)>"
 */
export function serializeMppCredential(credential: MppCredential): string {
  const json = JSON.stringify(credential);
  return `Payment ${encodeBase64url(json)}`;
}

// ── Pending request queue ─────────────────────────────────────────────────────

const _pendingMppRequests = new Map<string, PendingMppRequest>();

export function getPendingMppRequest(id: string): PendingMppRequest | null {
  return _pendingMppRequests.get(id) ?? null;
}

export function clearPendingMppRequest(id: string): void {
  _pendingMppRequests.delete(id);
}

// ── Approval popup ────────────────────────────────────────────────────────────

async function openMppApprovalPopup(requestId: string): Promise<void> {
  const url =
    chrome.runtime.getURL("src/approval/index.html") +
    `?requestId=${requestId}&kind=mpp_charge`;
  await chrome.windows.create({
    url,
    type: "popup",
    width: APPROVAL_POPUP_WIDTH,
    height: APPROVAL_POPUP_HEIGHT,
    focused: true,
  });
}

/** Build the currency display label from an MppAvmRequest */
function currencyLabel(avmReq: MppAvmRequest): string {
  const c = avmReq.currency.toUpperCase();
  if (c === "ALGO" || c === "VOI" || avmReq.currency === "0") return c === "0" ? "Native" : c;
  return `ASA ${avmReq.currency}`;
}

// ── Payment construction ──────────────────────────────────────────────────────

/**
 * Safety caps for automatic MPP avm payments.
 * Mirrors the caps used by x402-handler for consistency.
 */
const SPENDING_CAP_NATIVE = 10_000_000n; // 10 ALGO/VOI
const SPENDING_CAP_ASA    = 10_000_000n; // 10 USDC/aUSDC

/**
 * Build, sign (vault key), submit, and encode an MPP avm charge payment.
 * Returns the full `Authorization: Payment <base64url>` header value.
 */
export async function buildAndSignMppPayment(
  req: PendingMppRequest
): Promise<{ authorizationHeader: string; txId: string }> {
  const avmReq = req.avmRequest;

  const chain = resolveMppChain(avmReq.network);
  if (!chain) throw new Error(`Unsupported MPP avm network: ${avmReq.network}`);

  if (!algosdk.isValidAddress(avmReq.recipient)) {
    throw new Error(`Invalid MPP payment recipient address: ${avmReq.recipient}`);
  }

  // Validate amount — must be a non-negative integer string
  if (!/^\d+$/.test(avmReq.amount)) {
    throw new Error(`Invalid MPP payment amount: "${avmReq.amount}" (expected integer string)`);
  }
  const amount = BigInt(avmReq.amount);
  if (amount <= 0n) {
    throw new Error(`Invalid MPP payment amount: ${avmReq.amount} (must be positive)`);
  }

  // Resolve asset ID — "ALGO", "VOI", or numeric ASA ID
  const currencyUpper = avmReq.currency.toUpperCase();
  const asaId =
    currencyUpper === "ALGO" || currencyUpper === "VOI" || avmReq.currency === "0"
      ? 0
      : parseInt(avmReq.currency, 10);

  if (asaId !== 0 && isNaN(asaId)) {
    throw new Error(`Invalid MPP currency: ${avmReq.currency}`);
  }

  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");

  if (activeAccount.type === "walletconnect") {
    throw new Error(
      "WalletConnect accounts cannot auto-pay MPP charges. " +
      "Switch to a vault account or use a mnemonic-backed account."
    );
  }

  // Spending cap check
  const cap =
    asaId !== 0
      ? meta.spendingCaps?.asaMicrounits !== undefined
        ? BigInt(meta.spendingCaps.asaMicrounits)
        : SPENDING_CAP_ASA
      : meta.spendingCaps?.nativeMicrounits !== undefined
      ? BigInt(meta.spendingCaps.nativeMicrounits)
      : SPENDING_CAP_NATIVE;

  if (amount > cap) {
    throw new Error(
      `MPP payment amount ${amount} µ exceeds safety cap of ${cap} µ. ` +
      `Adjust the cap in settings or reject this payment.`
    );
  }

  const params = await getSuggestedParams(chain);

  // Pre-flight balance check
  const fee = BigInt((params as { minFee?: number }).minFee ?? 1000);
  const accountState = await getAccountState(activeAccount.address, chain);
  const spendable = accountState.balance - accountState.minBalance;
  const needed = asaId !== 0 ? fee : amount + fee;
  const ticker = CHAINS[chain].ticker;
  if (spendable < needed) {
    throw new Error(
      `Insufficient ${ticker} balance for MPP payment. ` +
      `Need ${needed} µ${ticker} but only ${spendable} µ${ticker} spendable ` +
      `(balance: ${accountState.balance}, min balance: ${accountState.minBalance}).`
    );
  }

  // Build transaction
  const noteText = `mpp:${req.challenge.realm}`.slice(0, 980);
  const note = new TextEncoder().encode(noteText);
  let txn: algosdk.Transaction;

  if (asaId !== 0) {
    const optedIn = await hasOptedIn(chain, activeAccount.address, asaId);
    if (!optedIn) {
      throw new Error(
        `Account is not opted-in to asset ${asaId}. ` +
        `Open AlgoVoi, find the asset, and opt-in before paying.`
      );
    }
    txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: activeAccount.address,
      receiver: avmReq.recipient,
      assetIndex: asaId,
      amount,
      note,
      suggestedParams: params,
    });
  } else {
    txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: activeAccount.address,
      receiver: avmReq.recipient,
      amount,
      note,
      suggestedParams: params,
    });
  }

  // Sign, submit, wait for confirmation
  const sk = await walletStore.getActiveSecretKey();
  const signedBytes = txn.signTxn(sk);
  const txId = txn.txID();

  try {
    await submitTransaction(chain, signedBytes);
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const isDuplicate =
      msg.includes("already") ||
      msg.includes("duplicate") ||
      msg.includes("already in ledger") ||
      msg.includes("txn already exists");
    if (!isDuplicate) {
      throw new Error(
        `MPP transaction broadcast failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  await waitForConfirmation(chain, txId, 8);
  await waitForIndexed(chain, txId);

  // Build and encode the MPP credential
  const credential: MppCredential = {
    challenge: req.challenge,
    source: `did:pkh:avm:${avmReq.network}:${activeAccount.address}`,
    payload: {
      txId,
      transaction: btoa(String.fromCharCode(...signedBytes)),
    },
  };

  return {
    authorizationHeader: serializeMppCredential(credential),
    txId,
  };
}

// ── Main entry: handle an incoming MPP 402 ───────────────────────────────────

/**
 * Called by the message handler when the content script reports an MPP 402.
 * Parses the WWW-Authenticate header, validates the avm method, queues the
 * request, and opens the approval popup.
 */
export async function handleMpp(params: {
  tabId: number;
  url: string;
  method: string;
  /** Raw value of the WWW-Authenticate header */
  rawChallenge: string;
  /** requestId from the inpage script (for MPP_RESULT routing) */
  inpageRequestId?: string;
}): Promise<string> {
  const challenge = parseMppChallenge(params.rawChallenge);
  if (!challenge) {
    throw new Error("Failed to parse MPP WWW-Authenticate: Payment header");
  }

  if (challenge.method !== "avm") {
    throw new Error(
      `AlgoVoi only handles MPP method "avm", got "${challenge.method}". ` +
      `Other MPP payment methods (tempo, stripe, lightning) are not supported.`
    );
  }

  if (challenge.intent !== "charge") {
    throw new Error(
      `AlgoVoi only handles MPP intent "charge", got "${challenge.intent}".`
    );
  }

  const avmRequest = decodeMppAvmRequest(challenge.request);
  if (!avmRequest) {
    throw new Error("Failed to decode MPP avm payment request parameters");
  }

  const chain = resolveMppChain(avmRequest.network);
  if (!chain) {
    throw new Error(
      `Unsupported MPP avm network: "${avmRequest.network}". ` +
      `Supported: "algorand", "voi".`
    );
  }

  // Challenge expiry check
  if (challenge.expires) {
    const expiresAt = new Date(challenge.expires).getTime();
    if (!isNaN(expiresAt) && Date.now() > expiresAt) {
      throw new Error("MPP payment challenge has expired");
    }
  }

  // Per-origin queue cap (mirrors x402-handler)
  const PENDING_CAP_PER_ORIGIN = 5;
  let requestOrigin: string;
  try {
    const tab = await chrome.tabs.get(params.tabId);
    requestOrigin = tab.url ? new URL(tab.url).origin : new URL(params.url).origin;
  } catch {
    try { requestOrigin = new URL(params.url).origin; } catch { requestOrigin = "unknown"; }
  }
  let originPendingCount = 0;
  for (const req of _pendingMppRequests.values()) {
    if ((req.tabOrigin ?? "") === requestOrigin) originPendingCount++;
  }
  if (originPendingCount >= PENDING_CAP_PER_ORIGIN) {
    throw new Error(
      `Too many pending MPP payment requests from ${requestOrigin}. ` +
      `Complete or reject existing requests before initiating new ones.`
    );
  }

  const requestId = randomId();
  const pending: PendingMppRequest = {
    id: requestId,
    tabId: params.tabId,
    url: params.url,
    method: params.method,
    challenge,
    avmRequest,
    timestamp: Date.now(),
    tabOrigin: requestOrigin,
    inpageRequestId: params.inpageRequestId,
    rawChallenge: params.rawChallenge,
  };
  _pendingMppRequests.set(requestId, pending);

  // Queue a PendingMppApproval in the unified approval handler so the popup
  // can retrieve display details via APPROVAL_GET_PENDING / MPP_GET_PENDING.
  const mppApproval: PendingMppApproval = {
    kind: "mpp_charge",
    id: requestId,
    url: params.url,
    realm: challenge.realm,
    challengeId: challenge.id,
    description: challenge.description ?? avmRequest.description,
    recipient: avmRequest.recipient,
    amount: avmRequest.amount,
    network: avmRequest.network,
    currencyLabel: currencyLabel(avmRequest),
    decimals: avmRequest.decimals ?? 6,
    timestamp: Date.now(),
  };
  // requestApproval opens the popup and waits for user action; we fire-and-forget
  // here because the popup sends MPP_APPROVE / MPP_REJECT independently.
  requestApproval(mppApproval).catch(() => {
    // User rejected or TTL fired — clean up the pending request
    _pendingMppRequests.delete(requestId);
  });

  await openMppApprovalPopup(requestId);
  return requestId;
}
