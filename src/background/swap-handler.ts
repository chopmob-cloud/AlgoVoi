/**
 * Haystack Router integration — DEX swap aggregator on Algorand.
 * All signing happens here in the background (vault never leaves the SW).
 */

import { RouterClient } from "@txnlab/haystack-router";
import type { SignerFunction } from "@txnlab/haystack-router";
import algosdk from "algosdk";
import { walletStore } from "./wallet-store";

const HAYSTACK_API_KEY =
  (import.meta.env.VITE_HAYSTACK_ROUTER_API_KEY as string | undefined) ?? "";
const HAYSTACK_REFERRER =
  (import.meta.env.VITE_HAYSTACK_REFERRER_ADDRESS as string | undefined) ?? "";

function createClient(): RouterClient {
  return new RouterClient({
    apiKey: HAYSTACK_API_KEY,
    autoOptIn: true,
    feeBps: 15,
    // Pin to algonode — matches our manifest CSP and host_permissions
    algodUri: "https://mainnet-api.algonode.cloud",
    algodToken: "",
    algodPort: 443,
    ...(HAYSTACK_REFERRER ? { referrerAddress: HAYSTACK_REFERRER } : {}),
  });
}

function parseDecimal(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`Invalid amount: ${amount}`);
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  const atomic = BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
  // SW-1: Reject values that exceed the AVM uint64 maximum (matches parseDecimalToAtomic in message-handler.ts)
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

export async function getSwapQuote(params: {
  fromAssetId: number;
  fromDecimals: number;
  toAssetId: number;
  toDecimals: number;
  amount: string;
  address: string;
}): Promise<{
  quoteAmount: string;
  priceImpact: number | null;
  usdIn: number | null;
  usdOut: number | null;
  routeCount: number;
}> {
  if (!HAYSTACK_API_KEY) throw new Error("Haystack API key not configured — add VITE_HAYSTACK_ROUTER_API_KEY to .env");
  const client = createClient();
  const amountAtomic = parseDecimal(params.amount, params.fromDecimals);

  const quote = await client.newQuote({
    fromASAID: params.fromAssetId,
    toASAID: params.toAssetId,
    amount: amountAtomic,
    address: params.address,
  });

  return {
    quoteAmount: formatAtomic(quote.quote, params.toDecimals),
    priceImpact: quote.userPriceImpact ?? null,
    usdIn:  quote.usdIn  ?? null,
    usdOut: quote.usdOut ?? null,
    routeCount: quote.route?.length ?? 0,
  };
}

export async function executeSwap(params: {
  fromAssetId: number;
  fromDecimals: number;
  toAssetId: number;
  toDecimals: number;
  amount: string;
  slippage: number;
  address: string;
}): Promise<{ txIds: string[]; confirmedRound: string; outputAmount: string }> {
  if (!HAYSTACK_API_KEY) throw new Error("Haystack API key not configured — add VITE_HAYSTACK_ROUTER_API_KEY to .env");
  if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
  walletStore.resetAutoLock();

  // SW-2: Assert params.address matches the active mnemonic account — defence-in-depth
  // so a stale popup state can never sign for a different address than the current vault key.
  const execMeta = await walletStore.getMeta();
  const activeAccount = execMeta.accounts.find((a) => a.id === execMeta.activeAccountId);
  if (!activeAccount) throw new Error("No active account");
  if (activeAccount.type === "walletconnect") {
    throw new Error("Background swap execution requires a mnemonic account (use the WalletConnect path for WC accounts)");
  }
  if (activeAccount.address !== params.address) {
    throw new Error(
      `Swap address mismatch: expected active account ${activeAccount.address}, got ${params.address}. ` +
      `Refresh and retry.`
    );
  }

  const sk = await walletStore.getActiveSecretKey();
  try {
    const client = createClient();
    const amountAtomic = parseDecimal(params.amount, params.fromDecimals);

    const quote = await client.newQuote({
      fromASAID: params.fromAssetId,
      toASAID: params.toAssetId,
      amount: amountAtomic,
      address: params.address,
    });

    const signer: SignerFunction = async (txnGroup, indexesToSign) => {
      return txnGroup.map((txn, i) => {
        if (indexesToSign.includes(i)) {
          const { blob } = algosdk.signTransaction(txn, sk);
          return blob;
        }
        return null;
      });
    };

    const swap = await client.newSwap({
      quote,
      address: params.address,
      signer,
      slippage: params.slippage,
    });

    const result = await swap.execute();
    return {
      txIds: result.txIds,
      confirmedRound: result.confirmedRound.toString(),
      outputAmount: formatAtomic(quote.quote, params.toDecimals),
    };
  } finally {
    sk.fill(0); // XIV-1: wipe secret key after swap (always, even on error)
  }
}
