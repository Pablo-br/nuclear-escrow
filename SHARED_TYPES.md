# NuclearEscrow — Shared Type Schema

> **WARNING:** Borsh encoding is order-sensitive. Field order below is the wire format.
> Do NOT reorder fields in any language implementation.

---

## SiteState

Stored on-ledger as the XRPL Hook `HookState` blob.
Total size: `1 + 5*32 + 7*4 + 32 + 16 + 7*8 = 1 + 160 + 28 + 32 + 16 + 56 = 293 bytes`

| # | Field                  | Type      | Size (bytes) | Notes                          |
|---|------------------------|-----------|--------------|--------------------------------|
| 1 | `current_milestone`    | `u8`      | 1            | 0–6 inclusive                  |
| 2 | `oracle_pubkeys`       | `[u8;32]` × 5 | 160      | Ed25519 public keys            |
| 3 | `thresholds`           | `f32` × 7 | 28           | µSv/h threshold per milestone  |
| 4 | `domain_id`            | `[u8;32]` | 32           | Regulatory domain identifier   |
| 5 | `facility_id`          | `[u8;16]` | 16           | ASCII, zero-padded             |
| 6 | `milestone_timestamps` | `u64` × 7 | 56           | Unix timestamps (0 = not reached) |

---

## MilestoneAttestation

Submitted by oracles via XRPL transaction `Memo` field.
Total size: `1 + 4 + 32 + 5*64 + 1 = 1 + 4 + 32 + 320 + 1 = 358 bytes`

| # | Field                  | Type       | Size (bytes) | Notes                               |
|---|------------------------|------------|--------------|-------------------------------------|
| 1 | `milestone_index`      | `u8`       | 1            | Which milestone is being attested   |
| 2 | `sensor_reading_usv`   | `f32`      | 4            | Radiation sensor value in µSv/h     |
| 3 | `sensor_reading_hash`  | `[u8;32]`  | 32           | SHA-256 of raw sensor batch         |
| 4 | `oracle_signatures`    | `[u8;64]` × 5 | 320       | Ed25519 sigs; zero-filled if absent |
| 5 | `signature_bitmap`     | `u8`       | 1            | Bit `i` = 1 if oracle `i` signed   |

---

## Helper Functions

### `facilityIdToBytes(id: string): Uint8Array`
- UTF-8 encode `id`, zero-pad to exactly 16 bytes.
- Throws if `id` encodes to more than 16 bytes.

### `buildAttestationMsg(milestoneIndex, sensorHash, facilityId): Uint8Array`
Computes the canonical message that oracles sign:

```
input = [milestoneIndex_byte(1)] ++ sensorHash[32] ++ facilityIdBytes[16]
                                                         ^^ zero-padded to 16
result = sha256(input)   -- total input = 49 bytes
```

---

## Test Vector (GROUND TRUTH)

All engineers must reproduce this exact hex output.

```
Input:
  milestoneIndex = 1
  sensorHash     = sha256("mock-sensor-batch-001")   -- 32 bytes
  facilityId     = "PLANT-FR-001"

Computation:
  facilityIdBytes = utf8("PLANT-FR-001") zero-padded to 16 bytes
  input[0]        = 0x01
  input[1..32]    = sha256("mock-sensor-batch-001")
  input[33..48]   = facilityIdBytes
  result          = sha256(input[0..48])
```

**Expected output:**
```
11f3e63da67de7dbcd55946bcf995d0b72171f88bfa1f2b0f57a76f128c282af
```

Run to reproduce:
```bash
npx tsx shared/src/test-vector.ts
```

> The hex above is the canonical attestation message digest.
> Engineers A (Rust/WASM) and C (XRPL Hook) must match this output exactly.

---

## Encoding Notes

- All integers: **little-endian** (Borsh standard)
- `f32`: IEEE 754 single-precision, little-endian
- `u64`: unsigned 64-bit, little-endian
- Fixed-size arrays: packed with no length prefix (not Borsh dynamic arrays)
- No optional fields, no dynamic-length fields
