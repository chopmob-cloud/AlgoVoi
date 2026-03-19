/**
 * Type-safe Chrome runtime message bus.
 *
 * Flow:
 *   inpage  ←→  content  (window.postMessage, custom events)
 *   content ←→  background (chrome.runtime.sendMessage)
 *   approval ←→ background (chrome.runtime.sendMessage)
 */

import type { Account, WalletMeta, LockState } from "./wallet";
import type { ChainId, AccountState } from "./chain";
import type { PaymentRequirements, PendingX402Request, PaymentRecord } from "./x402";
import type { PendingMppRequest } from "./mpp";
import type { PendingApproval } from "./approval";
import type { CartMandate, IntentMandate, PaymentMandate, PendingAp2Approval } from "./ap2";

// ── Window message types (inpage ↔ content) ──────────────────────────────────

export interface InpageMessage {
  source: "algovou-inpage";
  type: string;
  id: string; // correlation id
  payload: unknown;
}

export interface ContentMessage {
  source: "algovou-content";
  type: string;
  id: string;
  payload: unknown;
}

// ── Chrome runtime message types (content/popup ↔ background) ───────────────

export type BgRequest =
  // Wallet lifecycle
  | { type: "WALLET_STATE" }
  | { type: "WALLET_INIT"; password: string; mnemonic?: string | null }
  | { type: "WALLET_UNLOCK"; password: string }
  | { type: "WALLET_LOCK" }
  | { type: "WALLET_CREATE_ACCOUNT"; name: string }
  | { type: "WALLET_IMPORT_ACCOUNT"; name: string; mnemonic: string }
  | { type: "WALLET_REMOVE_ACCOUNT"; id: string }
  | { type: "WALLET_RENAME_ACCOUNT"; id: string; name: string }
  | { type: "WALLET_SET_ACTIVE_ACCOUNT"; id: string }
  | { type: "WALLET_SET_CHAIN"; chain: ChainId }
  | { type: "WALLET_GET_META" }
  // Account on-chain state
  | { type: "CHAIN_GET_ACCOUNT_STATE"; address: string; chain: ChainId }
  | { type: "CHAIN_GET_ASSET_INFO"; assetId: number; chain: ChainId }
  // Native coin send
  | { type: "CHAIN_SEND_PAYMENT"; to: string; amount: string; chain: ChainId; note?: string }
  // ASA token send (mnemonic path; WalletConnect uses CHAIN_SUBMIT_SIGNED)
  | { type: "CHAIN_SEND_ASSET"; to: string; amount: string; assetId: number; decimals: number; chain: ChainId; note?: string }
  // Submit an already-signed transaction (used by WalletConnect flow where popup signs)
  | { type: "CHAIN_SUBMIT_SIGNED"; signedTxn: string; chain: ChainId }
  // Add a WalletConnect-linked account (no mnemonic stored)
  | { type: "WC_ADD_ACCOUNT"; name: string; address: string; sessionTopic: string; peerName: string; chain?: ChainId }
  // ARC-0027 dApp connector
  | { type: "ARC27_ENABLE"; origin: string; accounts?: string[] }
  | { type: "ARC27_SIGN_TXNS"; origin: string; txns: string[]; indexesToSign?: number[] }
  | { type: "ARC27_SIGN_BYTES"; origin: string; data: string; signer: string }
  | { type: "ARC27_DISCONNECT"; origin: string }
  // x402 payments
  | { type: "X402_PAYMENT_NEEDED"; requestId: string; paymentRequirements: PaymentRequirements; url: string; method: string; tabId: number }
  | { type: "X402_GET_PENDING"; requestId: string }
  | { type: "X402_APPROVE"; requestId: string }
  | { type: "X402_REJECT"; requestId: string }
  | { type: "X402_GET_HISTORY" }
  /** Sent by the approval popup after the user approved signing in their WC wallet */
  | { type: "X402_WC_SIGNED"; requestId: string; signedTxnB64: string }
  // MPP avm payments
  | { type: "MPP_PAYMENT_NEEDED"; requestId: string; rawChallenge: string; url: string; method: string; tabId: number }
  | { type: "MPP_GET_PENDING"; requestId: string }
  | { type: "MPP_APPROVE"; requestId: string }
  | { type: "MPP_REJECT"; requestId: string }
  // enVoi name resolution via UluMCP (Voi only)
  | { type: "VOI_RESOLVE_NAME"; name: string }
  // Unified approval flow (sign_txns, sign_bytes, envoi_payment)
  | { type: "APPROVAL_GET_PENDING"; requestId: string }
  | { type: "APPROVAL_APPROVE";     requestId: string }
  | { type: "APPROVAL_REJECT";      requestId: string }
  // AP2 credential signing (Agent Payments Protocol)
  | { type: "AP2_PAYMENT_REQUEST"; requestId: string; cartMandate: CartMandate; url: string; tabId: number }
  | { type: "AP2_GET_PENDING"; requestId: string }
  | { type: "AP2_APPROVE"; requestId: string }
  | { type: "AP2_REJECT"; requestId: string }
  | { type: "AP2_LIST_INTENT_MANDATES" };

