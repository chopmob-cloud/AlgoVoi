/**
 * Bazaar Discovery Panel — browse catalogued x402-enabled APIs and resources
 * across Algorand and Voi. Placeholder for @x402-avm/extensions withBazaar() integration.
 */

import { useState } from "react";
import { formatAmount } from "@shared/utils/format";
import type { ChainId } from "@shared/types/chain";

interface BazaarListing {
  id: string;
  name: string;
  description: string;
  url: string;
  chain: ChainId;
  asset: string;
  assetTicker: string;
  pricePerRequest: string; // microunits
  decimals: number;
  category: string;
  facilitator?: string;
}

// Known x402-compatible services — extended by live @x402-avm/extensions withBazaar() in Phase 2
const EXAMPLE_LISTINGS: BazaarListing[] = [
  {
    id: "ulumcp-voi",
    name: "UluMCP — AVM Smart Contract MCP Server",
    description:
      "MCP server for AI agents: tokens, NFTs, DEX swaps (SnowballSwap), marketplace listings, and enVoi name resolution on Algorand and Voi. Supports x402 payment gating and WAD metered billing.",
    url: "https://mcp.ilovechicken.co.uk/mcp",
    chain: "voi",
    asset: "0",
    assetTicker: "VOI",
    pricePerRequest: "1000000",
    decimals: 6,
    category: "AI",
  },
];

const CATEGORIES = ["All", "Analytics", "NFT", "DeFi", "AI", "Data"];

export default function BazaarPanel() {
  const [filter, setFilter] = useState<ChainId | "all">("all");
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");

  const filtered = EXAMPLE_LISTINGS.filter((l) => {
    if (filter !== "all" && l.chain !== filter) return false;
    if (category !== "All" && l.category !== category) return false;
    if (search && !l.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      {/* Filters */}
      <div className="px-4 py-3 border-b border-surface-2 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            className="input flex-1 text-sm py-1.5"
            placeholder="Search APIs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex bg-surface-2 rounded-lg p-0.5">
            {(["all", "algorand", "voi"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setFilter(c)}
                className={`text-xs px-2.5 py-1 rounded-md capitalize transition-colors ${
                  filter === c
                    ? c === "all"
                      ? "bg-surface-3 text-white"
                      : c === "algorand"
                      ? "bg-algo text-black font-semibold"
                      : "bg-voi text-white font-semibold"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto pb-0.5">
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className={`text-xs px-2.5 py-1 rounded-full shrink-0 transition-colors ${
                category === cat
                  ? "bg-surface-3 text-white"
                  : "text-gray-500 hover:text-white"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Notice */}
      <div className="mx-4 mt-3 bg-voi/10 border border-voi/30 rounded-xl px-3 py-2">
        <p className="text-xs text-voi">
          Live Bazaar discovery via @x402-avm/extensions coming in Phase 2.
          Showing known x402-compatible services.
        </p>
      </div>

      {/* Listings */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
        {filtered.length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-8">No listings match your filters</p>
        ) : (
          filtered.map((listing) => (
            <ListingCard key={listing.id} listing={listing} />
          ))
        )}
      </div>
    </div>
  );
}

function ListingCard({ listing }: { listing: BazaarListing }) {
  const price = formatAmount(BigInt(listing.pricePerRequest), listing.decimals);

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-semibold">{listing.name}</h3>
            <span className="text-[10px] bg-surface-3 px-1.5 py-0.5 rounded text-gray-400">
              {listing.category}
            </span>
          </div>
          <p className="text-xs text-gray-400 leading-relaxed">{listing.description}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-base font-bold">{price}</p>
          <p className="text-xs text-gray-400">{listing.assetTicker} / req</p>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              listing.chain === "algorand"
                ? "bg-algo/20 text-algo"
                : "bg-voi/20 text-voi"
            }`}
          >
            {listing.chain === "algorand" ? "Algorand" : "Voi"}
          </span>
          <span className="text-xs text-gray-500 font-mono truncate max-w-[200px]">
            {listing.url}
          </span>
        </div>
        <button
          className="text-xs bg-algo text-black font-semibold px-3 py-1 rounded-lg hover:bg-algo-dark transition-colors"
          onClick={() => navigator.clipboard.writeText(listing.url)}
        >
          Copy URL
        </button>
      </div>
    </div>
  );
}
