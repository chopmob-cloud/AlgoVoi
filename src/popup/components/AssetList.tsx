import { formatAmount } from "@shared/utils/format";
import type { AccountAsset } from "@shared/types/chain";
import type { ChainId } from "@shared/types/chain";
import { CHAINS } from "@shared/constants";

interface Props {
  chain: ChainId;
  balance: bigint;
  assets: AccountAsset[];
}

export default function AssetList({ chain, balance, assets }: Props) {
  const cfg = CHAINS[chain];

  return (
    <div className="flex flex-col gap-1">
      {/* Native coin row */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-surface-2 rounded-lg">
        <div className="flex items-center gap-2.5">
          <div
            className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
              chain === "algorand" ? "bg-algo text-black" : "bg-voi text-white"
            }`}
          >
            {cfg.ticker[0]}
          </div>
          <div>
            <p className="text-sm font-medium">{cfg.ticker}</p>
            <p className="text-xs text-gray-500">{cfg.name}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold">{formatAmount(balance, cfg.decimals)}</p>
          <p className="text-xs text-gray-500">{cfg.ticker}</p>
        </div>
      </div>

      {/* ASA rows */}
      {assets.map((asset) => (
        <div
          key={asset.assetId}
          className="flex items-center justify-between px-3 py-2.5 bg-surface-2 rounded-lg"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-surface-3 flex items-center justify-center text-xs text-gray-400">
              {asset.unitName ? asset.unitName[0] : "?"}
            </div>
            <div>
              <p className="text-sm font-medium">{asset.name || asset.unitName || `ASA ${asset.assetId}`}</p>
              <p className="text-xs text-gray-500">ID {asset.assetId}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold">
              {formatAmount(asset.amount, asset.decimals)}
            </p>
            <p className="text-xs text-gray-500">{asset.unitName}</p>
          </div>
        </div>
      ))}

      {assets.length === 0 && (
        <p className="text-xs text-gray-500 text-center py-3">No additional assets</p>
      )}
    </div>
  );
}
