/**
 * Transaction Decoder — paste a base64 msgpack-encoded AVM transaction
 * and inspect its decoded fields.
 */

import { useState } from "react";
import algosdk from "algosdk";
import { base64ToBytes } from "@shared/utils/crypto";

interface DecodedTxn {
  type: string;
  from: string;
  to?: string;
  amount?: bigint;
  assetIndex?: number;
  note?: string;
  fee: bigint;
  firstValid: bigint;
  lastValid: bigint;
  genesisId?: string;
  genesisHash?: string;
  group?: string;
  txId: string;
  raw: object;
}

function decodeTxn(b64: string): DecodedTxn {
  const bytes = base64ToBytes(b64.trim());
  // Try unsigned first, then signed
  let txn: algosdk.Transaction;
  try {
    txn = algosdk.decodeUnsignedTransaction(bytes);
  } catch {
    const signed = algosdk.decodeSignedTransaction(bytes);
    txn = signed.txn;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = txn as unknown as Record<string, any>;
  return {
    type: txn.type ?? "unknown",
    from: algosdk.encodeAddress((txn as unknown as Record<string, any>).sender?.publicKey ?? (txn as unknown as Record<string, any>).from?.publicKey),
    to: raw.receiver ? algosdk.encodeAddress(raw.receiver.publicKey) : (raw.to ? algosdk.encodeAddress(raw.to.publicKey) : undefined),
    amount: raw.amount,
    assetIndex: raw.assetIndex,
    note: txn.note ? new TextDecoder().decode(txn.note) : undefined,
    fee: txn.fee,
    firstValid: txn.firstValid,
    lastValid: txn.lastValid,
    genesisId: txn.genesisID,
    genesisHash: txn.genesisHash ? btoa(String.fromCharCode(...txn.genesisHash)) : undefined,
    group: txn.group ? btoa(String.fromCharCode(...txn.group)) : undefined,
    txId: txn.txID(),
    raw,
  };
}

export default function TxnInspector() {
  const [input, setInput] = useState("");
  const [decoded, setDecoded] = useState<DecodedTxn | null>(null);
  const [error, setError] = useState("");

  function handleDecode() {
    setError("");
    setDecoded(null);
    try {
      setDecoded(decodeTxn(input));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to decode transaction");
    }
  }

  return (
    <div className="p-4 flex flex-col gap-4 max-w-3xl">
      <div>
        <h2 className="text-sm font-semibold mb-2">Transaction Decoder</h2>
        <p className="text-xs text-gray-400 mb-3">
          Paste a base64-encoded AVM transaction (signed or unsigned msgpack).
        </p>
        <textarea
          className="input h-24 resize-none font-mono text-xs"
          placeholder="gqN0eG6Ko2FtdM0D6KNmZWXNA..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button className="btn-primary mt-2 text-sm" onClick={handleDecode} disabled={!input.trim()}>
          Decode
        </button>
      </div>

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {decoded && (
        <div className="flex flex-col gap-3">
          <div className="bg-surface-1 rounded-xl p-3 flex flex-col gap-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">
              Transaction Fields
            </p>
            <Field label="TX ID" value={decoded.txId} mono />
            <Field label="Type" value={decoded.type} />
            <Field label="From" value={decoded.from} mono />
            {decoded.to && <Field label="To" value={decoded.to} mono />}
            {decoded.amount !== undefined && (
              <Field label="Amount" value={`${decoded.amount} µ`} />
            )}
            {decoded.assetIndex !== undefined && (
              <Field label="Asset ID" value={String(decoded.assetIndex)} />
            )}
            <Field label="Fee" value={`${decoded.fee} µALGO`} />
            <Field label="Valid Rounds" value={`${decoded.firstValid} – ${decoded.lastValid}`} />
            {decoded.genesisId && <Field label="Genesis ID" value={decoded.genesisId} />}
            {decoded.group && <Field label="Group" value={decoded.group} mono />}
            {decoded.note && <Field label="Note" value={decoded.note} />}
          </div>

          <div className="bg-surface-1 rounded-xl p-3">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold mb-2">
              Raw Encoding
            </p>
            <pre className="text-[10px] text-gray-400 overflow-x-auto">
              {JSON.stringify(decoded.raw, (_k, v) =>
                v instanceof Uint8Array ? `<bytes:${btoa(String.fromCharCode(...v))}>` : v
              , 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className={`text-xs text-right break-all ${mono ? "font-mono text-gray-300" : "text-white"}`}>
        {value}
      </span>
    </div>
  );
}
