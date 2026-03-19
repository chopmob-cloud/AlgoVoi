/**
 * Types for WalletConnect Web3Wallet agent signing flow.
 *
 * AI agents connect to AlgoVoi as a WC wallet (Web3Wallet role).
 * They submit algo_signTxn requests which are routed through the
 * approval popup — the user must explicitly approve each one.
 */

/**
 * A single transaction in an algo_signTxn request.
 * Follows the Pera/Defly/Voi Wallet encoding convention.
 */
export interface AgentSignTxn {
  /** base64-encoded msgpack unsigned transaction */
  txn: string;
  /**
   * If undefined or contains the wallet address: sign this transaction.
   * If an empty array []: reference transaction — do not sign, return null.
   */
  signers?: string[];
}

/**
 * A pending agent signing request, queued while the approval popup is open.
 * Stored in the module-level map in web3wallet-handler.ts.
 */
export interface PendingAgentSignRequest {
  /** Internal AlgoVoi request ID (used to look up this record) */
  id: string;
  /** WC JSON-RPC request ID — used when calling respondToSessionRequest */
  wcRequestId: number;
  /** WC session topic */
  topic: string;
  /** Chrome tab ID (always -1 for agent requests — no tab origin) */
  tabId: number;
  /** The inpage requestId (not used for agent requests, kept for interface parity) */
  inpageRequestId: string;
  /** Peer app name from WC session metadata */
  agentName: string;
  /** Peer app URL from WC session metadata */
  agentUrl: string;
  /** Which chain the request targets (determined from txn genesisID) */
  chain: "algorand" | "voi";
  /** Raw AgentSignTxn objects from the WC request params */
  txns: AgentSignTxn[];
  /** Pre-decoded transaction summaries (built in background, same as ARC-27) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  decodedTxns: Record<string, any>[];
  timestamp: number;
  /** accountId of the active account at request creation time — asserted on approval */
  accountId?: string;
}
