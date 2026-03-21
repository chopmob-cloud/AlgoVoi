/**
 * Central Chrome runtime message router.
 * All messages from content scripts, popup, and approval pages flow through here.
 */

import algosdk from "algosdk";
import { walletStore } from "./wallet-store";
import { getAlgodClient, getAccountState, getSuggestedParams, submitTransaction, waitForConfirmation, waitForIndexed } from "./chain-clients";
import { CHAINS, X402_VERSION } from "@shared/constants";
import {
  handleX402,
  buildAndSignPayment,
  buildPaymentTxnForWC,
  getPendingRequest,
  clearPendingRequest,
  resolveChain,
} from "./x402-handler";
import {
  handleMpp,
  buildAndSignMppPayment,
  buildMppPaymentTxnForWC,
  serializeMppCredential,
  getPendingMppRequest,
  clearPendingMppRequest,
  resolveMppChain,
} from "./mpp-handler";
import {
  handleAp2Payment,
  buildPaymentMandate,
  getPendingAp2Request,
  clearPendingAp2Request,
  getIntentMandates,
} from "./ap2-handler";
import { mcpResolveEnvoi } from "./mcp-client";
import {
  deployVault,
  getVaultGlobalState,
  getVaultAgentState,
  suspendAgent,
  resumeAgent,
  updateGlobalLimits,
  ownerWithdraw,
  buildVaultCreateTxn,
  buildVaultSetupGroup,
  buildOwnerActionTxn,
  buildRemapAgentGroup,
  addAgentMnemonic,
  submitSignedGroup,
} from "./vault-store";
import {
  generatePairingUri,
  getActiveSessions,
  disconnectAgentSession,
  getPendingAgentSignRequest,
  approveAgentSignRequest,
  rejectAgentSignRequest,
} from "./web3wallet-handler";
import { WC_PROJECT_ID } from "@shared/constants";
import { base64ToBytes, randomId } from "@shared/utils/crypto";
import { formatAmount } from "@shared/utils/format";
import {
  getPendingApproval,
  getApprovalWindowId,
  requestApproval,
  resolveApproval,
  rejectApproval,
  countPendingByOrigin,
} from "./approval-handler";
import type { TxnSummary, PendingSignTxnsApproval, PendingSignBytesApproval } from "@shared/types/approval";
import type { X402PaymentPayload } from "@shared/types/x402";
import type { BgRequest } from "@shared/types/messages";
import type { ChainId } from "@shared/types/chain";

type SendResponse = (response: unknown) => void;

// ── Unlock rate-limiting ───────────────────────────────────────────────────────
// C2: Persisted in chrome.storage.session so brute-force counts survive SW suspension.
const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_LOCKOUT_MS   = 30_000; // 30 seconds
const RATE_LIMIT_SESSION_KEY = "algovou_unlock_rate";
interface RateEntry { count: number; resetAt: number }

async function checkUnlockRate(key: string): Promise<void> {
  const now = Date.now();
  const stored = await chrome.storage.session.get(RATE_LIMIT_SESSION_KEY);
  const rateMap = (stored[RATE_LIMIT_SESSION_KEY] as Record<string, RateEntry> | undefined) ?? {};
  const entry = rateMap[key];
  if (entry && now < entry.resetAt) {
    if (entry.count >= MAX_UNLOCK_ATTEMPTS) {
      const remaining = Math.ceil((entry.resetAt - now) / 1000);
      throw new Error(`Too many unlock attempts. Try again in ${remaining}s.`);
    }
    rateMap[key] = { count: entry.count + 1, resetAt: entry.resetAt };
  } else {
    rateMap[key] = { count: 1, resetAt: now + UNLOCK_LOCKOUT_MS };
  }
  await chrome.storage.session.set({ [RATE_LIMIT_SESSION_KEY]: rateMap });
}

async function clearUnlockRate(key: string): Promise<void> {
  const stored = await chrome.storage.session.get(RATE_LIMIT_SESSION_KEY);
  const rateMap = (stored[RATE_LIMIT_SESSION_KEY] as Record<string, RateEntry> | undefined) ?? {};
  delete rateMap[key];
  await chrome.storage.session.set({ [RATE_LIMIT_SESSION_KEY]: rateMap });
}

/** Parse decimal amount string → atomic BigInt without float rounding errors */
function parseDecimalToAtomic(amount: string, decimals: number): bigint {
  const clean = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error("Invalid amount");
  const [intStr, fracStr = ""] = clean.split(".");
  const fracPadded = fracStr.slice(0, decimals).padEnd(decimals, "0");
  const atomic = BigInt(intStr) * BigInt(10 ** decimals) + BigInt(fracPadded);
  // M1: Reject values that exceed the AVM uint64 maximum
  if (atomic > 18_446_744_073_709_551_615n) {
    throw new Error("Amount exceeds maximum representable value (uint64 overflow)");
  }
  return atomic;
}

// ── WC vault binding map ─────────────────────────────────────────────────────
// Stores the expected unsigned txn bytes for each pending WC vault operation.
// Keyed by wcSessionTopic — at most one pending vault op per WC session.
// Prevents a compromised WC relay or rogue popup from substituting a different
// transaction (e.g. rekey, drain) after the background has built and validated it.
interface VaultWcBinding {
  expectedUnsignedB64s: string[]; // ordered — [createTxn] | [fundTxn, addAgentTxn] | [actionTxn]
  expires: number;
}
const _pendingVaultWcBinding = new Map<string, VaultWcBinding>();
const VAULT_WC_BINDING_TTL_MS = 5 * 60 * 1000; // 5 min — matches WC signing session timeout

export function registerMessageHandler(): void {
  chrome.runtime.onMessage.addListener(
    (
      message: BgRequest,
      sender: chrome.runtime.MessageSender,
      sendResponse: SendResponse
    ) => {
      // Always use tabId from Chrome's sender object — never trust message payload
      const tabId = sender.tab?.id ?? -1;
      handleMessage(message, tabId, sender, sendResponse);
      return true; // keep message channel open for async response
    }
  );
}

