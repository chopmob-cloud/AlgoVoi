/**
 * Coinbase Onramp — Secure session token flow.
 *
 * 1. Extension calls our backend (ilovechicken.co.uk/api/coinbase-session)
 *    which signs a JWT and gets a one-time session token from Coinbase.
 * 2. Extension opens pay.coinbase.com?sessionToken=... in a new tab.
 *
 * This satisfies Coinbase's "require secure initialization" setting —
 * wallet addresses are never exposed in URL query parameters.
 *
 * Spec: https://docs.cdp.coinbase.com/onramp/docs/api-onramp-initializing
 */

import {
  COINBASE_ONRAMP_URL,
  COINBASE_SESSION_URL,
  COINBASE_NETWORK,
  COINBASE_ASSET,
} from "../shared/constants";

export interface OnrampParams {
  /** User's wallet address (e.g. "GHSRL2..."). */
  address: string;
  /** AlgoVoi chain ID: "algorand" | "voi". */
  chain: string;
  /** Optional pre-filled fiat amount (e.g. "50"). */
  fiatAmount?: string;
  /** Optional fiat currency code (e.g. "GBP", "USD"). */
  fiatCurrency?: string;
}

/**
 * Fetch a one-time session token from our backend, then open
 * pay.coinbase.com with the token.  Returns the tab ID.
 */
export async function openOnramp(params: OnrampParams): Promise<number> {
  const network = COINBASE_NETWORK[params.chain] ?? "algorand";
  const asset   = COINBASE_ASSET[params.chain]   ?? "ALGO";

  // 1. Get session token from backend
  const body: Record<string, unknown> = {
    addresses: { [params.address]: [network] },
    assets: [asset],
    default_network: network,
    default_asset: asset,
  };
  if (params.fiatAmount)   body.preset_fiat_amount = params.fiatAmount;
  if (params.fiatCurrency) body.fiat_currency = params.fiatCurrency;

  const resp = await fetch(COINBASE_SESSION_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    throw new Error(`Coinbase session failed (${resp.status}): ${detail}`);
  }

  const data = await resp.json() as {
    ok: boolean;
    sessionToken?: string;
    url?: string;
  };

  // 2. Build the onramp URL
  let onrampUrl: string;

  if (data.url) {
    // Backend returned a full URL — use it directly
    onrampUrl = data.url;
  } else if (data.sessionToken) {
    // Build URL with session token
    const url = new URL(COINBASE_ONRAMP_URL);
    url.searchParams.set("sessionToken", data.sessionToken);
    url.searchParams.set("defaultNetwork", network);
    url.searchParams.set("defaultAsset", asset);
    if (params.fiatAmount)   url.searchParams.set("presetFiatAmount", params.fiatAmount);
    if (params.fiatCurrency) url.searchParams.set("fiatCurrency", params.fiatCurrency);
    onrampUrl = url.toString();
  } else {
    throw new Error("Coinbase session returned no token or URL");
  }

  // 3. Open in new tab
  const tab = await chrome.tabs.create({ url: onrampUrl, active: true });
  return tab.id ?? -1;
}
