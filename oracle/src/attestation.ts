import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

// ─── facilityIdToBytes ────────────────────────────────────────────────────────
// UTF-8 encode, zero-pad to exactly 16 bytes
function facilityIdToBytes(id: string): Uint8Array {
  const enc = new TextEncoder().encode(id);
  if (enc.length > 16) throw new Error("facility_id exceeds 16 bytes");
  const out = new Uint8Array(16);
  out.set(enc);
  return out;
}

// ─── buildAttestationMsg ──────────────────────────────────────────────────────
// sha256( [milestoneIndex_byte(1)] ++ sensorHash[32] ++ facilityIdBytes[16] )
// Total input: 49 bytes
export function buildAttestationMsg(
  milestoneIndex: number,
  sensorReadingHash: Uint8Array,
  facilityId: string
): Uint8Array {
  if (sensorReadingHash.length !== 32)
    throw new Error("sensorReadingHash must be 32 bytes");

  const facilityIdBytes = facilityIdToBytes(facilityId);

  const input = new Uint8Array(49);
  input[0] = milestoneIndex & 0xff;
  input.set(sensorReadingHash, 1);
  input.set(facilityIdBytes, 33);

  return sha256(input);
}

// ─── signAttestation ─────────────────────────────────────────────────────────
// Returns 64-byte Ed25519 signature
export function signAttestation(
  privateKey: Uint8Array,
  milestoneIndex: number,
  sensorReadingHash: Uint8Array,
  facilityId: string
): Uint8Array {
  const msg = buildAttestationMsg(milestoneIndex, sensorReadingHash, facilityId);
  return ed25519.sign(msg, privateKey);
}

// ─── verifyAttestation ───────────────────────────────────────────────────────
export function verifyAttestation(
  publicKey: Uint8Array,
  sig: Uint8Array,
  milestoneIndex: number,
  sensorReadingHash: Uint8Array,
  facilityId: string
): boolean {
  try {
    const msg = buildAttestationMsg(milestoneIndex, sensorReadingHash, facilityId);
    return ed25519.verify(sig, msg, publicKey);
  } catch {
    return false;
  }
}

// ─── MANDATORY TEST ──────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("attestation.ts") || process.argv[1]?.endsWith("attestation")) {
  const EXPECTED = "11f3e63da67de7dbcd55946bcf995d0b72171f88bfa1f2b0f57a76f128c282af";

  const sensorHash = sha256(new TextEncoder().encode("mock-sensor-batch-001"));
  const msg = buildAttestationMsg(1, sensorHash, "PLANT-FR-001");
  const hex = Buffer.from(msg).toString("hex");

  console.log("buildAttestationMsg test vector:");
  console.log("  Got:      ", hex);
  console.log("  Expected: ", EXPECTED);

  if (hex !== EXPECTED) {
    console.error("MISMATCH! Fix the bug before continuing.");
    process.exit(1);
  }
  console.log("  => MATCH ✓");

  // Also test sign/verify round-trip
  const privKey = new Uint8Array(32).fill(42); // deterministic test key
  const pubKey = ed25519.getPublicKey(privKey);
  const sig = signAttestation(privKey, 1, sensorHash, "PLANT-FR-001");
  const valid = verifyAttestation(pubKey, sig, 1, sensorHash, "PLANT-FR-001");
  console.log(`\nSign/verify round-trip: ${valid ? "PASS" : "FAIL"}`);
  if (!valid) process.exit(1);
}
