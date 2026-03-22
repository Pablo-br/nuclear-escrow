/**
 * src/committee.ts — Deterministic committee selection and on-chain commitment.
 *
 * Algorithm
 * ─────────
 * Given a period sequence number and the full registered oracle set, compute a
 * reproducible ranking by hashing the concatenation of the period sequence and
 * each oracle's public key with SHA-512 and taking the first 32 bytes
 * (matching the C Hook's util_sha512h).  Sort ascending by this 32-byte
 * rank hash (treating it as a big-endian 256-bit integer).  Select the top K.
 *
 * The selected committee is committed on-chain by the regulator account via a
 * COMMIT_COMMITTEE payment that triggers the registry hook.
 *
 * Public API
 * ──────────
 *   selectCommittee       — pure deterministic selection (no I/O)
 *   commitCommittee       — write committee to the regulator's namespace
 *   verifyCommittee       — re-derive and compare against on-chain state
 */

import { createHash } from "crypto";
import { Client, Wallet } from "xrpl";
import { OracleRegistration, buildMemo } from "./types.js";

// ─── Rank hash computation ────────────────────────────────────────────────────

/**
 * Compute the 32-byte rank hash for one oracle in the context of a period.
 *
 * hash = sha512h(u32be(period_seq) || pubkey_32bytes)
 *      = first 32 bytes of SHA-512(input)
 *
 * This matches the C Hook's util_sha512h call.
 */
function oracleRankHash(periodSeq: number, pubkey: Buffer): Buffer {
  const inp = Buffer.alloc(36);
  inp.writeUInt32BE(periodSeq, 0);
  pubkey.copy(inp, 4);
  return createHash("sha512").update(inp).digest().slice(0, 32) as Buffer;
}

