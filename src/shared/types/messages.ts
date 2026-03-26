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
import type { PendingMppApproval } from "./approval";
import type { PendingApproval } from "./approval";
import type { CartMandate, IntentMandate, PaymentMandate, PendingAp2Approval } from "./ap2";
import type { PendingAgentSignRequest } from "./agent";

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
  /** Sent by the approval popup after WC wallet signed the MPP payment txn */
  | { type: "MPP_WC_SIGNED"; requestId: string; signedTxnB64: string }
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
  | { type: "AP2_LIST_INTENT_MANDATES" }
  // SpendingCapVault — on-chain agent spending limits
  // Time-limited mnemonic import (30-day local signing key)
  | { type: "WALLET_IMPORT_TIMED"; name: string; mnemonic: string; ttlDays: number }
  | { type: "WALLET_GET_EXPIRY"; accountId: string }
  // SpendingCapVault — on-chain agent spending limits
  | { type: "VAULT_GET_STATE"; chain: ChainId }
  | { type: "VAULT_DEPLOY"; chain: ChainId; globalMaxPerTxn: string; globalDailyCap: string; globalMaxAsa: string; allowlistEnabled: boolean; agentMaxPerTxn: string; agentDailyCap: string }
  | { type: "VAULT_ACTION"; chain: ChainId; action: "suspend" | "resume" | "update_limits" | "withdraw" | "opt_in_asa"; maxPerTxn?: string; dailyCap?: string; maxAsa?: string; receiver?: string; amount?: string; assetId?: number }
  | { type: "VAULT_GET_OPTED_ASSETS"; chain: ChainId }
  // WalletConnect vault owner signing (popup signs, background submits)
  | { type: "VAULT_WC_SUBMIT_CREATE"; signedTxnB64: string; chain: ChainId; agentAddress: string; agentMaxPerTxn: string; agentDailyCap: string }
  | { type: "VAULT_WC_SUBMIT_SETUP";  signedGroupB64s: string[]; chain: ChainId; appId: number; appAddress: string }
  | { type: "VAULT_WC_ACTION_SUBMIT"; signedTxnB64: string; chain: ChainId }
  // Remap an existing vault (new agent key, without redeploying the contract)
  | { type: "VAULT_REMAP"; chain: ChainId; appId: number; agentMaxPerTxn: string; agentDailyCap: string }
  | { type: "VAULT_WC_REMAP_SUBMIT"; signedGroupB64s: string[]; chain: ChainId; appId: number; appAddress: string }
  // Haystack Router — DEX swap aggregator (Algorand only)
  | { type: "SWAP_QUOTE"; fromAssetId: number; fromDecimals: number; toAssetId: number; toDecimals: number; amount: string; address: string }
  | { type: "SWAP_EXECUTE"; fromAssetId: number; fromDecimals: number; toAssetId: number; toDecimals: number; amount: string; slippage: number; address: string }
  // WalletConnect Web3Wallet — AlgoVoi as wallet for AI agents
  | { type: "W3W_GENERATE_URI" }
  | { type: "W3W_GET_SESSIONS" }
  | { type: "W3W_DISCONNECT"; topic: string }
  | { type: "W3W_AGENT_SIGN_GET_PENDING"; requestId: string }
  | { type: "W3W_AGENT_SIGN_APPROVE"; requestId: string }
  | { type: "W3W_AGENT_SIGN_REJECT"; requestId: string }
  // AI Agent chat (Voi + Algorand)
  | { type: "AGENT_CHAT"; messages: Array<{ role: "user" | "assistant"; content: string }>; activeAddress: string; category?: string; chain?: string }
  // AI Agent: sign and submit transactions (XXII-2)
  | { type: "SIGN_TRANSACTIONS"; txns: string[]; network: string }
  | { type: "SUBMIT_TRANSACTIONS"; signedTxns: string[]; network: string }
  // Keep-alive: resets auto-lock timer without side-effects
  | { type: "KEEP_ALIVE" };

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
  T extends "MPP_GET_PENDING" ? { request: PendingMppApproval | null } :
  T extends "MPP_APPROVE" ?
    | { authorizationHeader: string; txId: string }
    | { needsWcSign: true; unsignedTxnB64: string; chain: ChainId; sessionTopic: string; signerAddress: string } :
  T extends "MPP_WC_SIGNED" ? { authorizationHeader: string; txId: string } :
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
  T extends "VAULT_REMAP" ?
    | { txId: string; appId: number; appAddress: string; agentAddress: string }
    | { needsWcSign: true; step: "remap"; setupGroupB64s: string[]; sessionTopic: string; signerAddress: string; appId: number; appAddress: string; agentAddress: string; chain: ChainId } :
  T extends "VAULT_WC_REMAP_SUBMIT" ? { txId: string; agentAddress: string } :
  // Web3Wallet (AlgoVoi as WC wallet for AI agents)
  T extends "W3W_GENERATE_URI" ? { uri: string } :
  T extends "W3W_GET_SESSIONS" ? { sessions: Record<string, unknown> } :
  T extends "W3W_DISCONNECT" ? { success: boolean } :
  T extends "W3W_AGENT_SIGN_GET_PENDING" ? { request: PendingAgentSignRequest | null } :
  T extends "W3W_AGENT_SIGN_APPROVE" ? { signedTxns: (string | null)[] } :
  T extends "W3W_AGENT_SIGN_REJECT" ? { success: boolean } :
  T extends "SWAP_QUOTE" ? { quoteAmount: string; priceImpact: number | null; usdIn: number | null; usdOut: number | null; routeCount: number } :
  T extends "SWAP_EXECUTE" ? { txIds: string[]; confirmedRound: string; outputAmount: string } :
  T extends "KEEP_ALIVE" ? { alive: boolean } :
  { success: boolean; error?: string };

// Notification pushed from background to content/tabs
export type BgNotification =
  | { type: "ACCOUNT_CHANGED"; accounts: string[] }
  | { type: "CHAIN_CHANGED"; chain: ChainId }
  | { type: "LOCK_STATE_CHANGED"; lockState: LockState }
  | { type: "X402_RESULT"; requestId: string; approved: boolean; paymentHeader?: string; error?: string }
  | { type: "MPP_RESULT"; requestId: string; approved: boolean; authorizationHeader?: string; error?: string }
  | { type: "AP2_RESULT"; requestId: string; approved: boolean; paymentMandate?: PaymentMandate; error?: string }
  | { type: "W3W_SESSION_APPROVED"; topic: string; agentName: string }
  | { type: "W3W_SESSION_REQUEST"; requestId: string };
