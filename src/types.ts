/**
 * src/types.ts — Canonical TypeScript types and binary-layout constants for
 * the XRPL Hooks compliance system.
 *
 * All multi-byte integers are big-endian unless noted.
 * sha512h = first 32 bytes of SHA-512 (used for namespace keys, matching
 *           the C Hook's util_sha512h).
 */

import { createHash } from "crypto";

// ─── Schema version ──────────────────────────────────────────────────────────

/** Schema version baked into Hook parameters and proof blobs. */
export const SCHEMA_VERSION = 1;

// ─── Binary sizes ─────────────────────────────────────────────────────────────

/** Size in bytes of one VoteEntry inside a ProofBlob. */
export const VOTE_ENTRY_SIZE = 97; // pubkey(32) + vote(1) + sig(64)

/** Minimum proof blob size (header only, no entries). */
export const PROOF_BLOB_HEADER_SIZE = 10; // schema(1)+period_seq(4)+ledger_ts(4)+vote_count(1)

/** Size of the oracle canonical signed payload. */
export const ORACLE_PAYLOAD_SIZE = 29; // period_seq(4)+company_acct(20)+vote(1)+ledger_ts(4)

// ─── Vote values ─────────────────────────────────────────────────────────────

export const VOTE_COMPLIANT: 0x01 = 0x01;
export const VOTE_NON_COMPLIANT: 0x00 = 0x00;
export type VoteValue = typeof VOTE_COMPLIANT | typeof VOTE_NON_COMPLIANT;

// ─── Period status values ─────────────────────────────────────────────────────

export const PERIOD_STATUS_INACTIVE  = 0;
export const PERIOD_STATUS_ACTIVE    = 1;
export const PERIOD_STATUS_FINALIZED = 2;

// ─── Namespace state key definitions ─────────────────────────────────────────
//
// Compliance hook namespace (company account):
//   "COLLATERAL_DROPS" (16 chars) zero-padded to 32 bytes → u64 drops
//   "PERIOD_SEQ"       (10 chars) zero-padded to 32 bytes → u32 period seq
//   "PERIOD_LEDGER"    (13 chars) zero-padded to 32 bytes → u32 ledger seq of LOCK tx
//   "PERIOD_STATUS"    (13 chars) zero-padded to 32 bytes → u8  0/1/2
//
// Registry hook namespace (regulator account):
//   pubkey (32 bytes verbatim) → u32be(timestamp) || i32be(rep_score)
//   sha512h("COMMITTEE" || u32be(period_seq) || u8(chunk)) → K×pubkey chunks

/** Produce the 32-byte namespace key for a compliance-hook state field. */
export function complianceStateKey(name: string): Buffer {
  const key = Buffer.alloc(32);
  Buffer.from(name, "ascii").copy(key);
  return key;
}

export const SK_COLLATERAL_DROPS = complianceStateKey("COLLATERAL_DROPS");
export const SK_PERIOD_SEQ       = complianceStateKey("PERIOD_SEQ");
export const SK_PERIOD_LEDGER    = complianceStateKey("PERIOD_LEDGER");
export const SK_PERIOD_STATUS    = complianceStateKey("PERIOD_STATUS");

/**
 * Compute the 32-byte namespace key for a committee chunk in the regulator's
 * Hook namespace.
 *
 * key = sha512h("COMMITTEE" || u32be(period_seq) || u8(chunk))
 */
export function committeeChunkKey(periodSeq: number, chunk: number): Buffer {
  const inp = Buffer.alloc(14);
  inp.write("COMMITTEE", 0, "ascii");
  inp.writeUInt32BE(periodSeq, 9);
  inp[13] = chunk & 0xff;
  return createHash("sha512").update(inp).digest().slice(0, 32) as Buffer;
}

// ─── VoteEntry ───────────────────────────────────────────────────────────────

