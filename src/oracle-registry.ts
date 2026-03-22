/**
 * src/oracle-registry.ts — Functions to manage oracle registrations through
 * the registry hook installed on the regulator's account.
 *
 * Public API:
 *   registerOracle        — Submit REGISTER_ORACLE payment to regulator
 *   readOracleRegistration — Read one oracle's entry from the regulator namespace
 *   readAllOracles        — Read all oracle entries (by scanning known pubkeys)
 *   readOracleReputation  — Read only the reputation score for a pubkey
 */

import { Client, Wallet, type AccountInfoRequest } from "xrpl";
import {
  OracleRegistration,
  decodeRegistrationValue,
  buildMemo,
} from "./types.js";

// ─── Submit REGISTER_ORACLE transaction ──────────────────────────────────────

/**
 * Register an oracle public key in the registry hook's namespace.
 *
 * Submits a Payment from the regulator account to itself with:
 *   MemoType = "REGISTER_ORACLE"
 *   MemoData = ed25519 pubkey (32 bytes)
 *
 * The registry hook fires, verifies the sender is the regulator, and writes:
 *   key   = pubkey (32 bytes)
 *   value = u32be(ledger_seq) || i32be(0)   (8 bytes)
 *
 * @param pubkey      32-byte ed25519 public key (no "ED" XRPL prefix)
 * @param regulator   Regulator wallet (signs the transaction)
 * @param client      Connected XRPL client
 * @returns           Transaction hash of the submitted transaction
 */
export async function registerOracle(
  pubkey: Buffer,
  regulator: Wallet,
  client: Client,
): Promise<string> {
  if (pubkey.length !== 32)
    throw new Error("Oracle pubkey must be 32 bytes");

  const tx = {
    TransactionType: "Payment" as const,
    Account:         regulator.address,
    Destination:     regulator.address,
    Amount:          "1",         // 1 drop — minimal self-payment to trigger hook
    Memos:           [buildMemo("REGISTER_ORACLE", pubkey)],
  };

  const prepared = await client.autofill(tx);
  const signed   = regulator.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const txResult: string =
    (result.result as Record<string, unknown>).meta !== undefined
      ? ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
          ?.TransactionResult as string
      : "unknown";

  if (txResult !== "tesSUCCESS")
    throw new Error(`registerOracle failed: ${txResult}`);

  return (result.result as Record<string, unknown>).hash as string;
}

// ─── Read oracle registration from namespace ──────────────────────────────────

/**
 * Read one oracle's registration entry from the regulator's Hook namespace.
 *
 * Uses the account_namespace RPC method introduced in xahaud / Hooks-aware
 * XRPL servers.
 *
 * @param pubkey          32-byte ed25519 pubkey (the namespace key)
 * @param regulatorAddress XRPL address of the regulator account
 * @param client          Connected XRPL client
 * @returns OracleRegistration or null if not found
 */
export async function readOracleRegistration(
  pubkey: Buffer,
  regulatorAddress: string,
  client: Client,
): Promise<OracleRegistration | null> {
  const keyHex = pubkey.toString("hex").toUpperCase();

  const response = await (client as unknown as {
    request: (r: unknown) => Promise<unknown>;
  }).request({
    command:    "account_namespace",
    account:    regulatorAddress,
    namespace_id: keyHex,
  });

  const entry = (response as Record<string, unknown>).result as Record<string, unknown> | undefined;
  if (!entry) return null;

  // The response contains a "namespace_entries" array or a direct value field.
  // xahaud returns { namespace_entries: [{ HookStateKey, HookStateData }] }
  const entries = entry.namespace_entries as Array<Record<string, string>> | undefined;
  if (!entries || entries.length === 0) return null;

  const found = entries.find((e) =>
    e.HookStateKey?.toUpperCase() === keyHex,
  );
  if (!found) return null;

  const valueHex  = found.HookStateData;
  const valueBuf  = Buffer.from(valueHex, "hex");
  return decodeRegistrationValue(valueBuf, pubkey);
}

/**
 * Read all registered oracles from the regulator's Hook namespace.
 *
 * Fetches the entire namespace and filters entries whose keys are 32 bytes
 * (all oracle registrations; committee entries are also 32-byte keys but
 * differ in length of their values: oracle regs are 8 bytes, committee
 * chunks are multiples of 32 bytes).
 *
 * @param regulatorAddress XRPL address of the regulator
 * @param client           Connected XRPL client
 * @returns Array of OracleRegistration entries
 */
export async function readAllOracles(
  regulatorAddress: string,
  client: Client,
): Promise<OracleRegistration[]> {
  const response = await (client as unknown as {
    request: (r: unknown) => Promise<unknown>;
  }).request({
    command: "account_namespace",
    account: regulatorAddress,
  });

  const result = (response as Record<string, unknown>).result as Record<string, unknown>;
  const entries = result?.namespace_entries as Array<Record<string, string>> | undefined;
  if (!entries) return [];

  const oracles: OracleRegistration[] = [];
  for (const e of entries) {
    const keyBuf = Buffer.from(e.HookStateKey ?? "", "hex");
    const valBuf = Buffer.from(e.HookStateData ?? "", "hex");
    // Oracle entries: 32-byte key (the pubkey itself), 8-byte value
    if (keyBuf.length === 32 && valBuf.length === 8) {
      oracles.push(decodeRegistrationValue(valBuf, keyBuf));
    }
  }
  return oracles;
}

/**
 * Read the current reputation score for a single oracle pubkey.
 *
 * @param pubkey           32-byte ed25519 pubkey
 * @param regulatorAddress Regulator XRPL address
 * @param client           Connected XRPL client
 * @returns Reputation score (integer) or null if not found
 */
export async function readOracleReputation(
  pubkey: Buffer,
  regulatorAddress: string,
  client: Client,
): Promise<number | null> {
  const reg = await readOracleRegistration(pubkey, regulatorAddress, client);
  return reg ? reg.reputationScore : null;
}
