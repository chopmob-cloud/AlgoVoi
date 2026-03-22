/**
 * SpendingCapVault — on-chain contract interface.
 *
 * The owner (user's mnemonic wallet) deploys the contract and authorises an
 * auto-generated agent key stored inside the encrypted vault.  The contract
 * enforces all spending limits on-chain; the extension calls pay() with the
 * agent key for autonomous x402/MPP/AP2 payments without user approval.
 *
 * Security model:
 *   - Owner key signs: deploy, add_agent, suspend, update_limits, withdraw
 *   - Agent key signs: pay(), pay_asa() only — nothing else is callable
 *   - Both keys live inside the AES-GCM encrypted vault (locked with password)
 *   - Worst-case agent key compromise: attacker can spend up to one day's cap
 *     before the owner calls suspend_agent() to freeze it immediately
 *
 * Requires:
 *   Run `algokit compile contracts/spending_cap.py` then paste the resulting
 *   base64 approval/clear bytecode into src/contracts/spending_cap.arc32.json
 *   before calling deployVault().
 */

import algosdk from "algosdk";
import { getAlgodClient } from "./chain-clients";
import ARC32 from "../contracts/spending_cap.arc32.json";
import type { ChainId } from "@shared/types/chain";

// ── ABI method descriptors ────────────────────────────────────────────────────

type ArcMethod = { name: string; args: { type: string }[]; returns: { type: string } };

function method(name: string): algosdk.ABIMethod {
  const found = (ARC32.contract.methods as ArcMethod[]).find((m) => m.name === name);
  if (!found) throw new Error(`ABI method not found: ${name}`);
  return new algosdk.ABIMethod({
    name:    found.name,
    args:    found.args.map((a) => ({ type: a.type, name: "" })),
    returns: { type: found.returns.type },
  });
}