/** One oracle's vote inside a ProofBlob. */
export interface VoteEntry {
  /** Ed25519 public key (32 bytes, no XRPL "ED" prefix). */
  pubkey: Buffer;
  /** 0x01 = compliant, 0x00 = non-compliant. */
  vote: VoteValue;
  /** 64-byte Ed25519 signature over the canonical oracle payload. */
  signature: Buffer;
}

// ─── OracleSignedPayload ──────────────────────────────────────────────────────

/**
 * The exact 29-byte canonical payload that each oracle signs with Ed25519.
 *
 * Layout:
 *   [0..3]   period_seq         (u32 BE)
 *   [4..23]  company_account_id (20-byte AccountID)
 *   [24]     vote               (0x01 or 0x00)
 *   [25..28] ledger_ts          (u32 BE, ledger sequence of the LOCK tx)
 */
export function buildOraclePayload(
  periodSeq: number,
  companyAccountId: Buffer,
  vote: VoteValue,
  ledgerTs: number,
): Buffer {
  if (companyAccountId.length !== 20)
    throw new Error("companyAccountId must be 20 bytes");
  const buf = Buffer.alloc(ORACLE_PAYLOAD_SIZE);
  buf.writeUInt32BE(periodSeq, 0);
  companyAccountId.copy(buf, 4);
  buf[24] = vote;
  buf.writeUInt32BE(ledgerTs, 25);
  return buf;
}

// ─── ProofBlob ────────────────────────────────────────────────────────────────

/** Decoded proof blob (parsed from the raw binary). */
export interface ProofBlob {
  /** Must match SCHEMA_VERSION. */
  schemaVersion: number;
  /** Period sequence number. */
  periodSeq: number;
  /** Ledger sequence of the LOCK transaction (replay protection). */
  ledgerTs: number;
  /** Ordered list of vote entries. */
  voteEntries: VoteEntry[];
}

/**
 * Serialise a ProofBlob into the binary wire format used in the PROOF memo.
 *
 * Binary layout:
 *   [0]        schema_version  (1 byte)
 *   [1..4]     period_seq      (u32 BE)
 *   [5..8]     ledger_ts       (u32 BE)
 *   [9]        vote_count      (1 byte)
 *   [10..]     VoteEntry[]     (vote_count × 97 bytes)
 *
 * VoteEntry wire layout (97 bytes):
 *   [0..31]    pubkey          (32 bytes)
 *   [32]       vote            (1 byte)
 *   [33..96]   signature       (64 bytes)
 */
export function encodeProofBlob(blob: ProofBlob): Buffer {
  const n = blob.voteEntries.length;
  const buf = Buffer.alloc(PROOF_BLOB_HEADER_SIZE + n * VOTE_ENTRY_SIZE);
  buf[0] = blob.schemaVersion & 0xff;
  buf.writeUInt32BE(blob.periodSeq, 1);
  buf.writeUInt32BE(blob.ledgerTs, 5);
  buf[9] = n & 0xff;
  for (let i = 0; i < n; i++) {
    const e = blob.voteEntries[i];
    const off = PROOF_BLOB_HEADER_SIZE + i * VOTE_ENTRY_SIZE;
    if (e.pubkey.length !== 32) throw new Error(`Entry ${i}: pubkey must be 32 bytes`);
    if (e.signature.length !== 64) throw new Error(`Entry ${i}: signature must be 64 bytes`);
    e.pubkey.copy(buf, off);
    buf[off + 32] = e.vote;
    e.signature.copy(buf, off + 33);
  }
  return buf;
}

