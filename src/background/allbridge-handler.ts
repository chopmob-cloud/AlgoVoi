/**
 * Allbridge bridge handler.
 *
 * Flow:
 *   1. Call MCP allbridge_bridge_txn to get hex-encoded unsigned transactions
 *   2. Decode each txn with algosdk
 *   3. Sign with mnemonic sk
 *   4. Submit to Algorand algod
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getAlgodClient } from "./chain-clients";
import { initSession, callTool } from "./mcp-client";

const VALID_DEST_CHAINS = ["ETH","BSC","SOL","TRX","POL","ARB","AVA","CEL","OPT","BAS","SUI","SNC","STLR","SRB","STX"] as const;
const ALG_USDC_ADDRESS = "31566704";

export interface AllbridgeParams {
  fromAddress:            string;
  toAddress:              string;
  sourceTokenAddress:     string;
  destinationChain:       string;
  destinationTokenSymbol: string;
  amount:                 string;
  senderAddress:          string;
}

export async function executeAllbridge(params: AllbridgeParams): Promise<{ txId: string }> {
  // Validate
  if (!algosdk.isValidAddress(params.fromAddress)) throw new Error("Invalid fromAddress");
  if (params.sourceTokenAddress !== ALG_USDC_ADDRESS) throw new Error("Only USDC bridging is supported");
  if (!VALID_DEST_CHAINS.includes(params.destinationChain as typeof VALID_DEST_CHAINS[number])) {
    throw new Error(`Invalid destination chain: ${params.destinationChain}`);
  }
  if (!params.amount || !/^\d+(\.\d+)?$/.test(params.amount.trim()) || parseFloat(params.amount) <= 0) {
    throw new Error("Invalid amount");
  }
  if (params.amount.length > 40) throw new Error("Amount string too long");

  if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
  walletStore.resetAutoLock();

  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");
  if (activeAccount.type === "walletconnect") throw new Error("Bridge requires a mnemonic account");
  if (activeAccount.address !== params.senderAddress) throw new Error("Address mismatch — refresh and retry");

  // Call MCP to build unsigned transactions
  const sessionId = await initSession();
  const mcpResult = await callTool(sessionId, "allbridge_bridge_txn", {
    fromAddress:            params.fromAddress,
    toAddress:              params.toAddress,
    sourceTokenAddress:     params.sourceTokenAddress,
    destinationChain:       params.destinationChain,
    destinationTokenSymbol: params.destinationTokenSymbol,
    amount:                 params.amount.trim(),
  });

  // Parse result from MCP content array
  const parsed = JSON.parse(mcpResult?.content?.[0]?.text ?? "{}");
  if (parsed?.error) throw new Error(parsed.error);
  const hexTxns: string[] = parsed?.txns;
  if (!Array.isArray(hexTxns) || hexTxns.length === 0) throw new Error("No transactions returned from bridge");

  // Decode unsigned transactions
  const txns = hexTxns.map((hex) => {
    const bytes = Buffer.from(hex, "hex");
    return algosdk.decodeUnsignedTransaction(bytes);
  });

  // Assign group ID if not already grouped
  const alreadyGrouped = txns.every((t) => t.group && t.group.length > 0);
  if (!alreadyGrouped && txns.length > 1) {
    algosdk.assignGroupID(txns);
  }

  let sk: Uint8Array | undefined;
  try {
    sk = await walletStore.getActiveSecretKey();
    const stxns = txns.map((t) => t.signTxn(sk!));

    const algod = getAlgodClient("algorand");
    const { txid } = await algod.sendRawTransaction(stxns).do() as { txid: string };
    await algosdk.waitForConfirmation(algod, txid, 6);
    return { txId: txid };
  } finally {
    sk?.fill(0);
  }
}
