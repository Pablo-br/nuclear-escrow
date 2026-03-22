/**
 * src/company.ts — Company-side operations.
 *
 * Covers:
 *   installComplianceHook — install compliance_hook.wasm on the company account
 *   lockCollateral        — send LOCK payment to company's own hook-enabled account
 *   buildVoteEntry        — sign a vote payload as an oracle and return a VoteEntry
 *   buildProofBlob        — assemble VoteEntries into an encoded ProofBlob
 *   submitProof           — submit the PROOF payment to trigger the compliance hook
 *
 * The compliance hook fires on every Payment arriving at the company account.
 * It distinguishes LOCK (memo type "LOCK") from PROOF (memo type "PROOF") and
 * enforces all Byzantine consensus logic on-chain.
 */

import * as fs from "fs";
import * as path from "path";
import { Client, Wallet, decodeAccountID } from "xrpl";
import { ed25519 } from "@noble/curves/ed25519";
import {
  SCHEMA_VERSION,
  HOOK_ON_PAYMENT_ONLY,
  VoteEntry,
  VoteValue,
  ProofBlob,
  complianceHookParams,
  buildMemo,
  encodeLockMemoData,
  encodeProofBlob,
  buildOraclePayload,
} from "./types.js";
import type { PeriodMeta } from "./regulator.js";

// ─── Address helper ───────────────────────────────────────────────────────────

function addressToAccountId(address: string): Buffer {
  return Buffer.from(decodeAccountID(address));
}

// ─── installComplianceHook ────────────────────────────────────────────────────

/**
 * Install the compliance hook on the company's account.
 *
 * Reads hook/compliance_hook.wasm relative to the repository root and submits
 * a SetHook transaction signed by the company wallet.
 *
 * Hook parameters set at install time:
 *   REGULATOR    — 20-byte AccountID of the regulator
 *   CONTRACTOR   — 20-byte AccountID of the contractor
 *   SCHEMA_VER   — 1-byte expected schema version (= SCHEMA_VERSION)
 *   M_THRESHOLD  — 1-byte Byzantine threshold
 *   K_COMMITTEE  — 1-byte committee size
 *   COLLAT_DROPS — 8-byte expected collateral in drops
 *
 * @param company             Company wallet (installs the hook on its own account)
 * @param regulatorAddress    Regulator XRPL address
 * @param contractorAddress   Contractor XRPL address
 * @param M                   Byzantine threshold
 * @param K                   Committee size
 * @param collateralDrops     Expected collateral in drops
 * @param client              Connected XRPL client
 * @param wasmPath            Override path to compliance_hook.wasm (optional)
 * @returns                   Transaction hash
 */
export async function installComplianceHook(
  company:            Wallet,
  regulatorAddress:   string,
  contractorAddress:  string,
  M:                  number,
  K:                  number,
  collateralDrops:    bigint,
  client:             Client,
  wasmPath?:          string,
): Promise<string> {
  const resolved = wasmPath
    ?? path.resolve(process.cwd(), "hook", "compliance_hook.wasm");

  if (!fs.existsSync(resolved))
    throw new Error(`compliance_hook.wasm not found at ${resolved}`);

  const wasm    = fs.readFileSync(resolved);
  const wasmHex = wasm.toString("hex").toUpperCase();

  const regAccId  = addressToAccountId(regulatorAddress);
  const contrAccId = addressToAccountId(contractorAddress);

  const tx = {
    TransactionType: "SetHook" as const,
    Account:         company.address,
    Hooks: [
      {
        Hook: {
          CreateCode:     wasmHex,
          HookOn:         HOOK_ON_PAYMENT_ONLY,
          HookNamespace:  "0000000000000000000000000000000000000000000000000000000000000000",
          HookApiVersion: 0,
          Flags:          1,  // hsfOVERRIDE
          HookParameters: complianceHookParams(
            regAccId, contrAccId, SCHEMA_VERSION, M, K, collateralDrops,
          ),
        },
      },
    ],
  };

  const prepared = await client.autofill(tx as Parameters<typeof client.autofill>[0]);
  const signed   = company.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const txResult: string =
    ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
      ?.TransactionResult as string ?? "unknown";

  if (txResult !== "tesSUCCESS")
    throw new Error(`installComplianceHook failed: ${txResult}`);

  console.log(`Compliance hook installed on company account ${company.address}`);
  return (result.result as Record<string, unknown>).hash as string;
}

// ─── lockCollateral ───────────────────────────────────────────────────────────

/**
 * Lock collateral by sending a self-payment to the company's hook-enabled
 * account with memo type "LOCK".
 *
 * The compliance hook fires on this payment and writes:
 *   COLLATERAL_DROPS = amount
 *   PERIOD_SEQ       = periodSeq (from memo data)
 *   PERIOD_LEDGER    = ledger_seq() at execution time
 *   PERIOD_STATUS    = 1 (active)
 *
 * @param company          Company wallet
 * @param periodSeq        Period sequence number (from openPeriod)
 * @param collateralDrops  Amount in drops to lock
 * @param client           Connected XRPL client
 * @returns                { txHash, ledgerSeq } — ledgerSeq is the period start ledger
 */
