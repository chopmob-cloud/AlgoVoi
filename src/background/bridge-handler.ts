/**
 * Aramid Bridge handler — builds, signs, and submits bridge transactions.
 *
 * No MCP round-trip needed: the bridge is a single payment/ASA transfer
 * to the Aramid bridge address with a structured JSON note.
 *
 * Flow:
 *   1. Validate params + wallet state
 *   2. Build unsigned txn (payment or ASA transfer)
 *   3. Sign with mnemonic sk
 *   4. Submit to source-chain algod
 *
 * Fee: 0.1% deducted from amount; destinationAmount = amount - fee
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getAlgodClient } from "./chain-clients";
import type { ChainId } from "@shared/types/chain";

const BRIDGE_ADDRESS = "ARAMIDFJYV2TOFB5MRNZJIXBSAVZCVAUDAPFGKR5PNX4MTILGAZABBTXQQ";

const VALID_CHAINS: readonly ChainId[] = ["algorand", "voi"] as const;

// Aramid protocol chain IDs for the DESTINATION network
// 416001 = Algorand mainnet, 416101 = Voi mainnet
const DEST_CHAIN_IDS: Record<ChainId, number> = {
  "algorand": 416001, // Algorand mainnet chain ID (used when dest IS algorand)
  "voi":      416101, // Voi mainnet chain ID     (used when dest IS voi)
};

// XXI-3: explicit whitelist of valid source tokens per chain — USDC/aUSDC only
const VALID_TOKENS: Record<ChainId, number[]> = {
  voi:      [302190],
  algorand: [31566704],
};

// Known destination-chain token IDs for each source token.
// Key: `${sourceChain}:${sourceTokenId}` → destination token ID (as string).
export const BRIDGE_TOKEN_PAIRS: Record<string, { destToken: string; symbol: string; destSymbol: string }> = {
  "voi:302190":        { destToken: "31566704", symbol: "aUSDC", destSymbol: "USDC"  },
  "algorand:31566704": { destToken: "302190",   symbol: "USDC",  destSymbol: "aUSDC" },
};

export interface BridgeParams {
  sourceChain:        ChainId;
  sourceToken:        number;   // 0 = native
  amount:             string;   // human-readable decimal
  decimals:           number;
  destinationAddress: string;
  senderAddress:      string;
}

export async function executeBridge(params: BridgeParams): Promise<{ txId: string }> {
  // XXI-3: validate sourceChain against known whitelist
  if (!VALID_CHAINS.includes(params.sourceChain)) {
    throw new Error(`Invalid source chain: ${params.sourceChain}`);
  }

  if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
  walletStore.resetAutoLock();

  // Verify active account matches sender (defence in depth)
  const meta = await walletStore.getMeta();
  const activeAccount = meta.accounts.find((a) => a.id === meta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");
  if (activeAccount.type === "walletconnect") {
    throw new Error("Bridge requires a mnemonic account — WalletConnect not yet supported");
  }
  if (activeAccount.address !== params.senderAddress) {
    throw new Error("Bridge address mismatch — refresh and retry");
  }

  // Validate destination address
  if (!algosdk.isValidAddress(params.destinationAddress)) {
    throw new Error("Invalid destination address");
  }

  // XXI-3: validate sourceToken is a known token for this chain
  if (!VALID_TOKENS[params.sourceChain].includes(params.sourceToken)) {
    throw new Error(`Invalid token ${params.sourceToken} for chain ${params.sourceChain}`);
  }

  // XXI-4: validate decimals range before BigInt arithmetic
  if (!Number.isInteger(params.decimals) || params.decimals < 0 || params.decimals > 19) {
    throw new Error("Invalid decimals: must be 0–19");
  }
  if (params.amount.length > 40) {
    throw new Error("Amount string too long");
  }

  // Resolve token pair
  const pairKey = `${params.sourceChain}:${params.sourceToken}`;
  const pair = BRIDGE_TOKEN_PAIRS[pairKey];
  if (!pair) throw new Error(`Unsupported bridge pair: ${pairKey}`);

  // Parse amount to atomic
  const amountAtomic = parseDecimal(params.amount, params.decimals);
  if (amountAtomic <= 0n) throw new Error("Amount must be positive");
  // XXI-4: guard uint64 overflow
  if (amountAtomic > 18_446_744_073_709_551_615n) {
    throw new Error("Amount exceeds maximum (uint64 overflow)");
  }

  // Calculate fee (0.1% = amount / 1000, minimum 1 microunit)
  const feeAmount  = amountAtomic / 1000n || 1n;
  const destAmount = amountAtomic - feeAmount;

  // Build note
  const destChain = params.sourceChain === "voi" ? "algorand" : "voi";
  const noteObj = {
    destinationNetwork:  DEST_CHAIN_IDS[destChain as ChainId],
    destinationAddress:  params.destinationAddress,
    destinationToken:    pair.destToken,
    feeAmount:           Number(feeAmount),
    destinationAmount:   Number(destAmount),
    note:                "aramid",
    sourceAmount:        Number(destAmount),
  };
  const noteBytes = new Uint8Array(
    Buffer.from("aramid-transfer/v1:j" + JSON.stringify(noteObj))
  );

  // XXI-2: sk retrieved inside try so finally always cleans up
  let sk: Uint8Array | undefined;
  try {
    sk = await walletStore.getActiveSecretKey();
    const algod      = getAlgodClient(params.sourceChain);
    const txnParams  = await algod.getTransactionParams().do();

    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender:           params.senderAddress,
      receiver:         BRIDGE_ADDRESS,
      amount:           amountAtomic,
      assetIndex:       params.sourceToken,
      suggestedParams:  txnParams,
      note:             noteBytes,
    });

    const { blob } = algosdk.signTransaction(txn, sk);
    const result   = await algod.sendRawTransaction(blob).do() as { txid: string };
    await algosdk.waitForConfirmation(algod, result.txid, 6);

    return { txId: result.txid };
  } finally {
    sk?.fill(0); // Always wipe secret key
  }
}

function parseDecimal(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`Invalid amount: ${amount}`);
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
}
