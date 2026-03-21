/**
 * Test vector for NuclearEscrow shared schema.
 *
 * GROUND TRUTH: All engineers (A, B, C) must produce this exact hex.
 *
 * Computation:
 *   msg = buildAttestationMsg(
 *     milestoneIndex = 1,
 *     sensorHash     = sha256("mock-sensor-batch-001"),
 *     facilityId     = "PLANT-FR-001"
 *   )
 *
 * Internally:
 *   input[0]     = 0x01                          (milestoneIndex byte)
 *   input[1..32] = sha256("mock-sensor-batch-001") (32 bytes)
 *   input[33..48]= utf8("PLANT-FR-001") zero-padded to 16 bytes
 *   result       = sha256(input[0..48])           (49 bytes total)
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { buildAttestationMsg } from "./index.js";

const sensorHash = sha256(new TextEncoder().encode("mock-sensor-batch-001"));
const msg = buildAttestationMsg(1, sensorHash, "PLANT-FR-001");

const hex = Buffer.from(msg).toString("hex");
console.log("TEST VECTOR (attestation msg hex):");
console.log(hex);