export async function lockCollateral(
  company:         Wallet,
  periodSeq:       number,
  collateralDrops: bigint,
  client:          Client,
): Promise<{ txHash: string; ledgerSeq: number }> {
  const memoData = encodeLockMemoData(periodSeq);

  const tx = {
    TransactionType: "Payment" as const,
    Account:         company.address,
    Destination:     company.address,
    Amount:          collateralDrops.toString(),
    Memos:           [buildMemo("LOCK", memoData)],
  };

  const prepared = await client.autofill(tx);
  const signed   = company.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const txResult: string =
    ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
      ?.TransactionResult as string ?? "unknown";

  if (txResult !== "tesSUCCESS")
    throw new Error(`lockCollateral failed: ${txResult}`);

  // Read the ledger sequence from the transaction result (this is PERIOD_LEDGER).
  const txInfo = await (client as unknown as {
    request: (r: unknown) => Promise<unknown>;
  }).request({
    command:     "tx",
    transaction: (result.result as Record<string, unknown>).hash as string,
  });

  const ledgerSeq: number =
    ((txInfo as Record<string, unknown>).result as Record<string, unknown>)
      ?.ledger_index as number ?? 0;

  const txHash = (result.result as Record<string, unknown>).hash as string;
  console.log(
    `Collateral locked: ${collateralDrops} drops, period_seq=${periodSeq}, ` +
    `ledger_seq=${ledgerSeq}, tx=${txHash}`,
  );

  return { txHash, ledgerSeq };
}

// ─── buildVoteEntry ───────────────────────────────────────────────────────────

/**
 * Build a signed VoteEntry for one oracle.
 *
 * The oracle's Ed25519 private key signs the canonical 29-byte payload:
 *   period_seq(4) || company_acct(20) || vote(1) || ledger_ts(4)
 *
 * @param privateKey      32-byte Ed25519 private key (no XRPL prefix)
 * @param periodSeq       Period sequence number
 * @param companyAddress  XRPL address of the company account
 * @param vote            0x01 = compliant, 0x00 = non-compliant
 * @param ledgerTs        Ledger sequence of the LOCK transaction (from lockCollateral)
 * @returns               VoteEntry ready to include in a ProofBlob
 */
export function buildVoteEntry(
  privateKey:     Buffer | Uint8Array,
  periodSeq:      number,
  companyAddress: string,
  vote:           VoteValue,
  ledgerTs:       number,
): VoteEntry {
  const privKey     = Buffer.isBuffer(privateKey)
    ? new Uint8Array(privateKey)
    : privateKey;
  const pubkeyRaw   = ed25519.getPublicKey(privKey);
  const companyAccId = addressToAccountId(companyAddress);

  const payload   = buildOraclePayload(periodSeq, companyAccId, vote, ledgerTs);
  const signature = ed25519.sign(payload, privKey);

  return {
    pubkey:    Buffer.from(pubkeyRaw),
    vote,
    signature: Buffer.from(signature),
  };
}

// ─── buildProofBlob ───────────────────────────────────────────────────────────

/**
 * Assemble and encode a ProofBlob from a list of VoteEntry objects.
 *
 * Does NOT submit the proof — call submitProof for that.
 *
 * @param periodSeq    Period sequence number
 * @param ledgerTs     Ledger sequence of the LOCK transaction
 * @param voteEntries  Ordered list of oracle vote entries
 * @returns            Binary ProofBlob ready for the PROOF memo
 */
export function buildProofBlob(
  periodSeq:   number,
  ledgerTs:    number,
  voteEntries: VoteEntry[],
): Buffer {
  const blob: ProofBlob = {
    schemaVersion: SCHEMA_VERSION,
    periodSeq,
    ledgerTs,
    voteEntries,
  };
  return encodeProofBlob(blob);
}

// ─── submitProof ──────────────────────────────────────────────────────────────

/**
 * Submit the proof to the compliance hook by sending a self-payment with
 * memo type "PROOF" and the encoded ProofBlob as memo data.
 *
 * The compliance hook fires, verifies all signatures, tallies votes, and:
 *   - If M+ compliant:     emits payment back to company (return collateral)
 *   - If M+ non-compliant: emits payment to contractor
 *   - Otherwise:           rollback ("no consensus") — caller may retry
 *
 * @param company      Company wallet
 * @param proofBlob    Encoded binary proof blob (from buildProofBlob)
 * @param client       Connected XRPL client
 * @returns            { txHash, outcome } where outcome is the engine result
 */
export async function submitProof(
  company:   Wallet,
  proofBlob: Buffer,
  client:    Client,
): Promise<{ txHash: string; success: boolean; outcome: string }> {
  const tx = {
    TransactionType: "Payment" as const,
    Account:         company.address,
    Destination:     company.address,
    Amount:          "1",   // 1 drop self-payment to trigger hook
    Memos:           [buildMemo("PROOF", proofBlob)],
  };

  const prepared = await client.autofill(tx);
  const signed   = company.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const meta      = (result.result as Record<string, unknown>).meta as Record<string, unknown>;
  const txResult  = meta?.TransactionResult as string ?? "unknown";
  const txHash    = (result.result as Record<string, unknown>).hash as string ?? "";
  const success   = txResult === "tesSUCCESS";

  if (!success) {
    console.warn(`submitProof: transaction result = ${txResult}`);
  } else {
    console.log(`submitProof: consensus reached, tx=${txHash}`);
  }

  return { txHash, success, outcome: txResult };
}

// ─── readComplianceState ──────────────────────────────────────────────────────

/**
 * Read the current compliance hook namespace state for the company account.
 *
 * @param companyAddress  XRPL address of the company
 * @param client          Connected XRPL client
 * @returns               Raw namespace entries as { key, value } hex pairs
 */
export async function readComplianceState(
  companyAddress: string,
  client:         Client,
): Promise<Array<{ key: string; value: string }>> {
  const response = await (client as unknown as {
    request: (r: unknown) => Promise<unknown>;
  }).request({
    command: "account_namespace",
    account: companyAddress,
  });

  const result  = (response as Record<string, unknown>).result as Record<string, unknown>;
  const entries = result?.namespace_entries as Array<Record<string, string>> | undefined;
  if (!entries) return [];

  return entries.map((e) => ({
    key:   e.HookStateKey  ?? "",
    value: e.HookStateData ?? "",
  }));
}