async function handleMessage(
  msg: BgRequest,
  tabId: number,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse
): Promise<void> {
  try {
    const result = await dispatch(msg, tabId, sender);
    sendResponse({ ok: true, data: result });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    sendResponse({ ok: false, error });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function dispatch(msg: BgRequest, tabId: number, sender: chrome.runtime.MessageSender): Promise<any> {
  switch (msg.type) {
    // ── Wallet lifecycle ──────────────────────────────────────────────────────
    case "WALLET_STATE": {
      const initialized = await walletStore.isInitialized();
      const lockState = initialized ? walletStore.getLockState() : "uninitialized";
      const meta = initialized ? await walletStore.getMeta() : null;
      return { lockState, meta };
    }

    case "WALLET_GET_META":
      return { meta: await walletStore.getMeta() };

    case "WALLET_INIT": {
      const { account } = await walletStore.initialize(msg.password, msg.mnemonic);
      return { success: true, account };
    }

    case "WALLET_UNLOCK": {
      // Rate-limit unlock attempts (keyed by sender origin or extension self)
      const unlockKey = sender.url ? new URL(sender.url).origin : "popup";
      await checkUnlockRate(unlockKey); // C2: now async (session storage)
      try {
        await walletStore.unlock(msg.password);
      } catch (err) {
        throw err; // rate counter already incremented; propagate to caller
      }
      await clearUnlockRate(unlockKey); // C2: now async; reset on success
      broadcastLockState();
      return { success: true };
    }

    case "WALLET_LOCK":
      walletStore.lock();
      broadcastLockState();
      return { success: true };

    case "WALLET_CREATE_ACCOUNT": {
      const account = await walletStore.createAccount(msg.name);
      return { account };
    }

    case "WALLET_IMPORT_ACCOUNT": {
      const account = await walletStore.importAccount(msg.name, msg.mnemonic);
      return { account };
    }

    case "WALLET_REMOVE_ACCOUNT":
      await walletStore.removeAccount(msg.id);
      return { success: true };

    case "WALLET_RENAME_ACCOUNT":
      await walletStore.renameAccount(msg.id, msg.name);
      return { success: true };

    case "WALLET_SET_ACTIVE_ACCOUNT":
      await walletStore.setActiveAccount(msg.id);
      return { success: true };

    case "WALLET_SET_CHAIN": {
      const switchChain = msg.chain as ChainId;
      // H1: Verify the node we're switching to actually serves the expected chain.
      // Prevents a compromised/misconfigured node URL from silently redirecting funds.
      try {
        const params = await getSuggestedParams(switchChain);
        const expectedHash = CHAINS[switchChain].genesisHash;
        // params.genesisHash is a Uint8Array — encode to base64 for comparison
        const genesisHashBytes = params.genesisHash ?? new Uint8Array(0);
        const actualHash = btoa(String.fromCharCode(...Array.from(genesisHashBytes)));
        if (actualHash !== expectedHash) {
          throw new Error(
            `Node genesis hash mismatch for ${switchChain}: ` +
            `expected ${expectedHash}, got ${actualHash}. ` +
            `The configured node URL may be incorrect.`
          );
        }
      } catch (err) {
        // Re-throw genesis mismatch; swallow unreachable-node errors to allow offline switch
        if (err instanceof Error && err.message.includes("genesis hash mismatch")) throw err;
        console.warn(`[AlgoVoi] Could not verify genesis hash for ${switchChain}:`, err);
      }
      await walletStore.setActiveChain(switchChain);
      broadcastChainChange(switchChain);
      return { success: true };
    }

    // ── Chain queries ─────────────────────────────────────────────────────────
    case "CHAIN_GET_ACCOUNT_STATE": {
      const state = await getAccountState(msg.address, msg.chain as ChainId);
      return { state };
    }

    // ── Native coin send ──────────────────────────────────────────────────────
    case "CHAIN_SEND_PAYMENT": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      // Validate destination address (throws if invalid)
      if (!algosdk.isValidAddress(msg.to)) throw new Error("Invalid destination address");
      const chain = msg.chain as ChainId;
      const meta = await walletStore.getMeta();
      const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!senderAddress) throw new Error("No active account");
      const sk = await walletStore.getActiveSecretKey();
      const params = await getSuggestedParams(chain);
      const cfg = CHAINS[chain];
      // BigInt-safe decimal → atomic conversion (avoids float rounding errors)
      const amountAtomic = parseDecimalToAtomic(msg.amount, cfg.decimals);
      // Encode then byte-slice to the AVM 1000-byte note limit (safer than char-slice
      // which would overshoot for multi-byte characters).
      const note = msg.note
        ? new TextEncoder().encode(msg.note).slice(0, 1000)
        : undefined;
      const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: msg.to,
        amount: amountAtomic,
        note,
        suggestedParams: params,
      });
      const signedBytes = txn.signTxn(sk);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    case "CHAIN_SEND_ASSET": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      if (!algosdk.isValidAddress(msg.to)) throw new Error("Invalid destination address");
      // M2: Bounds-check decimals — must be an integer in [0, 19].
      // Prevents parseDecimalToAtomic from receiving garbage that could cause
      // silent truncation, a 10**decimals explosion, or a uint64 overflow bypass.
      if (!Number.isInteger(msg.decimals) || msg.decimals < 0 || msg.decimals > 19) {
        throw new Error("Invalid decimals: must be an integer between 0 and 19");
      }
      const chain = msg.chain as ChainId;
      const meta = await walletStore.getMeta();
      const senderAddress = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!senderAddress) throw new Error("No active account");
      const sk = await walletStore.getActiveSecretKey();
      const params = await getSuggestedParams(chain);
      // Use msg.decimals passed by the frontend (frontend has full AccountAsset metadata)
      const amountAtomic = parseDecimalToAtomic(msg.amount, msg.decimals);
      const note = msg.note
        ? new TextEncoder().encode(msg.note).slice(0, 1000)
        : undefined;
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: senderAddress,
        receiver: msg.to,
        assetIndex: msg.assetId,
        amount: amountAtomic,
        note,
        suggestedParams: params,
      });
      const signedBytes = txn.signTxn(sk);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    // ── Submit pre-signed transaction (WalletConnect flow) ────────────────────
    case "CHAIN_SUBMIT_SIGNED": {
      // L5: Require wallet to be unlocked before submitting WC-signed transactions.
      // Closes the narrow window where a WC session could be used after auto-lock.
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const chain = msg.chain as ChainId;
      const signedBytes = base64ToBytes(msg.signedTxn);
      const txId = await submitTransaction(chain, signedBytes);
      return { txId };
    }

    // ── WalletConnect account management ──────────────────────────────────────
    case "WC_ADD_ACCOUNT": {
      const account = await walletStore.addWCAccount(
        msg.name,
        msg.address,
        msg.sessionTopic,
        msg.peerName,
        msg.chain as ChainId | undefined
      );
      return { account };
    }

    // ── ARC-0027 dApp connector ───────────────────────────────────────────────
    case "ARC27_ENABLE": {
      // Use sender.url (Chrome-provided, unforgeable) — never trust msg.origin from content
      const senderOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!senderOrigin) throw new Error("Cannot determine requesting site origin");
      const meta = await walletStore.getMeta();
      const address = meta.accounts.find((a) => a.id === meta.activeAccountId)?.address;
      if (!address) throw new Error("No active account");
      const addresses = msg.accounts ?? [address];

      // ── Validate requested accounts exist in this wallet ─────────────────────
      // MED-01: msg.accounts is dApp-controlled; reject unknown addresses before
      // they are registered, so connected-site state only holds real accounts.
      if (msg.accounts) {
        const knownAddresses = new Set(meta.accounts.map((a) => a.address));
        const unknown = msg.accounts.filter((addr) => !knownAddresses.has(addr));
        if (unknown.length > 0) {
          throw new Error(
            `Requested accounts not found in wallet: ${unknown.join(", ")}`
          );
        }
      }

      await walletStore.addConnectedSite(senderOrigin, addresses);
      return { accounts: addresses };
    }

    case "ARC27_SIGN_TXNS": {
      // ── Pre-conditions (fail fast before touching the approval queue) ────────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      // Require an explicit enable() call before any signing request.
      // sender.url is Chrome-provided and unforgeable; msg.origin is ignored.
      const signOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!signOrigin) throw new Error("Cannot determine requesting site origin");
      const signConnected = await walletStore.getConnectedAddresses(signOrigin);
      if (signConnected.length === 0) {
        throw new Error(
          `${signOrigin} is not connected. ` +
          `The site must call window.algorand.enable() before requesting signatures.`
        );
      }

      // ── Per-origin pending cap (mirrors x402-handler PENDING_CAP_PER_ORIGIN) ─
      // INFO-05: prevents a single dApp from flooding the approval queue.
      const SIGN_CAP_PER_ORIGIN = 5;
      if (countPendingByOrigin(signOrigin) >= SIGN_CAP_PER_ORIGIN) {
        throw new Error(
          "Too many pending signing requests from this site. " +
          "Please wait for existing requests to complete."
        );
      }

      const signMeta    = await walletStore.getMeta();
      const activeChain = signMeta.activeChain as ChainId;
      const chainCfg    = CHAINS[activeChain];

      // Pre-decode transactions to build display summaries AND run genesis checks
      // early, so the popup is never shown for a request that would fail to sign.
      const txnSummaries: TxnSummary[] = msg.txns.map((b64, i) => {
        const skipped = !!(msg.indexesToSign && !msg.indexesToSign.includes(i));
        if (skipped) return { type: "skip", sender: "", skipped: true };
        try {
          const txnBytes = base64ToBytes(b64);
          const txn = algosdk.decodeUnsignedTransaction(txnBytes);
          // C1 pre-check: reject wrong-chain transactions before opening popup
          const txnGenesisId = (txn as unknown as { genesisID?: string }).genesisID ?? "";
          if (txnGenesisId && txnGenesisId !== chainCfg.genesisId) {
            throw new Error(
              `Transaction ${i} genesisID "${txnGenesisId}" does not match ` +
              `active chain "${chainCfg.genesisId}". Switch chains before signing.`
            );
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = txn as unknown as Record<string, any>;
          const type: string   = t.type ?? "unknown";
          const sender: string = t.from?.toString?.() ?? t.sender?.toString?.() ?? "";
          const receiver: string | undefined = t.to?.toString?.() ?? t.receiver?.toString?.();
          let amount: string | undefined;
          if (typeof t.amount === "bigint" || typeof t.amount === "number") {
            try {
              amount = `${formatAmount(BigInt(t.amount), chainCfg.decimals)} ${chainCfg.ticker}`;
            } catch { amount = String(t.amount); }
          }
          const assetId: number | undefined = t.assetIndex || undefined;

          // ── Dangerous-field extraction ───────────────────────────────────────
          const rekeyTo: string | undefined =
            t.rekeyTo?.toString?.() || undefined;
          const closeRemainderTo: string | undefined =
            t.closeRemainderTo?.toString?.() || undefined;
          const assetCloseTo: string | undefined =
            t.assetCloseTo?.toString?.() || undefined;

          // Actual fee value — UI flags HIGH when > 10× minimum (10 000 µ)
          const feeMicroalgos: number | undefined =
            typeof t.fee === "bigint" ? Number(t.fee)
            : typeof t.fee === "number" ? t.fee
            : undefined;

          // Short validity window — flag when lastValid - firstValid < 10 rounds
          // (~40 s on Algorand). Indicates a time-pressure phishing attempt.
          const firstValid: number = typeof t.firstValid === "bigint" ? Number(t.firstValid)
            : typeof t.firstValid === "number" ? t.firstValid : 0;
          const lastValid: number  = typeof t.lastValid  === "bigint" ? Number(t.lastValid)
            : typeof t.lastValid  === "number" ? t.lastValid  : 0;
          const shortValidityWindow: true | undefined =
            firstValid > 0 && lastValid > 0 && (lastValid - firstValid) < 10
              ? true : undefined;

          // Decode note bytes — try UTF-8, fall back to hex preview
          let note: string | undefined;
          const noteBytes = t.note as Uint8Array | undefined;
          if (noteBytes && noteBytes.length > 0) {
            try {
              note = new TextDecoder("utf-8", { fatal: true })
                .decode(noteBytes.slice(0, 200));
              if (note.length > 120) note = note.slice(0, 120) + "…";
            } catch {
              note = Array.from(noteBytes.slice(0, 24))
                .map((b) => (b as number).toString(16).padStart(2, "0")).join(" ")
                + (noteBytes.length > 24 ? " …" : "");
            }
          }

          // Clawback — revocationTarget forces ASA transfer OUT of another account
          const clawbackFrom: string | undefined =
            t.revocationTarget?.toString?.() || t.assetRevocationTarget?.toString?.() || undefined;

          // Lease — non-zero Uint8Array means the field is set
          const leaseBytes = t.lease as Uint8Array | undefined;
          const hasLease: true | undefined =
            leaseBytes && leaseBytes.length > 0 && leaseBytes.some((b: number) => b !== 0)
              ? true : undefined;

          // Asset freeze fields (afrz transactions)
          const freezeTarget: string | undefined = type === "afrz"
            ? (t.freezeAccount?.toString?.() ?? t.freeze?.toString?.() ?? undefined)
            : undefined;
          // algosdk v3: assetFrozen field; fall back to frozen
          const freezeStateRaw = t.assetFrozen ?? t.frozen;
          const freezing: boolean | undefined = type === "afrz" && freezeStateRaw !== undefined
            ? Boolean(freezeStateRaw) : undefined;

          // Key registration — online (voteKey present) vs offline (no voteKey)
          const keyregOnline: boolean | undefined = type === "keyreg"
            ? !!(t.voteKey) : undefined;

          // appl onCompletion label
          const OC_NAMES: Record<number, string> = {
            0: "NoOp", 1: "OptIn", 2: "CloseOut",
            3: "ClearState", 4: "UpdateApp", 5: "DeleteApp",
          };
          // algosdk v3 uses onComplete (not onCompletion)
          const applType: string | undefined = type === "appl" && typeof t.onComplete === "number"
            ? (OC_NAMES[t.onComplete] ?? String(t.onComplete))
            : undefined;

          return {
            type, sender, receiver, amount, assetId,
            rekeyTo, closeRemainderTo, assetCloseTo,
            feeMicroalgos, note, applType, shortValidityWindow,
            clawbackFrom, hasLease, freezeTarget, freezing, keyregOnline,
          };
        } catch (err) {
          // Re-throw genesis mismatch errors; wrap decode errors as unknown
          if (err instanceof Error && err.message.includes("genesisID")) throw err;
          return { type: "unknown", sender: "", blind: true };
        }
      });

      // ── Queue approval — the message channel stays open until this resolves ──
      const signTxnsId = randomId();
      const signTxnsApproval: PendingSignTxnsApproval = {
        kind: "sign_txns",
        id: signTxnsId,
        origin: signOrigin,
        tabId,
        txns: msg.txns,
        indexesToSign: msg.indexesToSign,
        txnSummaries,
        timestamp: Date.now(),
      };
      // Throws if user rejects, TTL fires, or popup fails to open.
      await requestApproval(signTxnsApproval);

      // ── Post-approval: re-verify lock (user may have locked during popup) ────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet locked during approval");
      walletStore.resetAutoLock();

      // ── Sign (re-runs genesis check as defence-in-depth) ────────────────────
      const freshMeta  = await walletStore.getMeta();
      const freshChain = freshMeta.activeChain as ChainId;
      const freshGenId = CHAINS[freshChain].genesisId;
      const sk = await walletStore.getActiveSecretKey();
      const stxns = msg.txns.map((b64, i) => {
        if (msg.indexesToSign && !msg.indexesToSign.includes(i)) return null;
        const txnBytes = base64ToBytes(b64);
        const txn = algosdk.decodeUnsignedTransaction(txnBytes);
        // C1: defence-in-depth genesis check post-approval
        const txnGenesisId = (txn as unknown as { genesisID?: string }).genesisID ?? "";
        if (txnGenesisId && txnGenesisId !== freshGenId) {
          throw new Error(
            `Transaction genesisID "${txnGenesisId}" does not match active chain ` +
            `"${freshGenId}". Switch to the correct chain before signing.`
          );
        }
        return btoa(String.fromCharCode(...txn.signTxn(sk)));
      });
      return { stxns };
    }

    case "ARC27_SIGN_BYTES": {
      // ── Pre-conditions ───────────────────────────────────────────────────────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      const bytesOrigin = sender.url ? new URL(sender.url).origin : null;
      if (!bytesOrigin) throw new Error("Cannot determine requesting site origin");
      const bytesConnected = await walletStore.getConnectedAddresses(bytesOrigin);
      if (bytesConnected.length === 0) {
        throw new Error(
          `${bytesOrigin} is not connected. ` +
          `The site must call window.algorand.enable() before requesting signatures.`
        );
      }

      // ── Validate signer matches active account ────────────────────────────
      // ARC-0027: the wallet must sign with the requested signer. If the dApp
      // passes a signer the active account cannot satisfy, reject immediately
      // so the popup never shows a misleading "approving address X" prompt while
      // the actual key belongs to address Y.
      const signBytesMeta = await walletStore.getMeta();
      const activeForBytes = signBytesMeta.accounts.find(
        (a) => a.id === signBytesMeta.activeAccountId
      );
      if (!activeForBytes) throw new Error("No active account");
      if (msg.signer !== activeForBytes.address) {
        throw new Error(
          `Signer address does not match the active account. ` +
          `Requested: ${msg.signer}, Active: ${activeForBytes.address}`
        );
      }

      // ── Per-origin pending cap ────────────────────────────────────────────────
      // INFO-05: prevents a single dApp from flooding the approval queue.
      const SIGN_BYTES_CAP_PER_ORIGIN = 5;
      if (countPendingByOrigin(bytesOrigin) >= SIGN_BYTES_CAP_PER_ORIGIN) {
        throw new Error(
          "Too many pending signing requests from this site. " +
          "Please wait for existing requests to complete."
        );
      }

      // ── Queue approval ───────────────────────────────────────────────────────
      const signBytesId = randomId();
      const signBytesApproval: PendingSignBytesApproval = {
        kind: "sign_bytes",
        id: signBytesId,
        origin: bytesOrigin,
        tabId,
        data: msg.data,
        signer: msg.signer,
        timestamp: Date.now(),
      };
      await requestApproval(signBytesApproval);

      // ── Post-approval: re-verify lock ────────────────────────────────────────
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet locked during approval");
      walletStore.resetAutoLock();

      // ── Sign (MX prefix applied here — never before approval) ───────────────
      const sk = await walletStore.getActiveSecretKey();
      const dataBytes = base64ToBytes(msg.data);
      // Prefix with "MX" per ARC-1
      const prefixed = new Uint8Array([0x4d, 0x58, ...dataBytes]);
      const sig = algosdk.signBytes(prefixed, sk);
      return { sig: btoa(String.fromCharCode(...sig)) };
    }

    case "ARC27_DISCONNECT": {
      // H1: Use only the Chrome-provided sender.url — never trust msg.origin (dApp-controlled).
      // If sender.url is absent (non-content-script caller), return a no-op success rather
      // than allowing an unverifiable origin string to delete another site's connection record.
      if (!sender.url) return { success: true };
      const disconnectOrigin = new URL(sender.url).origin;
      await walletStore.removeConnectedSite(disconnectOrigin);
      return { success: true };
    }

    // ── x402 ─────────────────────────────────────────────────────────────────
    case "X402_PAYMENT_NEEDED": {
      const requestId = await handleX402({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        method: msg.method,
        // The inpage script passes rawPaymentRequired (base64 PAYMENT-REQUIRED value)
        rawPaymentRequired: msg.paymentRequirements as unknown as string,
        // Pass the inpage-generated requestId for tab routing only.
        // x402-handler always generates its own internal ID as the map key.
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "X402_GET_PENDING": {
      const req = getPendingRequest(msg.requestId);
      return { request: req };
    }

    case "X402_APPROVE": {
      const req = getPendingRequest(msg.requestId);
      if (!req) throw new Error("Pending request not found");

      // ── Post-approval lock re-check ───────────────────────────────────────
      // Auto-lock may have fired between popup open and user clicking Approve
      // (up to APPROVAL_TTL_MS = 5 min). Fail-closed: reject rather than
      // attempt to sign with a missing or stale key.
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during approval");
      }
      walletStore.resetAutoLock();

      // Check if active account is WalletConnect — can't sign in background
      const approveMeta = await walletStore.getMeta();
      const activeAccount = approveMeta.accounts.find((a) => a.id === approveMeta.activeAccountId);

      if (activeAccount?.type === "walletconnect") {
        // Guard: WC sessions are chain-specific — reject before touching the WC SDK
        // if the payment's chain differs from the chain the session was approved for.
        const paymentChain = resolveChain(req.paymentRequirements.network);
        const accountChain = (activeAccount.wcChain ?? paymentChain ?? "algorand") as ChainId;
        // Only block when wcChain is explicitly recorded and mismatches the payment chain.
        // Accounts created before this field was added (wcChain undefined) skip the guard
        // and let the WC SDK validate the session namespaces directly.
        if (paymentChain && activeAccount.wcChain !== undefined && accountChain !== paymentChain) {
          throw new Error(
            `This payment requires ${CHAINS[paymentChain].name} but your wallet ` +
            `(${activeAccount.wcPeerName ?? "mobile wallet"}) was connected on ` +
            `${CHAINS[accountChain].name}.\n\n` +
            `To fix: remove this account (✕ next to the name), switch to the ` +
            `${CHAINS[paymentChain].name} chain, then use + Connect to re-pair your wallet.`
          );
        }
        // Build unsigned txn and return params to the approval popup.
        // The pending request is intentionally NOT cleared here —
        // it will be cleared by X402_WC_SIGNED once signing completes.
        const wcData = await buildPaymentTxnForWC(req);
        return { needsWcSign: true, ...wcData };
      }

      // Vault account — sign locally
      let paymentHeader: string, txId: string;
      ({ paymentHeader, txId } = await buildAndSignPayment(req));
      clearPendingRequest(msg.requestId);
      chrome.tabs.sendMessage(req.tabId, {
        type: "X402_RESULT",
        // Use inpageRequestId so the inpage _pendingX402 Map can resolve the
        // pending fetch. Falls back to req.id for requests predating this fix.
        requestId: req.inpageRequestId ?? req.id,
        approved: true,
        paymentHeader,
        txId,
      });
      return { paymentHeader, txId };
    }

    case "X402_WC_SIGNED": {
      const req = getPendingRequest(msg.requestId);
      if (!req) throw new Error("Pending request not found");

      const pr = req.paymentRequirements;
      const chain = resolveChain(pr.network);
      if (!chain) throw new Error(`Unsupported network: ${pr.network}`);

      const signedBytes = base64ToBytes(msg.signedTxnB64);

      // MEDIUM-1: validate the signed txn contains exactly the transaction we built.
      // expectedUnsignedTxnB64 is always set by buildPaymentTxnForWC; its absence
      // means this WC request bypassed the build step — reject outright rather than
      // skipping the binding check and accepting an unvalidated transaction.
      if (!req.expectedUnsignedTxnB64) {
        throw new Error("X402_WC_SIGNED: missing expected transaction binding — cannot validate signed bytes.");
      }
      try {
        const decodedSigned = algosdk.decodeSignedTransaction(signedBytes);
        const signedTxnUnsignedBytes = decodedSigned.txn.toByte();
        const signedTxnUnsignedB64 = btoa(String.fromCharCode(...signedTxnUnsignedBytes));
        if (signedTxnUnsignedB64 !== req.expectedUnsignedTxnB64) {
          throw new Error(
            "X402_WC_SIGNED: signed transaction does not match the x402 payment request. " +
            "The WalletConnect wallet may have altered the transaction."
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("X402_WC_SIGNED:")) throw err;
        throw new Error(
          `X402_WC_SIGNED: failed to validate signed transaction: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Resolve the payer address from the active account and assert account hasn't
      // changed since buildPaymentTxnForWC ran (mirrors MPP_WC_SIGNED guard).
      // Fail closed if the account cannot be identified — never send an empty proof.
      const wcMeta = await walletStore.getMeta();
      if (req.wcAccountId !== undefined && wcMeta.activeAccountId !== req.wcAccountId) {
        throw new Error(
          "Active account changed after x402 WC payment request was initiated. " +
          "Reject the original request and retry with the current account."
        );
      }
      const payer = wcMeta.accounts.find((a) => a.id === wcMeta.activeAccountId)?.address;
      if (!payer) throw new Error("Cannot determine payer address for WC payment proof");

      // Clear pending BEFORE the long async submission so TTL cannot clear state
      // mid-flight and a second X402_WC_SIGNED cannot race through.
      clearPendingRequest(msg.requestId);

      // Submit and capture the on-chain txId for the proof payload.
      const txId = await submitTransaction(chain, signedBytes);

      // Wait for algod confirmation then poll indexer — eliminates tx_not_found.
      await waitForConfirmation(chain, txId, 8);
      await waitForIndexed(chain, txId);

      // Re-encode as standard base64 in case Defly/Pera returned URL-safe base64
      const signedTxnStdB64 = btoa(String.fromCharCode(...signedBytes));
      const wcPayload: X402PaymentPayload = {
        x402Version: X402_VERSION,
        scheme: pr.scheme,
        network: pr.network,
        payload: {
          txId,
          payer,
          // Included during rollout for backward compat with pre-production servers.
          // Remove once all servers verify via txId only.
          transaction: signedTxnStdB64,
        },
      };
      const paymentHeader = btoa(JSON.stringify(wcPayload));

      chrome.tabs.sendMessage(req.tabId, {
        type: "X402_RESULT",
        requestId: req.inpageRequestId ?? req.id,
        approved: true,
        paymentHeader,
        txId,
      }).catch(() => {});
      return { paymentHeader, txId };
    }

    case "X402_REJECT": {
      const req = getPendingRequest(msg.requestId);
      if (req) {
        clearPendingRequest(msg.requestId);
        chrome.tabs.sendMessage(req.tabId, {
          type: "X402_RESULT",
          requestId: req.inpageRequestId ?? req.id,
          approved: false,
        });
      }
      return { success: true };
    }

    case "X402_GET_HISTORY":
      // Phase 2: payment history persistence is deferred; returns empty list for now.
      return { records: [] };

    // ── MPP avm payments ──────────────────────────────────────────────────────
    case "MPP_PAYMENT_NEEDED": {
      const requestId = await handleMpp({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        method: msg.method,
        rawChallenge: msg.rawChallenge,
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "MPP_GET_PENDING": {
      // Return the display-ready PendingMppApproval from the unified approval handler,
      // not the raw PendingMppRequest — the popup needs flat fields (recipient, realm,
      // currencyLabel, isWalletConnect, etc.) that only exist on PendingMppApproval.
      const mppPendingApproval = getPendingApproval(msg.requestId);
      if (mppPendingApproval?.kind === "mpp_charge") return { request: mppPendingApproval };
      return { request: null };
    }

    case "MPP_APPROVE": {
      const mppReq = getPendingMppRequest(msg.requestId);
      if (!mppReq) throw new Error("Pending MPP request not found");

      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during MPP approval");
      }
      walletStore.resetAutoLock();

      // Check if active account is WalletConnect — route to WC signing
      const mppMeta = await walletStore.getMeta();
      const mppAccount = mppMeta.accounts.find((a) => a.id === mppMeta.activeAccountId);

      // MEDIUM-2: assert the active account hasn't changed since the request was queued
      if (mppReq.accountId !== undefined && mppMeta.activeAccountId !== mppReq.accountId) {
        throw new Error(
          "Active account changed after MPP payment request was initiated. " +
          "Please reject this request and initiate a new payment."
        );
      }

      if (!mppAccount) throw new Error("Active account not found for MPP payment");
      if (mppAccount.type === "walletconnect") {
        const wcData = await buildMppPaymentTxnForWC(mppReq);
        // Persist the updated request (with expectedUnsignedTxnB64 set by buildMppPaymentTxnForWC)
        // to session storage so MPP_WC_SIGNED can recover it if the SW is suspended during
        // the 30-60s the user spends approving on their mobile wallet.
        await chrome.storage.session.set({ [`algovou_mpp_wc_${mppReq.id}`]: mppReq });
        return { needsWcSign: true, ...wcData };
      }

      // Vault account — sign locally.
      // Read popup window ID and clear the pending request BEFORE the long async signing
      // operation to prevent: (a) TTL expiring during signing and clearing _windowIds before
      // we can read it; (b) a duplicate MPP_APPROVE arriving while signing is in progress.
      const mppPopupWindowId = getApprovalWindowId(msg.requestId);
      clearPendingMppRequest(msg.requestId);
      const { authorizationHeader, txId } = await buildAndSignMppPayment(mppReq);

      // Notify the inpage script so it can retry the fetch with Authorization header
      chrome.tabs.sendMessage(mppReq.tabId, {
        type: "MPP_RESULT",
        requestId: mppReq.inpageRequestId ?? mppReq.id,
        approved: true,
        authorizationHeader,
        txId,
      }).catch(() => {}); // tab may have been closed since the request was initiated
      // Close the approval popup from the background. More reliable than window.close()
      // in the popup page — works even if the MV3 sendResponse channel has expired.
      if (mppPopupWindowId !== undefined) {
        chrome.windows.remove(mppPopupWindowId).catch(() => {});
      }
      return { authorizationHeader, txId };
    }

    case "MPP_REJECT": {
      // Popup always calls window.close() after sending this message, so no
      // background-side window removal is needed. TTL handles any crash/leak.
      const mppReqToReject = getPendingMppRequest(msg.requestId);
      if (mppReqToReject) {
        clearPendingMppRequest(msg.requestId);
        chrome.tabs.sendMessage(mppReqToReject.tabId, {
          type: "MPP_RESULT",
          requestId: mppReqToReject.inpageRequestId ?? mppReqToReject.id,
          approved: false,
          error: "User rejected MPP payment",
        }).catch(() => {}); // tab may have been closed since the request was initiated
      }
      return { success: true };
    }

    case "MPP_WC_SIGNED": {
      let mppWcReq = getPendingMppRequest(msg.requestId);
      if (!mppWcReq) {
        // SW may have been suspended during mobile wallet approval — recover from session storage.
        const stored = await chrome.storage.session.get(`algovou_mpp_wc_${msg.requestId}`);
        mppWcReq = (stored[`algovou_mpp_wc_${msg.requestId}`] as typeof mppWcReq) ?? null;
      }
      if (!mppWcReq) throw new Error("Pending MPP request not found (expired or already processed)");
      // Always clean up session storage regardless of outcome
      chrome.storage.session.remove(`algovou_mpp_wc_${msg.requestId}`).catch(() => {});

      const avmReq = mppWcReq.avmRequest;
      const chain = resolveMppChain(avmReq.network);
      if (!chain) throw new Error(`Unsupported MPP network: ${avmReq.network}`);

      // Resolve expected payer before touching signed bytes
      const wcMppMeta = await walletStore.getMeta();
      const wcMppAccount = wcMppMeta.accounts.find((a) => a.id === wcMppMeta.activeAccountId);
      if (!wcMppAccount) throw new Error("Cannot determine payer address for MPP WC payment");

      // Assert active account hasn't changed since request was queued (mirrors MPP_APPROVE guard)
      if (mppWcReq.accountId !== undefined && wcMppMeta.activeAccountId !== mppWcReq.accountId) {
        throw new Error(
          "Active account changed after MPP payment request was initiated. " +
          "Please reject this request and initiate a new payment."
        );
      }

      const signedBytes = base64ToBytes(msg.signedTxnB64);

      // MEDIUM-1: validate the signed txn contains exactly the transaction we built.
      // expectedUnsignedTxnB64 is always set by buildMppPaymentTxnForWC; its absence
      // means this WC request bypassed the build step — reject outright rather than
      // skipping the binding check and accepting an unvalidated transaction.
      if (!mppWcReq.expectedUnsignedTxnB64) {
        throw new Error("MPP_WC_SIGNED: missing expected transaction binding — cannot validate signed bytes.");
      }
      try {
        const decodedSigned = algosdk.decodeSignedTransaction(signedBytes);
        const signedTxnUnsignedBytes = decodedSigned.txn.toByte();
        const signedTxnUnsignedB64 = btoa(String.fromCharCode(...signedTxnUnsignedBytes));
        if (signedTxnUnsignedB64 !== mppWcReq.expectedUnsignedTxnB64) {
          throw new Error(
            "MPP_WC_SIGNED: signed transaction does not match the MPP payment request. " +
            "The WalletConnect wallet may have altered the transaction."
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("MPP_WC_SIGNED:")) throw err;
        throw new Error(
          `MPP_WC_SIGNED: failed to validate signed transaction: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Read popup window ID and clear pending BEFORE the long async submission
      // so TTL expiry during on-chain confirmation cannot clear _windowIds first.
      const mppWcPopupWindowId = getApprovalWindowId(msg.requestId);
      clearPendingMppRequest(msg.requestId);

      const txId = await submitTransaction(chain, signedBytes);
      await waitForConfirmation(chain, txId, 8);
      await waitForIndexed(chain, txId);

      const mppCredential = {
        challenge: mppWcReq.challenge,
        source: `did:pkh:avm:${avmReq.network}:${wcMppAccount.address}`,
        payload: {
          txId,
          transaction: btoa(String.fromCharCode(...signedBytes)),
        },
      };
      const authorizationHeader = serializeMppCredential(mppCredential);

      chrome.tabs.sendMessage(mppWcReq.tabId, {
        type: "MPP_RESULT",
        requestId: mppWcReq.inpageRequestId ?? mppWcReq.id,
        approved: true,
        authorizationHeader,
        txId,
      }).catch(() => {}); // tab may have been closed since the request was initiated
      if (mppWcPopupWindowId !== undefined) {
        chrome.windows.remove(mppWcPopupWindowId).catch(() => {});
      }
      return { authorizationHeader, txId };
    }

    // ── AP2 (Agent Payments Protocol) ────────────────────────────────────────
    case "AP2_PAYMENT_REQUEST": {
      const requestId = await handleAp2Payment({
        tabId: sender?.tab?.id ?? tabId,
        url: msg.url,
        cartMandate: msg.cartMandate,
        inpageRequestId: msg.requestId,
      });
      return { requestId };
    }

    case "AP2_GET_PENDING": {
      const ap2Req = getPendingAp2Request(msg.requestId);
      return { request: ap2Req };
    }

    case "AP2_APPROVE": {
      const ap2Req = getPendingAp2Request(msg.requestId);
      if (!ap2Req) throw new Error("Pending AP2 request not found");

      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during AP2 approval");
      }
      walletStore.resetAutoLock();

      // Find a matching IntentMandate if available (first non-expired one)
      const intentMandates = await getIntentMandates();
      const nowAp2 = Date.now();
      const matchingIntent = intentMandates.find((m) => {
        if (m.network !== ap2Req.network) return false;
        if (m.address !== ap2Req.address) return false;
        if (m.intent_expiry) {
          const expiresAt = new Date(m.intent_expiry).getTime();
          if (!isNaN(expiresAt) && nowAp2 > expiresAt) return false;
        }
        return true;
      });

      // Enforce IntentMandate spending cap if currencies match
      if (matchingIntent?.max_amount && matchingIntent.currency) {
        const cartTotal = parseFloat(ap2Req.total.value);
        const cap = parseFloat(matchingIntent.max_amount);
        if (
          matchingIntent.currency.toUpperCase() === ap2Req.total.currency.toUpperCase() &&
          !isNaN(cartTotal) && !isNaN(cap) && cartTotal > cap
        ) {
          throw new Error(
            `CartMandate total ${ap2Req.total.value} ${ap2Req.total.currency} ` +
            `exceeds IntentMandate spending cap of ${matchingIntent.max_amount} ${matchingIntent.currency}`
          );
        }
      }

      // Re-verify CartMandate expiry at signing time (defense-in-depth; UI may race)
      if (ap2Req.expiry) {
        const expiresAt = new Date(ap2Req.expiry).getTime();
        if (!isNaN(expiresAt) && Date.now() > expiresAt) {
          throw new Error("CartMandate has expired — cannot sign PaymentMandate");
        }
      }

      // Build and sign the PaymentMandate using the stored CartMandate
      // (retained in PendingAp2Approval for correct hash computation)
      const paymentMandate = await buildPaymentMandate({
        cartMandate: ap2Req.cartMandate,
        intentMandateId: matchingIntent?.id ?? "",
        network: ap2Req.network,
        address: ap2Req.address,
      });

      clearPendingAp2Request(msg.requestId);
      resolveApproval(msg.requestId);

      // Notify the inpage script so its pending Promise can resolve
      chrome.tabs.sendMessage(ap2Req.tabId, {
        type: "AP2_RESULT",
        requestId: ap2Req.inpageRequestId ?? ap2Req.id,
        approved: true,
        paymentMandate,
      });
      return { paymentMandate };
    }

    case "AP2_REJECT": {
      const ap2ReqToReject = getPendingAp2Request(msg.requestId);
      if (ap2ReqToReject) {
        clearPendingAp2Request(msg.requestId);
        rejectApproval(msg.requestId, "User rejected AP2 payment credential");
        chrome.tabs.sendMessage(ap2ReqToReject.tabId, {
          type: "AP2_RESULT",
          requestId: ap2ReqToReject.inpageRequestId ?? ap2ReqToReject.id,
          approved: false,
          error: "User rejected AP2 payment credential",
        });
      }
      return { success: true };
    }

    case "AP2_LIST_INTENT_MANDATES": {
      const mandates = await getIntentMandates();
      return { mandates };
    }

    // ── WalletConnect Web3Wallet (AlgoVoi as wallet for AI agents) ───────────

    case "W3W_GENERATE_URI": {
      const uri = await generatePairingUri(WC_PROJECT_ID);
      return { uri };
    }

    case "W3W_GET_SESSIONS": {
      const sessions = getActiveSessions();
      return { sessions };
    }

    case "W3W_DISCONNECT": {
      await disconnectAgentSession(msg.topic);
      return { success: true };
    }

    case "W3W_AGENT_SIGN_GET_PENDING": {
      const agentReq = getPendingAgentSignRequest(msg.requestId);
      return { request: agentReq };
    }

    case "W3W_AGENT_SIGN_APPROVE": {
      const agentReq = getPendingAgentSignRequest(msg.requestId);
      if (!agentReq) throw new Error("Pending agent sign request not found");
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet locked during agent sign approval");
      }
      walletStore.resetAutoLock();
      const agentMeta = await walletStore.getMeta();
      const agentAccount = agentMeta.accounts.find((a) => a.id === agentMeta.activeAccountId);
      if (!agentAccount || agentAccount.type === "walletconnect") {
        throw new Error("Agent signing requires a vault/mnemonic account");
      }
      // MEDIUM-2: assert active account hasn't changed since the request was queued
      if (agentReq.accountId !== undefined && agentMeta.activeAccountId !== agentReq.accountId) {
        throw new Error(
          "Active account changed after agent signing request was initiated. " +
          "Please reject this request and ask the agent to retry."
        );
      }
      const agentSk = await walletStore.getActiveSecretKey();
      const signedTxns = await approveAgentSignRequest(msg.requestId, agentSk, agentAccount.address);
      return { signedTxns };
    }

    case "W3W_AGENT_SIGN_REJECT": {
      await rejectAgentSignRequest(msg.requestId);
      return { success: true };
    }

    // ── enVoi name resolution ─────────────────────────────────────────────────
    case "VOI_RESOLVE_NAME": {
      // Guard: only available on Voi chain with an unlocked wallet
      const resolveMeta = await walletStore.getMeta();
      if (resolveMeta.activeChain !== "voi") {
        throw new Error("Name service is only available on the Voi chain");
      }
      if (walletStore.getLockState() !== "unlocked") {
        throw new Error("Wallet is locked — unlock before resolving .voi names");
      }
      const { address, displayName } = await mcpResolveEnvoi(msg.name);
      return { address, displayName };
    }

    // ── Unified approval flow ─────────────────────────────────────────────────
    // Handled by approval-handler.ts; used by ARC-0027 and enVoi popups.

    case "APPROVAL_GET_PENDING": {
      const approval = getPendingApproval(msg.requestId);
      return { approval };
    }

    case "APPROVAL_APPROVE": {
      // Only settle if the request is still pending (idempotent if already gone)
      const approvalForApprove = getPendingApproval(msg.requestId);
      if (!approvalForApprove) {
        throw new Error("Approval request not found — it may have already been settled or timed out");
      }
      resolveApproval(msg.requestId);
      return { success: true };
    }

    case "APPROVAL_REJECT": {
      // Fail-open: don't throw if the request isn't found (popup may close late
      // after TTL already fired, or user double-clicked Reject).
      rejectApproval(msg.requestId, "User rejected the request");
      return { success: true };
    }

    // ── SpendingCapVault — on-chain agent spending limits ─────────────────────

    case "VAULT_GET_STATE": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock(); // L2: polling from the vault panel should keep the session alive
      const vaultApp = walletStore.getVaultApp(msg.chain);
      if (!vaultApp) return { deployed: false };
      const agentAddr = walletStore.getAgentAddress();
      const [global, agent] = await Promise.all([
        getVaultGlobalState(msg.chain, vaultApp.appId, vaultApp.appAddress),
        agentAddr ? getVaultAgentState(msg.chain, vaultApp.appId, agentAddr) : Promise.resolve(null),
      ]);
      return {
        deployed: true,
        appId:      vaultApp.appId,
        appAddress: vaultApp.appAddress,
        agentAddress: agentAddr,
        global:  serializeBigInt(global),
        agent:   agent ? serializeBigInt(agent) : null,
      };
    }

    case "VAULT_DEPLOY": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const deployMeta    = await walletStore.getMeta();
      const deployAccount = deployMeta.accounts.find((a) => a.id === deployMeta.activeAccountId);
      if (!deployAccount) throw new Error("No active account");

      // Generate agent key if not already created (works for both mnemonic and WC owners)
      let agentAddr = walletStore.getAgentAddress();
      if (!agentAddr) agentAddr = await walletStore.createAgentKey();

      const limits = {
        globalMaxPerTxn:  BigInt(msg.globalMaxPerTxn),
        globalDailyCap:   BigInt(msg.globalDailyCap),
        globalMaxAsa:     BigInt(msg.globalMaxAsa),
        allowlistEnabled: msg.allowlistEnabled,
        agentMaxPerTxn:   BigInt(msg.agentMaxPerTxn),
        agentDailyCap:    BigInt(msg.agentDailyCap),
      };

      if (deployAccount.type === "walletconnect") {
        // WC path: return unsigned create txn → popup signs → VAULT_WC_SUBMIT_CREATE
        if (!deployAccount.wcSessionTopic) throw new Error("No WalletConnect session for this account");
        const createTxn = await buildVaultCreateTxn(msg.chain, deployAccount.address, limits);
        const createUnsignedB64 = btoa(String.fromCharCode(...createTxn.toByte()));
        // H1: store expected create txn bytes — validated in VAULT_WC_SUBMIT_CREATE
        _pendingVaultWcBinding.set(deployAccount.wcSessionTopic, {
          expectedUnsignedB64s: [createUnsignedB64],
          expires: Date.now() + VAULT_WC_BINDING_TTL_MS,
        });
        return {
          needsWcSign:    true,
          step:           "create",
          unsignedTxnB64: createUnsignedB64,
          chain:          msg.chain,
          sessionTopic:   deployAccount.wcSessionTopic,
          signerAddress:  deployAccount.address,
          agentAddress:   agentAddr,
          agentMaxPerTxn: msg.agentMaxPerTxn,
          agentDailyCap:  msg.agentDailyCap,
        };
      }

      // Mnemonic path: sign and submit all steps in background
      const ownerSk = await walletStore.getActiveSecretKey();
      const result  = await deployVault(msg.chain, ownerSk, deployAccount.address, agentAddr, limits);
      await walletStore.saveVaultApp(msg.chain, result.appId, result.appAddress);
      return { appId: result.appId, appAddress: result.appAddress, agentAddress: agentAddr, txId: result.txId };
    }

    case "VAULT_WC_SUBMIT_CREATE": {
      // Submit signed create txn, get appId, build setup group for WC step 2
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      // H2: base64ToBytes handles URL-safe base64 from Defly/Lute (atob() rejects it)
      const signedCreateBytes = base64ToBytes(msg.signedTxnB64);

      // H1: validate the signed create txn matches exactly what VAULT_DEPLOY built
      const wcCreateMeta = await walletStore.getMeta();
      const wcCreateAcct = wcCreateMeta.accounts.find((a) => a.id === wcCreateMeta.activeAccountId);
      if (!wcCreateAcct?.wcSessionTopic) throw new Error("No active WalletConnect account");
      const createBinding = _pendingVaultWcBinding.get(wcCreateAcct.wcSessionTopic);
      if (!createBinding) {
        throw new Error("VAULT_WC_SUBMIT_CREATE: no pending vault create session — please retry deploy");
      }
      if (Date.now() > createBinding.expires) {
        _pendingVaultWcBinding.delete(wcCreateAcct.wcSessionTopic);
        throw new Error("VAULT_WC_SUBMIT_CREATE: deploy session expired — please retry");
      }
      try {
        const decodedCreate = algosdk.decodeSignedTransaction(signedCreateBytes);
        const createUnsignedB64 = btoa(String.fromCharCode(...decodedCreate.txn.toByte()));
        if (createUnsignedB64 !== createBinding.expectedUnsignedB64s[0]) {
          throw new Error(
            "VAULT_WC_SUBMIT_CREATE: signed transaction does not match the vault create request. " +
            "The WalletConnect wallet may have altered the transaction."
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("VAULT_WC_SUBMIT_CREATE:")) throw err;
        throw new Error(
          `VAULT_WC_SUBMIT_CREATE: failed to validate signed transaction: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
      _pendingVaultWcBinding.delete(wcCreateAcct.wcSessionTopic);

      // C3: use static import instead of dynamic import
      const algodCreate = getAlgodClient(msg.chain);
      const { txid }    = await algodCreate.sendRawTransaction(signedCreateBytes).do();
      await algosdk.waitForConfirmation(algodCreate, txid, 4);
      const txInfo  = await algodCreate.pendingTransactionInformation(txid).do();
      const appId   = Number(txInfo.applicationIndex);
      if (!appId) throw new Error("Create txn confirmed but no app ID returned");
      const appAddress = algosdk.getApplicationAddress(appId).toString();

      // Build fund + add_agent group for step 2
      const agentAddr2 = walletStore.getAgentAddress();
      if (!agentAddr2) throw new Error("No agent key");

      const setupGroup = await buildVaultSetupGroup(msg.chain, wcCreateAcct.address, agentAddr2, appId, appAddress, {
        globalMaxPerTxn: 0n, globalDailyCap: 0n, globalMaxAsa: 0n, allowlistEnabled: false,
        agentMaxPerTxn:  BigInt(msg.agentMaxPerTxn),
        agentDailyCap:   BigInt(msg.agentDailyCap),
      });
      const setupGroupBytes = setupGroup.map((txn) => txn.toByte());

      // H1: store expected setup group bytes for binding check in VAULT_WC_SUBMIT_SETUP
      _pendingVaultWcBinding.set(wcCreateAcct.wcSessionTopic, {
        expectedUnsignedB64s: setupGroupBytes.map((b) => btoa(String.fromCharCode(...b))),
        expires: Date.now() + VAULT_WC_BINDING_TTL_MS,
      });

      return {
        appId,
        appAddress,
        setupGroupB64s: setupGroupBytes.map((b) => btoa(String.fromCharCode(...b))),
        sessionTopic:   wcCreateAcct.wcSessionTopic,
        signerAddress:  wcCreateAcct.address,
        chain:          msg.chain,
      };
    }

    case "VAULT_WC_SUBMIT_SETUP": {
      // Submit signed fund + add_agent group, finalise vault
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      // H2: base64ToBytes handles URL-safe base64 from Defly/Lute
      const signedSetupGroup = msg.signedGroupB64s.map((b64) => base64ToBytes(b64));

      // H1: validate each signed txn in the group against the expected bytes stored in VAULT_WC_SUBMIT_CREATE
      const wcSetupMeta = await walletStore.getMeta();
      const wcSetupAcct = wcSetupMeta.accounts.find((a) => a.id === wcSetupMeta.activeAccountId);
      if (!wcSetupAcct?.wcSessionTopic) throw new Error("No active WalletConnect account");
      const setupBinding = _pendingVaultWcBinding.get(wcSetupAcct.wcSessionTopic);
      if (!setupBinding) {
        throw new Error("VAULT_WC_SUBMIT_SETUP: no pending vault setup session — please retry deploy");
      }
      if (Date.now() > setupBinding.expires) {
        _pendingVaultWcBinding.delete(wcSetupAcct.wcSessionTopic);
        throw new Error("VAULT_WC_SUBMIT_SETUP: setup session expired — please retry");
      }
      if (signedSetupGroup.length !== setupBinding.expectedUnsignedB64s.length) {
        throw new Error(
          `VAULT_WC_SUBMIT_SETUP: expected ${setupBinding.expectedUnsignedB64s.length} signed transactions, ` +
          `got ${signedSetupGroup.length}`
        );
      }
      for (let i = 0; i < signedSetupGroup.length; i++) {
        try {
          const decoded = algosdk.decodeSignedTransaction(signedSetupGroup[i]);
          const unsignedB64 = btoa(String.fromCharCode(...decoded.txn.toByte()));
          if (unsignedB64 !== setupBinding.expectedUnsignedB64s[i]) {
            throw new Error(
              `VAULT_WC_SUBMIT_SETUP: transaction ${i} does not match the expected vault setup transaction. ` +
              "The WalletConnect wallet may have altered the transaction."
            );
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("VAULT_WC_SUBMIT_SETUP:")) throw err;
          throw new Error(
            `VAULT_WC_SUBMIT_SETUP: failed to validate transaction ${i}: ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      _pendingVaultWcBinding.delete(wcSetupAcct.wcSessionTopic);

      const txId = await submitSignedGroup(msg.chain, signedSetupGroup);
      await walletStore.saveVaultApp(msg.chain, msg.appId, msg.appAddress);
      const agentAddr3 = walletStore.getAgentAddress();
      return { txId, agentAddress: agentAddr3 };
    }

    case "VAULT_WC_ACTION_SUBMIT": {
      // Submit a signed owner action txn (suspend/resume/update/withdraw)
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      // H2: base64ToBytes handles URL-safe base64 from Defly/Lute
      const signedActionBytes = base64ToBytes(msg.signedTxnB64);

      // H1: validate signed txn matches what VAULT_ACTION built
      const wcActionMeta = await walletStore.getMeta();
      const wcActionAcct = wcActionMeta.accounts.find((a) => a.id === wcActionMeta.activeAccountId);
      if (!wcActionAcct?.wcSessionTopic) throw new Error("No active WalletConnect account");
      const actionBinding = _pendingVaultWcBinding.get(wcActionAcct.wcSessionTopic);
      if (!actionBinding) {
        throw new Error("VAULT_WC_ACTION_SUBMIT: no pending vault action session — please retry");
      }
      if (Date.now() > actionBinding.expires) {
        _pendingVaultWcBinding.delete(wcActionAcct.wcSessionTopic);
        throw new Error("VAULT_WC_ACTION_SUBMIT: action session expired — please retry");
      }
      try {
        const decodedAction = algosdk.decodeSignedTransaction(signedActionBytes);
        const actionUnsignedB64 = btoa(String.fromCharCode(...decodedAction.txn.toByte()));
        if (actionUnsignedB64 !== actionBinding.expectedUnsignedB64s[0]) {
          throw new Error(
            "VAULT_WC_ACTION_SUBMIT: signed transaction does not match the expected vault action. " +
            "The WalletConnect wallet may have altered the transaction."
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("VAULT_WC_ACTION_SUBMIT:")) throw err;
        throw new Error(
          `VAULT_WC_ACTION_SUBMIT: failed to validate signed transaction: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
      }
      _pendingVaultWcBinding.delete(wcActionAcct.wcSessionTopic);

      // C3: use static import instead of dynamic import
      const algodAction = getAlgodClient(msg.chain);
      const { txid: txIdAction } = await algodAction.sendRawTransaction(signedActionBytes).do();
      await algosdk.waitForConfirmation(algodAction, txIdAction, 4);
      return { txId: txIdAction };
    }

    case "VAULT_ACTION": {
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();
      const actionMeta = await walletStore.getMeta();
      const actionAccount = actionMeta.accounts.find((a) => a.id === actionMeta.activeAccountId);
      if (!actionAccount) throw new Error("No active account");
      const actionVaultApp = walletStore.getVaultApp(msg.chain);
      if (!actionVaultApp) throw new Error("No vault deployed on this chain");
      const agentAddrForAction = walletStore.getAgentAddress();
      if (!agentAddrForAction) throw new Error("No agent key found");

      if (actionAccount.type === "walletconnect") {
        // WC path: build unsigned txn → popup signs → VAULT_WC_ACTION_SUBMIT
        if (!actionAccount.wcSessionTopic) throw new Error("No WalletConnect session for this account");
        const wcActionParams: {
          maxPerTxn?: bigint; dailyCap?: bigint; maxAsa?: bigint;
          receiver?: string; amount?: bigint;
        } = {};
        if (msg.maxPerTxn) wcActionParams.maxPerTxn = BigInt(msg.maxPerTxn);
        if (msg.dailyCap)  wcActionParams.dailyCap  = BigInt(msg.dailyCap);
        if (msg.maxAsa)    wcActionParams.maxAsa    = BigInt(msg.maxAsa);
        if (msg.receiver)  wcActionParams.receiver  = msg.receiver;
        if (msg.amount)    wcActionParams.amount    = BigInt(msg.amount);
        const wcActionTxn  = await buildOwnerActionTxn(
          msg.chain, actionVaultApp.appId, actionAccount.address, agentAddrForAction, msg.action, wcActionParams
        );
        const actionUnsignedB64 = btoa(String.fromCharCode(...wcActionTxn.toByte()));
        // H1: store expected bytes for binding check in VAULT_WC_ACTION_SUBMIT
        _pendingVaultWcBinding.set(actionAccount.wcSessionTopic, {
          expectedUnsignedB64s: [actionUnsignedB64],
          expires: Date.now() + VAULT_WC_BINDING_TTL_MS,
        });
        return {
          needsWcSign:    true,
          unsignedTxnB64: actionUnsignedB64,
          sessionTopic:   actionAccount.wcSessionTopic,
          signerAddress:  actionAccount.address,
          chain:          msg.chain,
        };
      }

      // Mnemonic path: sign and submit directly
      const actionOwnerSk = await walletStore.getActiveSecretKey();
      if (msg.action === "suspend") {
        const r = await suspendAgent(msg.chain, actionVaultApp.appId, actionOwnerSk, actionAccount.address, agentAddrForAction);
        return { txId: r.txId };
      }
      if (msg.action === "resume") {
        const r = await resumeAgent(msg.chain, actionVaultApp.appId, actionOwnerSk, actionAccount.address, agentAddrForAction);
        return { txId: r.txId };
      }
      if (msg.action === "update_limits") {
        if (!msg.maxPerTxn || !msg.dailyCap || !msg.maxAsa) throw new Error("Missing limit params");
        const r = await updateGlobalLimits(
          msg.chain, actionVaultApp.appId, actionOwnerSk, actionAccount.address,
          BigInt(msg.maxPerTxn), BigInt(msg.dailyCap), BigInt(msg.maxAsa)
        );
        return { txId: r.txId };
      }
      if (msg.action === "withdraw") {
        if (!msg.receiver || !msg.amount) throw new Error("Missing receiver or amount");
        // L1: validate receiver address before wasting a fee on a doomed txn
        if (!algosdk.isValidAddress(msg.receiver)) throw new Error("Invalid withdrawal receiver address");
        const r = await ownerWithdraw(
          msg.chain, actionVaultApp.appId, actionOwnerSk, actionAccount.address,
          msg.receiver, BigInt(msg.amount)
        );
        return { txId: r.txId };
      }
      throw new Error(`Unknown vault action: ${msg.action}`);
    }

    case "VAULT_REMAP": {
      // Reconnect an existing on-chain vault with a fresh agent key.
      // No redeploy — only registers a new agent box and saves the app ID.
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      const remapMeta    = await walletStore.getMeta();
      const remapAccount = remapMeta.accounts.find((a) => a.id === remapMeta.activeAccountId);
      if (!remapAccount) throw new Error("No active account");

      // Verify the app exists on-chain and derive its address
      const remapAlgod = getAlgodClient(msg.chain);
      await remapAlgod.getApplicationByID(msg.appId).do(); // throws if app not found
      const remapAppAddress = algosdk.getApplicationAddress(msg.appId).toString();

      // Always generate a fresh agent key for the remap
      const remapAgentAddr = await walletStore.createAgentKey();
      const remapMaxPerTxn = BigInt(msg.agentMaxPerTxn);
      const remapDailyCap  = BigInt(msg.agentDailyCap);

      if (remapAccount.type === "walletconnect") {
        if (!remapAccount.wcSessionTopic) throw new Error("No WalletConnect session for this account");
        const remapGroup = await buildRemapAgentGroup(
          msg.chain, remapAccount.address, remapAgentAddr,
          msg.appId, remapAppAddress, remapMaxPerTxn, remapDailyCap
        );
        const remapGroupBytes = remapGroup.map((txn) => txn.toByte());
        // H1: store expected bytes for binding check in VAULT_WC_REMAP_SUBMIT
        _pendingVaultWcBinding.set(remapAccount.wcSessionTopic, {
          expectedUnsignedB64s: remapGroupBytes.map((b) => btoa(String.fromCharCode(...b))),
          expires: Date.now() + VAULT_WC_BINDING_TTL_MS,
        });
        return {
          needsWcSign:    true,
          step:           "remap",
          setupGroupB64s: remapGroupBytes.map((b) => btoa(String.fromCharCode(...b))),
          sessionTopic:   remapAccount.wcSessionTopic,
          signerAddress:  remapAccount.address,
          appId:          msg.appId,
          appAddress:     remapAppAddress,
          agentAddress:   remapAgentAddr,
          chain:          msg.chain,
        };
      }

      // Mnemonic path: sign and submit fund + add_agent atomically
      const remapOwnerSk = await walletStore.getActiveSecretKey();
      const remapResult  = await addAgentMnemonic(
        msg.chain, msg.appId, remapAppAddress, remapOwnerSk, remapAccount.address,
        remapAgentAddr, remapMaxPerTxn, remapDailyCap
      );
      await walletStore.saveVaultApp(msg.chain, msg.appId, remapAppAddress);
      return { txId: remapResult.txId, appId: msg.appId, appAddress: remapAppAddress, agentAddress: remapAgentAddr };
    }

    case "VAULT_WC_REMAP_SUBMIT": {
      // Submit signed fund + add_agent group for WC remap, then save vault app
      if (walletStore.getLockState() !== "unlocked") throw new Error("Wallet is locked");
      walletStore.resetAutoLock();

      const signedRemapGroup = msg.signedGroupB64s.map((b64) => base64ToBytes(b64));

      // H1: validate signed group against what VAULT_REMAP built
      const wcRemapMeta = await walletStore.getMeta();
      const wcRemapAcct = wcRemapMeta.accounts.find((a) => a.id === wcRemapMeta.activeAccountId);
      if (!wcRemapAcct?.wcSessionTopic) throw new Error("No active WalletConnect account");
      const remapBinding = _pendingVaultWcBinding.get(wcRemapAcct.wcSessionTopic);
      if (!remapBinding) {
        throw new Error("VAULT_WC_REMAP_SUBMIT: no pending remap session — please retry");
      }
      if (Date.now() > remapBinding.expires) {
        _pendingVaultWcBinding.delete(wcRemapAcct.wcSessionTopic);
        throw new Error("VAULT_WC_REMAP_SUBMIT: remap session expired — please retry");
      }
      if (signedRemapGroup.length !== remapBinding.expectedUnsignedB64s.length) {
        throw new Error(
          `VAULT_WC_REMAP_SUBMIT: expected ${remapBinding.expectedUnsignedB64s.length} signed transactions, ` +
          `got ${signedRemapGroup.length}`
        );
      }
      for (let i = 0; i < signedRemapGroup.length; i++) {
        try {
          const decoded     = algosdk.decodeSignedTransaction(signedRemapGroup[i]);
          const unsignedB64 = btoa(String.fromCharCode(...decoded.txn.toByte()));
          if (unsignedB64 !== remapBinding.expectedUnsignedB64s[i]) {
            throw new Error(
              `VAULT_WC_REMAP_SUBMIT: transaction ${i} does not match the expected remap transaction. ` +
              "The WalletConnect wallet may have altered the transaction."
            );
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("VAULT_WC_REMAP_SUBMIT:")) throw err;
          throw new Error(
            `VAULT_WC_REMAP_SUBMIT: failed to validate transaction ${i}: ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      _pendingVaultWcBinding.delete(wcRemapAcct.wcSessionTopic);

      const remapTxId = await submitSignedGroup(msg.chain, signedRemapGroup);
      await walletStore.saveVaultApp(msg.chain, msg.appId, msg.appAddress);
      const remapAgentAddrFinal = walletStore.getAgentAddress();
      return { txId: remapTxId, agentAddress: remapAgentAddrFinal };
    }

    default:
      throw new Error(`Unknown message type: ${(msg as { type: string }).type}`);
  }
}

// ── Serialization helpers ─────────────────────────────────────────────────────

/** Convert bigint values to strings for postMessage serialization */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function serializeBigInt(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (obj === null || typeof obj !== "object") return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, serializeBigInt(v)]));
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastLockState(): void {
  const lockState = walletStore.getLockState();
  // Ignore "Receiving end does not exist" when no extension pages are open.
  chrome.runtime.sendMessage({ type: "LOCK_STATE_CHANGED", lockState }).catch(() => {});
}

function broadcastChainChange(chain: ChainId): void {
  // Only send to tabs with http/https — chrome://, new-tab, and PDF renderers
  // don't have our content script and throw "No such renderer" if messaged.
  chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "CHAIN_CHANGED", chain }).catch(() => {});
      }
    }
  });
}
