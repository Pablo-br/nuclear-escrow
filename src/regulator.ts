/**
 * src/regulator.ts — Regulator-side operations.
 *
 * Covers:
 *   publishTemplate    — serialise a TemplateRecord and write it to the
 *                        regulator's namespace via a SetHookState transaction.
 *   openPeriod         — run committee selection, commit on-chain, return
 *                        the period metadata the company needs to lock funds.
 *   installRegistryHook — install registry_hook.wasm on the regulator account.
 *
 * All transactions are signed by the regulator wallet and submitted via the
 * provided xrpl.js Client.
 */

import * as fs from "fs";
import * as path from "path";
import { Client, Wallet, decodeAccountID } from "xrpl";
import {
  TemplateRecord,
  encodeTemplateRecord,
  TEMPLATE_NAMESPACE_KEY,
  TEMPLATE_RECORD_SIZE,
  SCHEMA_VERSION,
  registryHookParams,
  HOOK_ON_PAYMENT_ONLY,
} from "./types.js";
import { OracleRegistration } from "./types.js";
import { selectCommittee, commitCommittee, CommitteeMember } from "./committee.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Human-readable template specification provided to publishTemplate. */
export interface TemplateSpec {
  regulatorAddress:  string;
  contractorAddress: string;
  companyAddress:    string;
  periodDurationSecs: number;
  collateralDrops:   bigint;
  N: number;   // total registered oracles
  M: number;   // Byzantine threshold ≥ ⌊2N/3⌋ + 1
}

/** Metadata returned by openPeriod for the company to act on. */
export interface PeriodMeta {
  periodSeq:       number;
  ledgerSeq:       number;   // ledger sequence of the COMMIT_COMMITTEE tx
  committee:       CommitteeMember[];
  commitTxHash:    string;
}

// ─── Account ID helper ───────────────────────────────────────────────────────

/** Convert an XRPL r-address to a 20-byte AccountID Buffer. */
function addressToAccountId(address: string): Buffer {
  return Buffer.from(decodeAccountID(address));
}

// ─── publishTemplate ─────────────────────────────────────────────────────────

/**
 * Serialise a template and publish it to the regulator's Hook namespace via a
 * SetHookState transaction.
 *
 * The key used is TEMPLATE_NAMESPACE_KEY (sha512h("TEMPLATE"), 32 bytes).
 * The value is the 79-byte TemplateRecord binary.
 *
 * @param spec       Template specification
 * @param regulator  Regulator wallet
 * @param client     Connected XRPL client
 * @returns          Transaction hash
 */
export async function publishTemplate(
  spec:      TemplateSpec,
  regulator: Wallet,
  client:    Client,
): Promise<string> {
  // Validate M ≥ ⌊2N/3⌋ + 1
  const minM = Math.floor((2 * spec.N) / 3) + 1;
  if (spec.M < minM)
    throw new Error(
      `M must be ≥ ⌊2N/3⌋ + 1 = ${minM} for N=${spec.N}, got M=${spec.M}`,
    );

  const record: TemplateRecord = {
    schemaVersion:       SCHEMA_VERSION,
    regulatorAccountId:  addressToAccountId(spec.regulatorAddress),
    contractorAccountId: addressToAccountId(spec.contractorAddress),
    companyAccountId:    addressToAccountId(spec.companyAddress),
    periodDurationSecs:  BigInt(spec.periodDurationSecs),
    collateralDrops:     spec.collateralDrops,
    N: spec.N,
    M: spec.M,
  };

  const encoded = encodeTemplateRecord(record);

  const tx = {
    TransactionType: "HookStateSet" as const,
    Account:         regulator.address,
    HookStateData:   encoded.toString("hex").toUpperCase(),
    HookStateKey:    TEMPLATE_NAMESPACE_KEY.toString("hex").toUpperCase(),
  };

  const prepared = await client.autofill(tx as Parameters<typeof client.autofill>[0]);
  const signed   = regulator.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const txResult: string =
    ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
      ?.TransactionResult as string ?? "unknown";

  if (txResult !== "tesSUCCESS")
    throw new Error(`publishTemplate failed: ${txResult}`);

  console.log(
    `Template published: period_duration=${spec.periodDurationSecs}s, ` +
    `collateral=${spec.collateralDrops} drops, N=${spec.N}, M=${spec.M}`,
  );

  return (result.result as Record<string, unknown>).hash as string;
}