/** Compare two 32-byte buffers lexicographically (big-endian). */
function cmpBuf32(a: Buffer, b: Buffer): number {
  for (let i = 0; i < 32; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

// ─── selectCommittee ─────────────────────────────────────────────────────────

/** One member of a selected committee with its rank metadata. */
export interface CommitteeMember {
  oracle:    OracleRegistration;
  rankHash:  Buffer;
  /** Zero-based position in the ordered committee (0 = highest ranked). */
  position:  number;
}

/**
 * Deterministically select K committee members from the registered oracle set.
 *
 * Steps:
 *   1. For each oracle compute rankHash = sha512h(u32be(period_seq) || pubkey).
 *   2. Sort ascending by rankHash (treated as big-endian 256-bit integer).
 *   3. Return the first K entries.
 *
 * @param periodSeq   Period sequence number (seeds the ranking)
 * @param oracles     Full registered oracle set (from readAllOracles)
 * @param K           Number of committee members to select
 * @returns           Ordered committee (position 0 = highest ranked)
 * @throws            If the oracle set is smaller than K
 */
export function selectCommittee(
  periodSeq: number,
  oracles:   OracleRegistration[],
  K:         number,
): CommitteeMember[] {
  if (oracles.length < K)
    throw new Error(
      `Need at least ${K} registered oracles, found ${oracles.length}`,
    );

  const ranked = oracles.map((oracle) => ({
    oracle,
    rankHash: oracleRankHash(periodSeq, oracle.pubkey),
  }));

  ranked.sort((a, b) => cmpBuf32(a.rankHash, b.rankHash));

  return ranked.slice(0, K).map((r, idx) => ({
    oracle:   r.oracle,
    rankHash: r.rankHash,
    position: idx,
  }));
}

// ─── commitCommittee ─────────────────────────────────────────────────────────

/**
 * Commit the selected committee to the regulator's Hook namespace on-chain.
 *
 * Submits a Payment from the regulator to itself with:
 *   MemoType = "COMMIT_COMMITTEE"
 *   MemoData = u32be(period_seq) || pubkey[0] || ... || pubkey[K-1]
 *
 * The registry hook fires, verifies the sender is the regulator, and writes
 * the committee in chunks of ≤4 pubkeys each (to fit within the 128-byte
 * Hook namespace value limit).
 *
 * @param periodSeq   Period sequence number
 * @param committee   Ordered committee from selectCommittee
 * @param regulator   Regulator wallet
 * @param client      Connected XRPL client
 * @returns           Transaction hash
 */
export async function commitCommittee(
  periodSeq: number,
  committee: CommitteeMember[],
  regulator: Wallet,
  client:    Client,
): Promise<string> {
  const K    = committee.length;
  const data = Buffer.alloc(4 + K * 32);
  data.writeUInt32BE(periodSeq, 0);
  for (let i = 0; i < K; i++) {
    committee[i].oracle.pubkey.copy(data, 4 + i * 32);
  }

  const tx = {
    TransactionType: "Payment" as const,
    Account:         regulator.address,
    Destination:     regulator.address,
    Amount:          "1",
    Memos:           [buildMemo("COMMIT_COMMITTEE", data)],
  };

  const prepared = await client.autofill(tx);
  const signed   = regulator.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);

  const txResult: string =
    ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
      ?.TransactionResult as string ?? "unknown";

  if (txResult !== "tesSUCCESS")
    throw new Error(`commitCommittee failed: ${txResult}`);

  return (result.result as Record<string, unknown>).hash as string;
}

// ─── verifyCommittee ─────────────────────────────────────────────────────────

/**
 * Re-derive the committee deterministically and verify it matches the on-chain
 * committed committee.
 *
 * This is a pure client-side check: it recomputes selectCommittee and compares
 * the ordered pubkeys byte-by-byte against the array provided from on-chain.
 *
 * @param periodSeq      Period sequence number
 * @param oracles        Full registered oracle set
 * @param K              Expected committee size
 * @param onChainPubkeys Ordered pubkeys read from the on-chain namespace
 * @returns              true if they match exactly
 */
export function verifyCommittee(
  periodSeq:      number,
  oracles:        OracleRegistration[],
  K:              number,
  onChainPubkeys: Buffer[],
): boolean {
  if (onChainPubkeys.length !== K) return false;
  const derived = selectCommittee(periodSeq, oracles, K);
  for (let i = 0; i < K; i++) {
    if (!derived[i].oracle.pubkey.equals(onChainPubkeys[i])) return false;
  }
  return true;
}

// ─── readCommitteeFromNamespace ───────────────────────────────────────────────

/**
 * Read the committed committee pubkeys from the regulator's Hook namespace.
 *
 * Returns the ordered pubkey list for the given period, reading all chunks.
 * Returns null if the committee has not been committed for this period.
 *
 * @param periodSeq        Period sequence number
 * @param K                Committee size (to know how many chunks to expect)
 * @param regulatorAddress Regulator XRPL address
 * @param client           Connected XRPL client
 */
export async function readCommitteeFromNamespace(
  periodSeq:        number,
  K:                number,
  regulatorAddress: string,
  client:           Client,
): Promise<Buffer[] | null> {
  const { committeeChunkKey } = await import("./types.js");
  const PUBKEYS_PER_CHUNK = 4;
  const numChunks = Math.ceil(K / PUBKEYS_PER_CHUNK);
  const pubkeys: Buffer[] = [];

  for (let chunk = 0; chunk < numChunks; chunk++) {
    const keyHex = committeeChunkKey(periodSeq, chunk)
      .toString("hex")
      .toUpperCase();

    let response: unknown;
    try {
      response = await (client as unknown as {
        request: (r: unknown) => Promise<unknown>;
      }).request({
        command:      "account_namespace",
        account:      regulatorAddress,
        namespace_id: keyHex,
      });
    } catch {
      return null;
    }

    const result  = (response as Record<string, unknown>).result as Record<string, unknown>;
    const entries = result?.namespace_entries as Array<Record<string, string>> | undefined;
    if (!entries) return null;

    const found = entries.find(
      (e) => e.HookStateKey?.toUpperCase() === keyHex,
    );
    if (!found) return null;

    const valBuf = Buffer.from(found.HookStateData, "hex");
    const pksInChunk = Math.floor(valBuf.length / 32);
    for (let i = 0; i < pksInChunk && pubkeys.length < K; i++) {
      pubkeys.push(valBuf.slice(i * 32, i * 32 + 32) as Buffer);
    }
  }

  return pubkeys.length === K ? pubkeys : null;
}