/** Deserialise a binary proof blob. */
export function decodeProofBlob(raw: Buffer): ProofBlob {
  if (raw.length < PROOF_BLOB_HEADER_SIZE)
    throw new Error("Proof blob too short");
  const schemaVersion = raw[0];
  const periodSeq = raw.readUInt32BE(1);
  const ledgerTs  = raw.readUInt32BE(5);
  const voteCount = raw[9];
  if (raw.length < PROOF_BLOB_HEADER_SIZE + voteCount * VOTE_ENTRY_SIZE)
    throw new Error("Proof blob truncated");
  const voteEntries: VoteEntry[] = [];
  for (let i = 0; i < voteCount; i++) {
    const off = PROOF_BLOB_HEADER_SIZE + i * VOTE_ENTRY_SIZE;
    voteEntries.push({
      pubkey:    raw.slice(off,       off + 32) as Buffer,
      vote:      raw[off + 32] as VoteValue,
      signature: raw.slice(off + 33, off + 97) as Buffer,
    });
  }
  return { schemaVersion, periodSeq, ledgerTs, voteEntries };
}

// ─── OracleRegistration ───────────────────────────────────────────────────────

/** Oracle entry as stored / read from the registry hook namespace. */
export interface OracleRegistration {
  /** Ed25519 public key (32 bytes, no XRPL "ED" prefix). */
  pubkey: Buffer;
  /** Ledger sequence at registration time (used as timestamp). */
  registeredAt: number;
  /** Reputation score (signed integer, starts at 0). */
  reputationScore: number;
}

/** Serialise registration value (8 bytes): u32be(timestamp) || i32be(rep). */
export function encodeRegistrationValue(
  timestamp: number,
  reputation: number,
): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32BE(timestamp, 0);
  b.writeInt32BE(reputation, 4);
  return b;
}

/** Deserialise registration value. */
export function decodeRegistrationValue(
  b: Buffer,
  pubkey: Buffer,
): OracleRegistration {
  if (b.length < 8) throw new Error("Registration value must be 8 bytes");
  return {
    pubkey,
    registeredAt:    b.readUInt32BE(0),
    reputationScore: b.readInt32BE(4),
  };
}

// ─── TemplateRecord ───────────────────────────────────────────────────────────

/**
 * Template record stored in the regulator's Hook namespace.
 *
 * Binary layout (79 bytes):
 *   [0]        schema_version         (1 byte)
 *   [1..20]    regulator_account_id   (20 bytes)
 *   [21..40]   contractor_account_id  (20 bytes)
 *   [41..60]   company_account_id     (20 bytes)
 *   [61..68]   period_duration_s      (u64 BE)
 *   [69..76]   collateral_drops       (u64 BE)
 *   [77]       N  (total oracle pool size)
 *   [78]       M  (Byzantine threshold ≥ ⌊2N/3⌋ + 1)
 */
export interface TemplateRecord {
  schemaVersion:       number;
  regulatorAccountId:  Buffer;
  contractorAccountId: Buffer;
  companyAccountId:    Buffer;
  periodDurationSecs:  bigint;
  collateralDrops:     bigint;
  N: number;
  M: number;
}

export const TEMPLATE_RECORD_SIZE = 79;

export function encodeTemplateRecord(t: TemplateRecord): Buffer {
  const buf = Buffer.alloc(TEMPLATE_RECORD_SIZE);
  buf[0] = t.schemaVersion & 0xff;
  t.regulatorAccountId.copy(buf,  1);
  t.contractorAccountId.copy(buf, 21);
  t.companyAccountId.copy(buf,    41);
  buf.writeBigUInt64BE(t.periodDurationSecs, 61);
  buf.writeBigUInt64BE(t.collateralDrops,    69);
  buf[77] = t.N & 0xff;
  buf[78] = t.M & 0xff;
  return buf;
}

export function decodeTemplateRecord(buf: Buffer): TemplateRecord {
  if (buf.length < TEMPLATE_RECORD_SIZE)
    throw new Error("Template record too short");
  return {
    schemaVersion:       buf[0],
    regulatorAccountId:  buf.slice(1,  21) as Buffer,
    contractorAccountId: buf.slice(21, 41) as Buffer,
    companyAccountId:    buf.slice(41, 61) as Buffer,
    periodDurationSecs:  buf.readBigUInt64BE(61),
    collateralDrops:     buf.readBigUInt64BE(69),
    N: buf[77],
    M: buf[78],
  };
}