// Pre-built method references
const M = {
  create:               method("create"),
  add_agent:            method("add_agent"),
  suspend_agent:        method("suspend_agent"),
  resume_agent:         method("resume_agent"),
  update_global_limits: method("update_global_limits"),
  pay:                  method("pay"),
  pay_asa:              method("pay_asa"),
  opt_in_asa:           method("opt_in_asa"),
  owner_withdraw:       method("owner_withdraw"),
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VaultGlobalState {
  globalMaxPerTxn:  bigint;
  globalDailyCap:   bigint;
  globalMaxAsa:     bigint;
  allowlistEnabled: boolean;
  totalPaid:        bigint;
  totalPaidAsa:     bigint;
  txCount:          bigint;
  vaultBalance:     bigint;
}

export interface VaultAgentState {
  enabled:   boolean;
  maxPerTxn: bigint;
  dailyCap:  bigint;
  dayBucket: bigint;
  daySpent:  bigint;
}

export interface VaultDeployLimits {
  globalMaxPerTxn:  bigint;
  globalDailyCap:   bigint;
  globalMaxAsa:     bigint;
  allowlistEnabled: boolean;
  agentMaxPerTxn:   bigint;
  agentDailyCap:    bigint;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build an algosdk.Account from a raw 64-byte secret key */
function accountFromSk(sk: Uint8Array): algosdk.Account {
  const addr = algosdk.Address.fromString(algosdk.encodeAddress(sk.slice(32)));
  return { sk, addr };
}

/** Decode AgentConfig ARC-4 struct: 5 × uint64 big-endian = 40 bytes */
function decodeAgentConfig(bytes: Uint8Array): VaultAgentState {
  if (bytes.length < 40) throw new Error("Invalid AgentConfig box: expected 40 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return {
    enabled:   view.getBigUint64(0)  === 1n,
    maxPerTxn: view.getBigUint64(8),
    dailyCap:  view.getBigUint64(16),
    dayBucket: view.getBigUint64(24),
    daySpent:  view.getBigUint64(32),
  };
}

/** Box key for an agent: prefix "ag_" (3 bytes) + 32-byte public key */
function agentBoxKey(agentAddress: string): Uint8Array {
  const prefix = new TextEncoder().encode("ag_");
  const pk     = algosdk.decodeAddress(agentAddress).publicKey;
  const key    = new Uint8Array(prefix.length + pk.length);
  key.set(prefix);
  key.set(pk, prefix.length);
  return key;
}

/** Parse algod TealKeyValue array → typed map (key → bigint for uint values) */
function parseGlobalState(raw: algosdk.modelsv2.TealKeyValue[]): Record<string, bigint> {
  const map: Record<string, bigint> = {};
  const dec = new TextDecoder();
  for (const entry of raw) {
    const key = dec.decode(entry.key as Uint8Array);
    if (entry.value.type === 2) {
      map[key] = BigInt(entry.value.uint ?? 0);
    }
  }
  return map;
}

async function runAtc(
  chain: ChainId,
  buildFn: (atc: algosdk.AtomicTransactionComposer, sp: algosdk.SuggestedParams) => void
): Promise<{ txId: string }> {
  const algod = getAlgodClient(chain);
  const sp    = await algod.getTransactionParams().do();
  const atc   = new algosdk.AtomicTransactionComposer();
  buildFn(atc, sp);
  const result = await atc.execute(algod, 4);
  return { txId: result.txIDs[0] };
}

// ── Deploy ────────────────────────────────────────────────────────────────────

/**
 * Deploy a new SpendingCapVault and register the first agent in one flow.
 * Requires the compiled approval/clear bytecode in spending_cap.arc32.json.
 */
export async function deployVault(
  chain:     ChainId,
  ownerSk:   Uint8Array,
  ownerAddr: string,
  agentAddr: string,
  limits:    VaultDeployLimits
): Promise<{ appId: number; appAddress: string; txId: string }> {
  const { approval, clear } = ARC32.byteCode;
  if (!approval || !clear) {
    throw new Error(
      "Contract not compiled.\n" +
      "Run: algokit compile contracts/spending_cap.py\n" +
      "Then paste the base64 bytecode into src/contracts/spending_cap.arc32.json"
    );
  }

  const approvalBytes = Uint8Array.from(atob(approval), (c) => c.charCodeAt(0));
  const clearBytes    = Uint8Array.from(atob(clear),    (c) => c.charCodeAt(0));
  const algod         = getAlgodClient(chain);
  const ownerAccount  = accountFromSk(ownerSk);
  const signer        = algosdk.makeBasicAccountTransactionSigner(ownerAccount);
  const schema        = ARC32.schema;

  // 1. Create the contract
  const createSp  = await algod.getTransactionParams().do();
  const createAtc = new algosdk.AtomicTransactionComposer();
  createAtc.addMethodCall({
    appID:               0,
    method:              M.create,
    methodArgs:          [
      limits.globalMaxPerTxn,
      limits.globalDailyCap,
      limits.globalMaxAsa,
      limits.allowlistEnabled ? 1n : 0n,
    ],
    sender:              ownerAddr,
    suggestedParams:     createSp,
    signer,
    approvalProgram:     approvalBytes,
    clearProgram:        clearBytes,
    numGlobalInts:       schema.globalInts,
    numGlobalByteSlices: schema.globalByteSlices,
    numLocalInts:        schema.localInts,
    numLocalByteSlices:  schema.localByteSlices,
    onComplete:          algosdk.OnApplicationComplete.NoOpOC,
  });

  const createResult = await createAtc.execute(algod, 4);
  const txId = createResult.txIDs[0];

  const txInfo = await algod.pendingTransactionInformation(txId).do();
  const appId  = Number(txInfo.applicationIndex);
  if (!appId) throw new Error("Failed to retrieve app ID from transaction");

  const appAddress = algosdk.getApplicationAddress(appId).toString();

  // 2. Fund vault with enough to cover base account MBR (100_000) +
  //    agent box MBR: 2_500 + 400*(35 key + 40 value) = 32_500  → total 132_500.
  //    We send 200_000 to leave a small fee buffer.
  const fundSp  = await algod.getTransactionParams().do();
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender:          ownerAddr,
    receiver:        appAddress,
    amount:          200_000n,
    suggestedParams: fundSp,
  });
  const signedFund = fundTxn.signTxn(ownerSk);
  const { txid: fundTxId } = await algod.sendRawTransaction(signedFund).do();
  await algosdk.waitForConfirmation(algod, fundTxId, 4);

  // 3. Register the first agent
  const addSp  = await algod.getTransactionParams().do();
  const addAtc = new algosdk.AtomicTransactionComposer();
  addAtc.addMethodCall({
    appID:           appId,
    method:          M.add_agent,
    methodArgs:      [agentAddr, limits.agentMaxPerTxn, limits.agentDailyCap],
    sender:          ownerAddr,
    suggestedParams: addSp,
    signer,
    boxes:           [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
  });
  await addAtc.execute(algod, 4);

  return { appId, appAddress, txId };
}

// ── Read state ────────────────────────────────────────────────────────────────

export async function getVaultGlobalState(
  chain:      ChainId,
  appId:      number,
  appAddress: string
): Promise<VaultGlobalState> {
  const algod   = getAlgodClient(chain);
  const appInfo = await algod.getApplicationByID(appId).do();
  const gs      = parseGlobalState(
    (appInfo.params.globalState as algosdk.modelsv2.TealKeyValue[] | undefined) ?? []
  );

  const acctInfo    = await algod.accountInformation(appAddress).do();
  const vaultBalance = (acctInfo as unknown as { amount: bigint }).amount;

  return {
    globalMaxPerTxn:  gs["g_max_txn"]   ?? 0n,
    globalDailyCap:   gs["g_daily_cap"] ?? 0n,
    globalMaxAsa:     gs["g_max_asa"]   ?? 0n,
    allowlistEnabled: (gs["al_enabled"] ?? 0n) === 1n,
    totalPaid:        gs["total_paid"]  ?? 0n,
    totalPaidAsa:     gs["total_asa"]   ?? 0n,
    txCount:          gs["tx_count"]    ?? 0n,
    vaultBalance,
  };
}

export async function getVaultAgentState(
  chain:     ChainId,
  appId:     number,
  agentAddr: string
): Promise<VaultAgentState | null> {
  try {
    const algod  = getAlgodClient(chain);
    const box    = await algod.getApplicationBoxByName(appId, agentBoxKey(agentAddr)).do();
    return decodeAgentConfig(box.value as Uint8Array);
  } catch {
    return null;
  }
}

// ── Owner actions ─────────────────────────────────────────────────────────────

export async function suspendAgent(
  chain: ChainId, appId: number, ownerSk: Uint8Array, ownerAddr: string, agentAddr: string
): Promise<{ txId: string }> {
  return runAtc(chain, (atc, sp) => {
    atc.addMethodCall({
      appID: appId, method: M.suspend_agent, methodArgs: [agentAddr],
      sender: ownerAddr, suggestedParams: sp,
      signer: algosdk.makeBasicAccountTransactionSigner(accountFromSk(ownerSk)),
      boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
    });
  });
}

export async function resumeAgent(
  chain: ChainId, appId: number, ownerSk: Uint8Array, ownerAddr: string, agentAddr: string
): Promise<{ txId: string }> {
  return runAtc(chain, (atc, sp) => {
    atc.addMethodCall({
      appID: appId, method: M.resume_agent, methodArgs: [agentAddr],
      sender: ownerAddr, suggestedParams: sp,
      signer: algosdk.makeBasicAccountTransactionSigner(accountFromSk(ownerSk)),
      boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
    });
  });
}

export async function updateGlobalLimits(
  chain:     ChainId,
  appId:     number,
  ownerSk:   Uint8Array,
  ownerAddr: string,
  maxPerTxn: bigint,
  dailyCap:  bigint,
  maxAsa:    bigint
): Promise<{ txId: string }> {
  return runAtc(chain, (atc, sp) => {
    atc.addMethodCall({
      appID: appId, method: M.update_global_limits,
      methodArgs: [maxPerTxn, dailyCap, maxAsa],
      sender: ownerAddr, suggestedParams: sp,
      signer: algosdk.makeBasicAccountTransactionSigner(accountFromSk(ownerSk)),
    });
  });
}

export async function ownerWithdraw(
  chain:     ChainId,
  appId:     number,
  ownerSk:   Uint8Array,
  ownerAddr: string,
  receiver:  string,
  amount:    bigint
): Promise<{ txId: string }> {
  return runAtc(chain, (atc, sp) => {
    atc.addMethodCall({
      appID: appId, method: M.owner_withdraw, methodArgs: [receiver, amount],
      sender: ownerAddr, suggestedParams: sp,
      signer: algosdk.makeBasicAccountTransactionSigner(accountFromSk(ownerSk)),
    });
  });
}

// ── Build unsigned txns for WalletConnect owner signing ───────────────────────
// These return raw algosdk.Transaction objects so the popup can sign them via
// the existing WC session (Pera / Defly / Lute) without exposing a private key.

const dummySigner: algosdk.TransactionSigner = async () => [];

/**
 * Build the unsigned ABI create transaction (WC deploy step 1 of 2).
 * Requires compiled bytecode — throws if not present.
 */
export async function buildVaultCreateTxn(
  chain:     ChainId,
  ownerAddr: string,
  limits:    VaultDeployLimits
): Promise<algosdk.Transaction> {
  const { approval, clear } = ARC32.byteCode;
  if (!approval || !clear) {
    throw new Error(
      "Contract not compiled.\n" +
      "Run: algokit compile contracts/spending_cap.py\n" +
      "Then paste bytecode into src/contracts/spending_cap.arc32.json"
    );
  }
  const approvalBytes = Uint8Array.from(atob(approval), (c) => c.charCodeAt(0));
  const clearBytes    = Uint8Array.from(atob(clear),    (c) => c.charCodeAt(0));
  const schema        = ARC32.schema;
  const sp            = await getAlgodClient(chain).getTransactionParams().do();

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: 0, method: M.create,
    methodArgs: [
      limits.globalMaxPerTxn,
      limits.globalDailyCap,
      limits.globalMaxAsa,
      limits.allowlistEnabled ? 1n : 0n,
    ],
    sender: ownerAddr, suggestedParams: sp, signer: dummySigner,
    approvalProgram: approvalBytes, clearProgram: clearBytes,
    numGlobalInts: schema.globalInts, numGlobalByteSlices: schema.globalByteSlices,
    numLocalInts: schema.localInts,  numLocalByteSlices:  schema.localByteSlices,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
  });
  return atc.buildGroup()[0].txn;
}

