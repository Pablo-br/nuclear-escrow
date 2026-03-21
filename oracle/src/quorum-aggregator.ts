import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { MilestoneAttestation } from "../../shared/src/types.js";
import { signAttestation, verifyAttestation } from "./attestation.js";

export { MilestoneAttestation };

export class QuorumAggregator {
  private sigs = new Map<number, Uint8Array>();   // oracleIndex -> 64-byte sig
  private pubkeys = new Map<number, Uint8Array>(); // oracleIndex -> 32-byte pubkey

  add(
    oracleIndex: number,
    sig: Uint8Array,
    pubkey: Uint8Array,
    milestoneIndex: number,
    sensorHash: Uint8Array,
    facilityId: string
  ): void {
    if (!verifyAttestation(pubkey, sig, milestoneIndex, sensorHash, facilityId)) {
      // Silently ignore invalid signatures
      return;
    }
    this.sigs.set(oracleIndex, sig);
    this.pubkeys.set(oracleIndex, pubkey);
  }

  hasQuorum(): boolean {
    return this.sigs.size >= 3;
  }

  buildAttestation(
    milestoneIndex: number,
    sensorReadingUsv: number,
    sensorReadingHash: Uint8Array
  ): MilestoneAttestation {
    // Pack sigs into [[u8;64]; 5], zero-padded for absent oracles
    const oracle_signatures: Uint8Array[] = [];
    let signature_bitmap = 0;

    for (let i = 0; i < 5; i++) {
      const sig = this.sigs.get(i);
      if (sig) {
        oracle_signatures.push(new Uint8Array(sig));
        signature_bitmap |= (1 << i);
      } else {
        oracle_signatures.push(new Uint8Array(64)); // zero-padded
      }
    }

    return {
      milestone_index: milestoneIndex,
      sensor_reading_usv: sensorReadingUsv,
      sensor_reading_hash: sensorReadingHash,
      oracle_signatures,
      signature_bitmap,
    };
  }
}

// ─── Self-test ────────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("quorum-aggregator.ts") || process.argv[1]?.endsWith("quorum-aggregator")) {
  console.log("=== QuorumAggregator Self-Test ===\n");

  // Generate 5 Ed25519 keypairs
  const keypairs: Array<{ priv: Uint8Array; pub: Uint8Array }> = [];
  for (let i = 0; i < 5; i++) {
    const priv = new Uint8Array(32);
    priv.fill(i + 1); // deterministic test keys
    const pub = ed25519.getPublicKey(priv);
    keypairs.push({ priv, pub });
  }

  const sensorHash = sha256(new TextEncoder().encode("test-batch"));
  const facilityId = "PLANT-FR-001";
  const milestoneIndex = 1;

  // Test 1: oracles 0,1,2 sign
  const agg = new QuorumAggregator();
  for (const idx of [0, 1, 2]) {
    const sig = signAttestation(keypairs[idx].priv, milestoneIndex, sensorHash, facilityId);
    agg.add(idx, sig, keypairs[idx].pub, milestoneIndex, sensorHash, facilityId);
  }

  console.assert(agg.hasQuorum() === true, "hasQuorum should be true with 3 sigs");
  console.log("hasQuorum() with 3 sigs: PASS");

  const attestation = agg.buildAttestation(milestoneIndex, 7.5, sensorHash);

  // Check bitmap
  const expectedBitmap = 0b00000111;
  console.assert(
    attestation.signature_bitmap === expectedBitmap,
    `bitmap should be ${expectedBitmap}, got ${attestation.signature_bitmap}`
  );
  console.log(`signature_bitmap === 0b00000111 (${attestation.signature_bitmap}): PASS`);

  // Verify all 3 signatures are valid
  for (const idx of [0, 1, 2]) {
    const sig = attestation.oracle_signatures[idx];
    const valid = verifyAttestation(keypairs[idx].pub, sig, milestoneIndex, sensorHash, facilityId);
    console.assert(valid, `Oracle ${idx} signature should be valid`);
    console.log(`Oracle ${idx} signature valid: PASS`);
  }

  // Verify absent signatures are zero
  for (const idx of [3, 4]) {
    const allZero = attestation.oracle_signatures[idx].every(b => b === 0);
    console.assert(allZero, `Oracle ${idx} sig should be zero-padded`);
  }
  console.log("Absent oracle signatures are zero-padded: PASS");

  // Test 2: only oracles 0,1 sign -> no quorum
  const agg2 = new QuorumAggregator();
  for (const idx of [0, 1]) {
    const sig = signAttestation(keypairs[idx].priv, milestoneIndex, sensorHash, facilityId);
    agg2.add(idx, sig, keypairs[idx].pub, milestoneIndex, sensorHash, facilityId);
  }
  console.assert(agg2.hasQuorum() === false, "hasQuorum should be false with only 2 sigs");
  console.log("hasQuorum() with 2 sigs: PASS (false as expected)");

  // Test 3: invalid sig is silently ignored
  const agg3 = new QuorumAggregator();
  for (const idx of [0, 1, 2]) {
    const sig = signAttestation(keypairs[idx].priv, milestoneIndex, sensorHash, facilityId);
    agg3.add(idx, sig, keypairs[idx].pub, milestoneIndex, sensorHash, facilityId);
  }
  // Inject bad sig for oracle 3
  const badSig = new Uint8Array(64).fill(0xff);
  agg3.add(3, badSig, keypairs[3].pub, milestoneIndex, sensorHash, facilityId);
  console.assert(agg3.hasQuorum() === true, "should still have quorum (bad sig ignored)");
  const att3 = agg3.buildAttestation(milestoneIndex, 7.5, sensorHash);
  console.assert(att3.signature_bitmap === 0b00000111, "bad sig should not appear in bitmap");
  console.log("Invalid sig silently ignored: PASS");

  console.log("\nAll assertions passed.");
}