/** 32-byte namespace key for the template record in the regulator's namespace. */
export const TEMPLATE_NAMESPACE_KEY: Buffer = (() => {
  const inp = Buffer.from("TEMPLATE", "ascii");
  return createHash("sha512").update(inp).digest().slice(0, 32) as Buffer;
})();

// ─── Hook parameter encoding helpers ─────────────────────────────────────────

/**
 * Encode a hook parameter name and value for use in a SetHook transaction's
 * HookParameters array.
 *
 * In xrpl.js, HookParameterName and HookParameterValue are hex strings
 * representing the raw bytes.
 */
export function hookParam(name: string, value: Buffer): { HookParameter: { HookParameterName: string; HookParameterValue: string } } {
  return {
    HookParameter: {
      HookParameterName:  Buffer.from(name, "ascii").toString("hex").toUpperCase(),
      HookParameterValue: value.toString("hex").toUpperCase(),
    },
  };
}

/**
 * Encode all compliance hook parameters into the HookParameters array for
 * a SetHook transaction.
 *
 * @param regulatorAccountId  20-byte AccountID of the regulator
 * @param contractorAccountId 20-byte AccountID of the contractor
 * @param schemaVersion       Expected schema version (1 byte)
 * @param M                   Byzantine threshold (1 byte)
 * @param K                   Committee size (1 byte)
 * @param collateralDrops     Expected collateral (8 bytes, u64 BE)
 */
export function complianceHookParams(
  regulatorAccountId:  Buffer,
  contractorAccountId: Buffer,
  schemaVersion: number,
  M: number,
  K: number,
  collateralDrops: bigint,
): Array<ReturnType<typeof hookParam>> {
  const collat = Buffer.alloc(8);
  collat.writeBigUInt64BE(collateralDrops);
  return [
    hookParam("REGULATOR",   regulatorAccountId),
    hookParam("CONTRACTOR",  contractorAccountId),
    hookParam("SCHEMA_VER",  Buffer.from([schemaVersion & 0xff])),
    hookParam("M_THRESHOLD", Buffer.from([M & 0xff])),
    hookParam("K_COMMITTEE", Buffer.from([K & 0xff])),
    hookParam("COLLAT_DROPS", collat),
  ];
}

/**
 * Encode all registry hook parameters into the HookParameters array.
 *
 * @param regulatorAccountId 20-byte AccountID of the regulator
 */
export function registryHookParams(
  regulatorAccountId: Buffer,
): Array<ReturnType<typeof hookParam>> {
  return [hookParam("REGULATOR", regulatorAccountId)];
}

// ─── Memo helpers ─────────────────────────────────────────────────────────────

/**
 * Build an XRPL memo object for use in xrpl.js transactions.
 *
 * xrpl.js expects MemoType and MemoData as upper-case hex strings of the raw
 * bytes (not URL-encoded). The Hook's memo_type() returns those same raw bytes.
 */
export function buildMemo(type: string, data: Buffer): { Memo: { MemoType: string; MemoData: string } } {
  return {
    Memo: {
      MemoType: Buffer.from(type, "ascii").toString("hex").toUpperCase(),
      MemoData: data.toString("hex").toUpperCase(),
    },
  };
}

/**
 * Encode LOCK memo data: period_seq (4 bytes, u32 BE).
 */
export function encodeLockMemoData(periodSeq: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(periodSeq, 0);
  return b;
}

// ─── HookOn field ────────────────────────────────────────────────────────────

/**
 * HookOn field value for "fire on Payment transactions only".
 *
 * HookOn is a 256-bit field where bit N = 0 means "fire on transaction type N"
 * and bit N = 1 means "do not fire". ttPAYMENT = 0 → bit 0 must be 0.
 * All other bits are 1 → "FFFE...FE" (31 bytes 0xFF, final byte 0xFE).
 */
export const HOOK_ON_PAYMENT_ONLY =
  "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE";