/**
 * Build the atomic setup group: fund vault + add_agent (WC deploy step 2 of 2).
 * Must be called after step 1 confirmed so appId is known.
 */
export async function buildVaultSetupGroup(
  chain:      ChainId,
  ownerAddr:  string,
  agentAddr:  string,
  appId:      number,
  appAddress: string,
  limits:     VaultDeployLimits
): Promise<algosdk.Transaction[]> {
  const sp = await getAlgodClient(chain).getTransactionParams().do();

  // Fund vault: base account MBR (100_000) + agent box MBR (32_500) + fee buffer → 200_000
  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: ownerAddr, receiver: appAddress, amount: 200_000n, suggestedParams: sp,
  });

  // ABI add_agent call
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId, method: M.add_agent,
    methodArgs: [agentAddr, limits.agentMaxPerTxn, limits.agentDailyCap],
    sender: ownerAddr, suggestedParams: sp, signer: dummySigner,
    boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
  });
  const addAgentTxn = atc.buildGroup()[0].txn;

  // Assign group ID so both txns are atomic
  const txns = [fundTxn, addAgentTxn];
  algosdk.assignGroupID(txns);
  return txns;
}

/**
 * Build a single unsigned owner action txn for WC signing.
 */
export async function buildOwnerActionTxn(
  chain:     ChainId,
  appId:     number,
  ownerAddr: string,
  agentAddr: string,
  action:    "suspend" | "resume" | "update_limits" | "withdraw",
  params:    { maxPerTxn?: bigint; dailyCap?: bigint; maxAsa?: bigint; receiver?: string; amount?: bigint }
): Promise<algosdk.Transaction> {
  const sp  = await getAlgodClient(chain).getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();

  const actionBoxes = [{ appIndex: appId, name: agentBoxKey(agentAddr) }];
  const base = { appID: appId, sender: ownerAddr, suggestedParams: sp, signer: dummySigner };

  if (action === "suspend")  atc.addMethodCall({ ...base, method: M.suspend_agent,        methodArgs: [agentAddr],                                                    boxes: actionBoxes });
  if (action === "resume")   atc.addMethodCall({ ...base, method: M.resume_agent,         methodArgs: [agentAddr],                                                    boxes: actionBoxes });
  if (action === "update_limits") atc.addMethodCall({ ...base, method: M.update_global_limits, methodArgs: [params.maxPerTxn!, params.dailyCap!, params.maxAsa!]         });
  if (action === "withdraw") atc.addMethodCall({ ...base, method: M.owner_withdraw,       methodArgs: [params.receiver!, params.amount!]                              });

  return atc.buildGroup()[0].txn;
}