// ─── openPeriod ──────────────────────────────────────────────────────────────

/**
 * Open a new compliance period:
 *   1. Select K committee members deterministically.
 *   2. Commit the committee on-chain (COMMIT_COMMITTEE to registry hook).
 *   3. Return PeriodMeta for the company to use when locking collateral.
 *
 * K is computed as max(3*M − 2, 3) and must not exceed the registered set.
 *
 * @param periodSeq  Sequence number for this period (monotonically increasing)
 * @param oracles    Full registered oracle set (from readAllOracles)
 * @param M          Byzantine threshold
 * @param regulator  Regulator wallet
 * @param client     Connected XRPL client
 * @returns          PeriodMeta
 */
export async function openPeriod(
  periodSeq: number,
  oracles:   OracleRegistration[],
  M:         number,
  regulator: Wallet,
  client:    Client,
): Promise<PeriodMeta> {
  // K ≥ 3M − 2 and at least 3
  const K = Math.max(3 * M - 2, 3);
  if (oracles.length < K)
    throw new Error(
      `Need at least ${K} registered oracles for M=${M}, found ${oracles.length}`,
    );

  console.log(
    `openPeriod: period_seq=${periodSeq}, M=${M}, K=${K}, ` +
    `selecting from ${oracles.length} oracles`,
  );

  const committee = selectCommittee(periodSeq, oracles, K);

  console.log("Selected committee:");
  for (const m of committee) {
    console.log(
      `  [${m.position}] ${m.oracle.pubkey.toString("hex").slice(0, 16)}... ` +
      `rep=${m.oracle.reputationScore}`,
    );
  }

  const commitTxHash = await commitCommittee(
    periodSeq, committee, regulator, client,
  );
  console.log(`Committee committed on-chain: ${commitTxHash}`);

  // Read back the ledger sequence of the commit transaction so the company
  // can embed it in oracle payloads as replay protection.
  const txInfo = await (client as unknown as {
    request: (r: unknown) => Promise<unknown>;
  }).request({ command: "tx", transaction: commitTxHash });

  const ledgerSeq: number =
    ((txInfo as Record<string, unknown>).result as Record<string, unknown>)
      ?.ledger_index as number ?? 0;

  return { periodSeq, ledgerSeq, committee, commitTxHash };
}

// ─── installRegistryHook ─────────────────────────────────────────────────────

/**
 * Install the registry hook on the regulator's account.
 *
 * Reads hook/registry_hook.wasm relative to the repository root, then submits
 * a SetHook transaction.
 *
 * @param regulator        Regulator wallet
 * @param client           Connected XRPL client
 * @param wasmPath         Override path to registry_hook.wasm (optional)
 * @returns                Transaction hash
 */
export async function installRegistryHook(
  regulator: Wallet,
  client:    Client,
  wasmPath?: string,
): Promise<string> {
  const resolved = wasmPath
    ?? path.resolve(process.cwd(), "hook", "registry_hook.wasm");

  if (!fs.existsSync(resolved))
    throw new Error(`registry_hook.wasm not found at ${resolved}`);

  const wasm    = fs.readFileSync(resolved);
  const wasmHex = wasm.toString("hex").toUpperCase();

  const regulatorAccountId = addressToAccountId(regulator.address);

  const tx = {
    TransactionType: "SetHook" as const,
    Account:         regulator.address,
    Hooks: [
      {
        Hook: {
          CreateCode:     wasmHex,
          HookOn:         HOOK_ON_PAYMENT_ONLY,
          HookNamespace:  "0000000000000000000000000000000000000000000000000000000000000000",
          HookApiVersion: 0,
          Flags:          1,  // hsfOVERRIDE
          HookParameters: registryHookParams(regulatorAccountId),
        },
      },
    ],
  };

  const prepared = await client.autofill(tx as Parameters<typeof client.autofill>[0]);
  const signed   = regulator.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const txResult: string =
    ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
      ?.TransactionResult as string ?? "unknown";

  if (txResult !== "tesSUCCESS")
    throw new Error(`installRegistryHook failed: ${txResult}`);

  console.log(`Registry hook installed on ${regulator.address}`);
  return (result.result as Record<string, unknown>).hash as string;
}
