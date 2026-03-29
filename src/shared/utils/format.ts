/**
 * Display formatting utilities for AVM amounts, addresses, and assets.
 */

import type { ChainId } from "../types/chain";

/** Format microunits to display string with specified decimals */
export function formatAmount(microAmount: bigint | number, decimals = 6): string {
  const micro = typeof microAmount === "number" ? BigInt(microAmount) : microAmount;
  const divisor = BigInt(10 ** decimals);
  const whole = micro / divisor;
  const fraction = micro % divisor;
  const fractionStr = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fractionStr.length > 0 ? `${whole}.${fractionStr}` : `${whole}`;
}

/** Format with ticker, e.g. "12.5 ALGO" */
export function formatAmountWithTicker(
  microAmount: bigint | number,
  ticker: string,
  decimals = 6
): string {
  return `${formatAmount(microAmount, decimals)} ${ticker}`;
}

/** Convert display amount string to microunits */
export function parseAmount(display: string, decimals = 6): bigint {
  const [whole, fraction = ""] = display.split(".");
  const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * BigInt(10 ** decimals) + BigInt(paddedFraction);
}

/** Abbreviate an AVM address, e.g. "ABCDE...WXYZ" */
export function abbreviateAddress(address: string, chars = 6): string {
  if (address.length <= chars * 2) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Validate an AVM address (58-character base32 without padding) */
export function isValidAddress(address: string): boolean {
  return /^[A-Z2-7]{58}$/.test(address);
}

/** Chain display name */
export function chainLabel(chain: ChainId): string {
  return chain === "algorand" ? "Algorand" : "Voi";
}

/** Format a transaction ID for display */
export function abbreviateTxId(txId: string, chars = 8): string {
  return `${txId.slice(0, chars)}…${txId.slice(-chars)}`;
}

/** Explorer URL for a transaction */
export function txExplorerUrl(txId: string, chain: ChainId): string {
  if (chain === "algorand") return `https://allo.info/tx/${txId}`;
  return `https://explorer.voi.network/explorer/transaction/${txId}`;
}

/** Explorer URL for an account */
export function accountExplorerUrl(address: string, chain: ChainId): string {
  if (chain === "algorand") return `https://allo.info/account/${address}`;
  return `https://explorer.voi.network/explorer/account/${address}`;
}

/** Format unix timestamp relative to now */
export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
