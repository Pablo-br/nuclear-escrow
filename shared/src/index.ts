import { sha256 } from "@noble/hashes/sha2.js";
import { SiteState, MilestoneAttestation } from "./types.js";

export type { SiteState, MilestoneAttestation };

// ─── Borsh helpers ────────────────────────────────────────────────────────────

class BorshWriter {
  private buf: number[] = [];

  writeU8(v: number): void {
    this.buf.push(v & 0xff);
  }

  writeF32(v: number): void {
    const ab = new ArrayBuffer(4);
    new DataView(ab).setFloat32(0, v, true); // little-endian
    this.buf.push(...new Uint8Array(ab));
  }

  writeU64(v: bigint): void {
    const ab = new ArrayBuffer(8);
    new DataView(ab).setBigUint64(0, v, true); // little-endian
    this.buf.push(...new Uint8Array(ab));
  }

  writeFixedBytes(bytes: Uint8Array, expectedLen: number): void {
    if (bytes.length !== expectedLen) {
      throw new Error(
        `Expected ${expectedLen} bytes, got ${bytes.length}`
      );
    }
    this.buf.push(...bytes);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf);
  }
}

class BorshReader {
  private offset = 0;
  constructor(private buf: Buffer) {}

  readU8(): number {
    return this.buf[this.offset++];
  }

  readF32(): number {
    const v = this.buf.readFloatLE(this.offset);
    this.offset += 4;
    return v;
  }

  readU64(): bigint {
    const v = this.buf.readBigUInt64LE(this.offset);
    this.offset += 8;
    return v;
  }

  readFixedBytes(len: number): Uint8Array {
    const slice = this.buf.slice(this.offset, this.offset + len);
    this.offset += len;
    return new Uint8Array(slice);
  }
}

// ─── encodeSiteState ──────────────────────────────────────────────────────────
// Field order (borsh wire format):
//   u8  current_milestone
//   5x [u8;32]  oracle_pubkeys
//   7x f32      thresholds
//   [u8;32]     domain_id
//   [u8;16]     facility_id
//   7x u64      milestone_timestamps

export function encodeSiteState(s: SiteState): Buffer {
  const w = new BorshWriter();

  w.writeU8(s.current_milestone);

  if (s.oracle_pubkeys.length !== 5)
    throw new Error("oracle_pubkeys must have 5 entries");
  for (const pk of s.oracle_pubkeys) w.writeFixedBytes(pk, 32);

  if (s.thresholds.length !== 7)
    throw new Error("thresholds must have 7 entries");
  for (const t of s.thresholds) w.writeF32(t);

  w.writeFixedBytes(s.domain_id, 32);
  w.writeFixedBytes(s.facility_id, 16);

  if (s.milestone_timestamps.length !== 7)
    throw new Error("milestone_timestamps must have 7 entries");
  for (const ts of s.milestone_timestamps) w.writeU64(ts);

  return w.toBuffer();
}

export function decodeSiteState(b: Buffer): SiteState {
  const r = new BorshReader(b);

  const current_milestone = r.readU8();

  const oracle_pubkeys: Uint8Array[] = [];
  for (let i = 0; i < 5; i++) oracle_pubkeys.push(r.readFixedBytes(32));

  const thresholds: number[] = [];
  for (let i = 0; i < 7; i++) thresholds.push(r.readF32());

  const domain_id = r.readFixedBytes(32);
  const facility_id = r.readFixedBytes(16);

  const milestone_timestamps: bigint[] = [];
  for (let i = 0; i < 7; i++) milestone_timestamps.push(r.readU64());

  return {
    current_milestone,
    oracle_pubkeys,
    thresholds,
    domain_id,
    facility_id,
    milestone_timestamps,
  };
}

// ─── encodeMilestoneAttestation ───────────────────────────────────────────────
// Field order (borsh wire format):
//   u8         milestone_index
//   f32        sensor_reading_usv
//   [u8;32]    sensor_reading_hash
//   5x [u8;64] oracle_signatures   (zero-padded for absent)
//   u8         signature_bitmap

export function encodeMilestoneAttestation(a: MilestoneAttestation): Buffer {
  const w = new BorshWriter();

  w.writeU8(a.milestone_index);
  w.writeF32(a.sensor_reading_usv);
  w.writeFixedBytes(a.sensor_reading_hash, 32);

  if (a.oracle_signatures.length !== 5)
    throw new Error("oracle_signatures must have 5 entries");
  for (const sig of a.oracle_signatures) w.writeFixedBytes(sig, 64);

  w.writeU8(a.signature_bitmap);

  return w.toBuffer();
}

// ─── facilityIdToBytes ────────────────────────────────────────────────────────
// UTF-8 encode, zero-pad to 16 bytes

export function facilityIdToBytes(id: string): Uint8Array {
  const enc = new TextEncoder().encode(id);
  if (enc.length > 16) throw new Error("facility_id exceeds 16 bytes");
  const out = new Uint8Array(16);
  out.set(enc);
  return out;
}

// ─── buildAttestationMsg ──────────────────────────────────────────────────────
// sha256( [milestoneIndex_byte(1)] ++ sensorHash[32] ++ facilityIdBytes[16] )
// total input = 49 bytes

export function buildAttestationMsg(
  milestoneIndex: number,
  sensorHash: Uint8Array,
  facilityId: string
): Uint8Array {
  if (sensorHash.length !== 32)
    throw new Error("sensorHash must be 32 bytes");

  const facilityIdBytes = facilityIdToBytes(facilityId);

  // Build 49-byte input
  const input = new Uint8Array(49);
  input[0] = milestoneIndex & 0xff;
  input.set(sensorHash, 1);
  input.set(facilityIdBytes, 33);

  return sha256(input);
}