export type BgResponse<T extends BgRequest["type"] = BgRequest["type"]> =
  T extends "WALLET_STATE" ? { lockState: LockState; meta: WalletMeta | null } :
  T extends "WALLET_GET_META" ? { meta: WalletMeta } :
  T extends "WALLET_INIT" ? { success: boolean; error?: string } :
  T extends "WALLET_UNLOCK" ? { success: boolean; error?: string } :
  T extends "WALLET_LOCK" ? { success: boolean } :
  T extends "WALLET_CREATE_ACCOUNT" ? { account: Account } :
  T extends "WALLET_IMPORT_ACCOUNT" ? { account: Account; error?: string } :
  T extends "CHAIN_GET_ACCOUNT_STATE" ? { state: AccountState | null; error?: string } :
  T extends "CHAIN_SEND_PAYMENT" ? { txId: string } :
  T extends "CHAIN_SEND_ASSET" ? { txId: string } :
  T extends "CHAIN_SUBMIT_SIGNED" ? { txId: string } :
  T extends "WC_ADD_ACCOUNT" ? { account: Account } :
  T extends "ARC27_ENABLE" ? { accounts: string[]; error?: string } :
  T extends "ARC27_SIGN_TXNS" ? { stxns: string[]; error?: string } :
  T extends "ARC27_SIGN_BYTES" ? { sig: string; error?: string } :
  T extends "X402_GET_PENDING" ? { request: PendingX402Request | null } :
  T extends "X402_APPROVE" ?
    | { paymentHeader: string; txId: string }
    | { needsWcSign: true; unsignedTxnB64: string; chain: ChainId; sessionTopic: string; signerAddress: string } :
  T extends "X402_REJECT" ? { success: boolean } :
  T extends "X402_GET_HISTORY" ? { records: PaymentRecord[] } :
  T extends "X402_WC_SIGNED" ? { paymentHeader: string; txId?: string } :
  T extends "MPP_GET_PENDING" ? { request: PendingMppRequest | null } :
  T extends "MPP_APPROVE" ? { authorizationHeader: string; txId: string } :
  T extends "MPP_REJECT" ? { success: boolean } :
  T extends "VOI_RESOLVE_NAME" ? { address: string; displayName: string } :
  T extends "APPROVAL_GET_PENDING" ? { approval: PendingApproval | null } :
  T extends "APPROVAL_APPROVE"     ? { success: boolean } :
  T extends "APPROVAL_REJECT"      ? { success: boolean } :
  T extends "AP2_GET_PENDING" ? { request: PendingAp2Approval | null } :
  T extends "AP2_APPROVE" ? { paymentMandate: PaymentMandate } :
  T extends "AP2_REJECT" ? { success: boolean } :
  T extends "AP2_PAYMENT_REQUEST" ? { requestId: string } :
  // IntentMandate management (used by popup)
  T extends "AP2_LIST_INTENT_MANDATES" ? { mandates: IntentMandate[] } :
  { success: boolean; error?: string };

// Notification pushed from background to content/tabs
export type BgNotification =
  | { type: "ACCOUNT_CHANGED"; accounts: string[] }
  | { type: "CHAIN_CHANGED"; chain: ChainId }
  | { type: "LOCK_STATE_CHANGED"; lockState: LockState }
  | { type: "X402_RESULT"; requestId: string; approved: boolean; paymentHeader?: string; error?: string }
  | { type: "MPP_RESULT"; requestId: string; approved: boolean; authorizationHeader?: string; error?: string }
  | { type: "AP2_RESULT"; requestId: string; approved: boolean; paymentMandate?: PaymentMandate; error?: string };