/**
 * Build atomic remap group: pay box MBR to vault + add_agent.
 * Used when reconnecting an existing vault with a new agent key (no redeploy).
 * Box MBR = 2_500 + 400*(35 key + 40 value) = 32_500 µ. We send 33_000 for a fee buffer.
 */
export async function buildRemapAgentGroup(
  chain:          ChainId,
  ownerAddr:      string,
  agentAddr:      string,
  appId:          number,
  appAddress:     string,
  agentMaxPerTxn: bigint,
  agentDailyCap:  bigint
): Promise<algosdk.Transaction[]> {
  const sp = await getAlgodClient(chain).getTransactionParams().do();

  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: ownerAddr, receiver: appAddress, amount: 33_000n, suggestedParams: sp,
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId, method: M.add_agent,
    methodArgs: [agentAddr, agentMaxPerTxn, agentDailyCap],
    sender: ownerAddr, suggestedParams: sp, signer: dummySigner,
    boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
  });
  const addAgentTxn = atc.buildGroup()[0].txn;

  const txns = [fundTxn, addAgentTxn];
  algosdk.assignGroupID(txns);
  return txns;
}

/**
 * Mnemonic path: fund box MBR + add_agent as atomic group.
 * Used when remapping an existing vault with a new agent key.
 */
