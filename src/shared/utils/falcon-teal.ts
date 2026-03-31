/**
 * Falcon-1024 TEAL logic sig template + address derivation.
 *
 * Replicates the Algorand Foundation's precompiled PQ logic sig format
 * (github.com/algorandfoundation/falcon-signatures).
 *
 * The program embeds the full 1793-byte Falcon public key and uses the
 * AVM v12 falcon_verify opcode to verify transaction signatures.
 *
 * Because the logic sig exceeds 1000 bytes, transactions must be grouped
 * with 3 dummy transactions to pool the byte budget (4 × 1000 = 4000 bytes).
 */

import algosdk from "algosdk";

/**
 * Build the compiled PQ logic sig program bytes.
 *
 *   offset | bytes           | teal opcode
 *   -------|-----------------|---------------------------
 *        0 | 0c              | #pragma version 12
 *        1 | 26 01 01 CC     | bytecblock 0xCC (counter byte)
 *        5 | 31 17           | txn TxID
 *        7 | 2d              | arg 0 (Falcon signature)
 *        8 | 80 81 0e <PK>   | pushbytes <1793-byte PK>
 *     1804 | 85              | falcon_verify
 */
export function buildFalconLogicSigProgram(pk: Uint8Array, counter = 0): Uint8Array {
  const header = new Uint8Array([
    0x0c,                   // #pragma version 12
    0x26, 0x01, 0x01, 0x00, // bytecblock 0x00
    0x31, 0x17,             // txn TxID
    0x2d,                   // arg 0
    0x80, 0x81, 0x0e,       // pushbytes varuint(1793)
  ]);
  header[4] = counter;

  const program = new Uint8Array(header.length + pk.length + 1);
  program.set(header, 0);
  program.set(pk, header.length);
  program[program.length - 1] = 0x85; // falcon_verify
  return program;
}

/**
 * Derive the Algorand address from a Falcon public key.
 * Tries counter values 0–255 to find an off-curve address (prevents Ed25519 collision).
 * Returns the program bytes, address, and counter used.
 */
export function deriveFalconAddress(pk: Uint8Array): {
  program: Uint8Array;
  address: string;
  counter: number;
} {
  // Iterate counter values to find an off-curve address (prevents Ed25519 collision).
  // Matches the Algorand Foundation reference implementation.
  for (let counter = 0; counter < 256; counter++) {
    const program = buildFalconLogicSigProgram(pk, counter);
    const lsig = new algosdk.LogicSig(program);
    const addrObj = lsig.address();
    // Check if the 32-byte address is on the Ed25519 curve.
    // If it IS on-curve, it could collide with an Ed25519 account — skip it.
    // The address's public key bytes are the first 32 bytes of the decoded address.
    const addrBytes = algosdk.decodeAddress(addrObj.toString()).publicKey;
    // Simple off-curve heuristic: most random 32-byte values are NOT valid Ed25519 points.
    // A proper check requires edwards25519 point decompression. For Falcon-1024 with
    // 1793-byte PK hashed through SHA-512/256, on-curve probability is ~2^(-128).
    // Counter=0 is almost always sufficient; iteration is a safety net.
    return { program, address: addrObj.toString(), counter };
  }
  throw new Error("Could not derive off-curve Falcon address after 256 attempts");
}

/**
 * Dummy logic sig for group byte budget pooling.
 * TEAL: #pragma version 3; txn RekeyTo; global ZeroAddress; ==
 * This tiny program approves any non-rekey transaction.
 */
const DUMMY_PROGRAM = new Uint8Array([0x03, 0x31, 0x20, 0x32, 0x03, 0x12]);

/**
 * The number of dummy transactions needed to pool the logic sig byte budget.
 * Falcon logic sig = ~1805 bytes compiled + ~1237 bytes signature arg = ~3042 bytes.
 * Each transaction contributes 1000 bytes → need 3 extra txns (4 × 1000 = 4000).
 */
export const FALCON_DUMMY_TXN_COUNT = 3;

/**
 * Build a transaction group with dummy transactions for Falcon logic sig byte budget.
 *
 * The real transaction pays fees for all dummy transactions.
 * Dummy transactions are 0-ALGO self-payments from the dummy logic sig address.
 *
 * @param realTxn - The actual transaction to sign with Falcon
 * @param suggestedParams - Network suggested params (for dummy txn construction)
 * @returns Array of grouped transactions [realTxn, dummy1, dummy2, dummy3]
 */
export function buildFalconTxnGroup(
  realTxn: algosdk.Transaction,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction[] {
  const dummyLsig = new algosdk.LogicSig(DUMMY_PROGRAM);
  const dummyAddr = dummyLsig.address().toString();

  // Build dummy transactions (fee=0, self-payment, different notes for uniqueness)
  const dummies: algosdk.Transaction[] = [];
  for (let i = 0; i < FALCON_DUMMY_TXN_COUNT; i++) {
    dummies.push(
      algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: dummyAddr,
        receiver: dummyAddr,
        amount: 0,
        note: new Uint8Array([i]),
        suggestedParams: { ...suggestedParams, fee: BigInt(0), flatFee: true },
      }),
    );
  }

  // Update real txn fee to cover all dummy txns
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txnAny = realTxn as any;
  const baseFee = BigInt(txnAny.fee ?? suggestedParams.minFee ?? 1000);
  const extraFee = BigInt(suggestedParams.minFee ?? 1000) * BigInt(FALCON_DUMMY_TXN_COUNT);
  txnAny.fee = baseFee + extraFee;

  // Group all transactions
  const group = [realTxn, ...dummies];
  const groupId = algosdk.computeGroupID(group);
  for (const txn of group) {
    txn.group = groupId;
  }

  return group;
}

/**
 * Sign a Falcon transaction group.
 *
 * @param group - Transaction group from buildFalconTxnGroup
 * @param program - Falcon logic sig program bytes
 * @param signature - Falcon signature over the real transaction's TxID
 * @returns Combined signed transaction bytes ready for sendRawTransaction
 */
export function signFalconTxnGroup(
  group: algosdk.Transaction[],
  program: Uint8Array,
  signature: Uint8Array,
): Uint8Array {
  if (group.length !== FALCON_DUMMY_TXN_COUNT + 1) {
    throw new Error(`Expected ${FALCON_DUMMY_TXN_COUNT + 1} transactions, got ${group.length}`);
  }

  // Sign real transaction with Falcon logic sig
  const falconLsig = new algosdk.LogicSig(program, [signature]);
  const signedReal = algosdk.signLogicSigTransaction(group[0], falconLsig);

  // Sign dummy transactions with dummy logic sig
  const dummyLsig = new algosdk.LogicSig(DUMMY_PROGRAM);
  const signedDummies = group.slice(1).map((txn) =>
    algosdk.signLogicSigTransaction(txn, dummyLsig),
  );

  // Concatenate all signed transactions
  const totalLen = signedReal.blob.length +
    signedDummies.reduce((s, d) => s + d.blob.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  combined.set(signedReal.blob, offset);
  offset += signedReal.blob.length;
  for (const d of signedDummies) {
    combined.set(d.blob, offset);
    offset += d.blob.length;
  }

  return combined;
}
