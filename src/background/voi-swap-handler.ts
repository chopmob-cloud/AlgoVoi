/**
 * Voi native swap handler — quotes via Snowball API, builds txns via MCP server.
 *
 * Flow:
 *   Quote:   Background → Snowball /quote → returns quote + poolId
 *   Execute: Background → MCP /voi-swap → unsigned txns → sign → submit to Voi algod
 *
 * Only single-hop (direct pool) swaps are supported. Multi-hop routes are
 * detected and rejected with a clear error message.
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getAlgodClient, submitTransactionGroup } from "./chain-clients";

const SNOWBALL_BASE = "https://api.snowballswap.com";
const MCP_VOI_SWAP_URL = "https://mcp.ilovechicken.co.uk/voi-swap";

export async function getVoiSwapQuote(params: {
  tokenIn: number;
  tokenOut: number;
  amountIn: string;
  decimalsIn: number;
  decimalsOut: number;
  address: string;
}): Promise<{
  quoteAmount: string;
  priceImpact: number | null;
  poolId: number | null;
  isMultiHop: boolean;
  outputAmountAtomic: string;
}> {
  const amountAtomic = parseDecimal(params.amountIn, params.decimalsIn);

  const resp = await fetch(`${SNOWBALL_BASE}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      inputToken: String(params.tokenIn),
      outputToken: String(params.tokenOut),
      amount: amountAtomic.toString(),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Snowball quote failed (${resp.status}): ${body}`);
  }

  const data = (await resp.json()) as {
    quote: {
      outputAmount: string;
      priceImpact?: number;
      simulationError?: string | null;
    };
    poolId?: number | null;
    route?: {
      type?: string;
      hops?: Array<{
        pools?: Array<{ poolId: string | number }>;
      }>;
    };
    simulationError?: string | null;
  };

  if (!data.quote) throw new Error("Snowball returned no quote");

  const hops = data.route?.hops ?? [];
  const routeType = data.route?.type ?? "";

  // Snowball uses "direct" with hops=[] and top-level poolId for single-pool swaps.
  // "multi-hop" has hops[] but top-level poolId=null.
  let poolId: number | null = null;
  let isMultiHop = false;

  if (routeType === "direct" && data.poolId) {
    poolId = Number(data.poolId);
  } else if (hops.length === 1 && hops[0].pools?.length) {
    poolId = Number(hops[0].pools[0].poolId);
  } else if (hops.length > 1) {
    isMultiHop = true;
  }

  const outputAtomic = BigInt(data.quote.outputAmount);

  return {
    quoteAmount: formatAtomic(outputAtomic, params.decimalsOut),
    priceImpact: data.quote.priceImpact ?? null,
    poolId,
    isMultiHop,
    outputAmountAtomic: data.quote.outputAmount,
  };
}

export async function executeVoiSwap(params: {
  poolId: number;
  tokenIn: number;
  tokenOut: number;
  amountIn: string;
  decimalsIn: number;
  slippage: number;
  address: string;
}): Promise<{ txId: string }> {
  if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
  walletStore.resetAutoLock();

  // Verify address matches active mnemonic account (defence in depth)
  const execMeta = await walletStore.getMeta();
  const activeAccount = execMeta.accounts.find((a) => a.id === execMeta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");
  if (activeAccount.type === "walletconnect") {
    throw new Error("Voi swaps require a mnemonic account — WalletConnect not yet supported");
  }
  if (activeAccount.address !== params.address) {
    throw new Error(
      `Swap address mismatch: expected ${activeAccount.address}, got ${params.address}. Refresh and retry.`
    );
  }

  const sk = await walletStore.getActiveSecretKey();
  try {
    // 1. Fetch unsigned txns from MCP server
    const resp = await fetch(MCP_VOI_SWAP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        poolId: params.poolId,
        sender: params.address,
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
        slippage: params.slippage / 100, // UI sends %, server expects decimal
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({ error: `Server error ${resp.status}` })) as { error?: string };
      throw new Error(errBody.error || `Voi swap server error: ${resp.status}`);
    }

    const { txns } = (await resp.json()) as { txns: string[] };
    if (!txns?.length) throw new Error("No transactions returned from swap server");

    // 2. Sign all transactions
    const decodedTxns = txns.map((t) =>
      algosdk.decodeUnsignedTransaction(Buffer.from(t, "base64"))
    );
    const signedBlobs = decodedTxns.map((txn) => {
      const { blob } = algosdk.signTransaction(txn, sk);
      return blob;
    });

    // 3. Submit to Voi algod
    const algod = getAlgodClient("voi");
    const sendResult = await algod.sendRawTransaction(signedBlobs).do() as { txid: string };
    await algosdk.waitForConfirmation(algod, sendResult.txid, 6);

    return { txId: sendResult.txid };
  } finally {
    sk.fill(0); // Always wipe secret key
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDecimal(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(clean)) throw new Error(`Invalid amount: ${amount}`);
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  const atomic = BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
  if (atomic > 18_446_744_073_709_551_615n) {
    throw new Error("Amount exceeds maximum representable value (uint64 overflow)");
  }
  return atomic;
}

function formatAtomic(atomic: bigint, decimals: number): string {
  if (decimals === 0) return atomic.toString();
  const divisor = BigInt(10 ** decimals);
  const int = atomic / divisor;
  const frac = atomic % divisor;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${int}.${fracStr}` : `${int}`;
}