export async function addAgentMnemonic(
  chain:          ChainId,
  appId:          number,
  appAddress:     string,
  ownerSk:        Uint8Array,
  ownerAddr:      string,
  agentAddr:      string,
  agentMaxPerTxn: bigint,
  agentDailyCap:  bigint
): Promise<{ txId: string }> {
  const algod        = getAlgodClient(chain);
  const sp           = await algod.getTransactionParams().do();
  const ownerAccount = accountFromSk(ownerSk);
  const signer       = algosdk.makeBasicAccountTransactionSigner(ownerAccount);

  const fundTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: ownerAddr, receiver: appAddress, amount: 33_000n, suggestedParams: sp,
  });

  const atc = new algosdk.AtomicTransactionComposer();
  atc.addTransaction({ txn: fundTxn, signer });
  atc.addMethodCall({
    appID: appId, method: M.add_agent,
    methodArgs: [agentAddr, agentMaxPerTxn, agentDailyCap],
    sender: ownerAddr, suggestedParams: sp, signer,
    boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
  });
  const result = await atc.execute(algod, 4);
  return { txId: result.txIDs[0] };
}

/**
 * Submit an already-signed atomic transaction group (e.g. fund + add_agent).
 */
export async function submitSignedGroup(
  chain:      ChainId,
  signedTxns: Uint8Array[]
): Promise<string> {
  const algod    = getAlgodClient(chain);
  const combined = new Uint8Array(signedTxns.reduce((acc, b) => acc + b.length, 0));
  let offset = 0;
  for (const b of signedTxns) { combined.set(b, offset); offset += b.length; }
  const { txid } = await algod.sendRawTransaction(combined).do();
  await algosdk.waitForConfirmation(algod, txid, 4);
  return txid;
}

// ── Agent payment (called autonomously by the extension) ──────────────────────

export async function vaultPay(
  chain:     ChainId,
  appId:     number,
  agentSk:   Uint8Array,
  agentAddr: string,
  receiver:  string,
  amount:    bigint,
  note:      string
): Promise<{ txId: string }> {
  // ── Pre-flight balance check ─────────────────────────────────────────────
  const algod      = getAlgodClient(chain);
  const vaultAddr  = algosdk.getApplicationAddress(appId).toString();
  const accInfo    = await algod.accountInformation(vaultAddr).do();
  const balance    = BigInt(accInfo.amount);
  const mbr        = BigInt(accInfo.minBalance);
  const required   = amount + mbr + 2_000n; // payment + MBR + outer & inner fees
  if (balance < required) {
    const shortfall = required - balance;
    const MICRO     = 1_000_000n;
    // L3: show up to 4 significant decimal places (trailing zeros stripped)
    const fmt       = (u: bigint) => {
      const whole   = u / MICRO;
      const fracStr = (u % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
      return fracStr.length > 0 ? `${whole}.${fracStr}` : `${whole}`;
    };
    throw new Error(
      `Vault balance too low. Top up the vault with at least ${fmt(shortfall)} more to make this payment.`
    );
  }

  return runAtc(chain, (atc, sp) => {
    atc.addMethodCall({
      appID: appId, method: M.pay,
      methodArgs: [receiver, amount, note],
      sender:      agentAddr,
      suggestedParams: sp,
      signer: algosdk.makeBasicAccountTransactionSigner(accountFromSk(agentSk)),
      boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
    });
  });
}

/**
 * Transfer an ASA (USDC, aUSDC, etc.) from the vault to a receiver.
 * Mirrors vaultPay() but calls the contract's pay_asa method which issues
 * an inner ASA transfer instead of a native payment.
 *
 * The vault must already be opted in to the asset (via opt_in_asa).
 */
export async function vaultAsaPay(
  chain:     ChainId,
  appId:     number,
  agentSk:   Uint8Array,
  agentAddr: string,
  receiver:  string,
  assetId:   number,
  amount:    bigint,
  note:      string
): Promise<{ txId: string }> {
  // Pre-flight: check the vault holds enough of this ASA
  const algod     = getAlgodClient(chain);
  const vaultAddr = algosdk.getApplicationAddress(appId).toString();
  const accInfo   = await algod.accountInformation(vaultAddr).do();

  // Find the ASA holding
  const holding = (accInfo.assets as Array<{ assetId: number; amount: number }>)
    ?.find((a: { assetId: number }) => a.assetId === assetId);
  const asaBalance = holding ? BigInt(holding.amount) : 0n;
  if (asaBalance < amount) {
    throw new Error(
      `Vault ASA balance too low. The vault holds ${asaBalance} units of asset ${assetId} ` +
      `but the payment requires ${amount}. Fund the vault with more of this asset.`
    );
  }

  // Also check native balance covers fees (outer + inner)
  const balance  = BigInt(accInfo.amount);
  const mbr      = BigInt(accInfo.minBalance);
  const feeGuard = mbr + 3_000n; // MBR + outer fee + inner fee + buffer
  if (balance < feeGuard) {
    throw new Error(
      "Vault needs a small ALGO balance to cover transaction fees for ASA transfers."
    );
  }

  return runAtc(chain, (atc, sp) => {
    atc.addMethodCall({
      appID: appId, method: M.pay_asa,
      methodArgs: [receiver, assetId, amount, note],
      sender:      agentAddr,
      suggestedParams: sp,
      signer: algosdk.makeBasicAccountTransactionSigner(accountFromSk(agentSk)),
      boxes: [{ appIndex: appId, name: agentBoxKey(agentAddr) }],
    });
  });
}
