# Migration: Native XRPL Escrow → XRPL Hooks

## Overview

This document describes the complete migration from the original native-escrow
system (WASM EscrowFinish verification) to a fully Hook-based compliance scheme
that contains no escrow logic anywhere.

---

## File Mapping

### Deleted (no replacement)

| Old file | Reason |
|---|---|
| `wasm/` (entire directory) | WASM EscrowFinish contract replaced by XRPL Hooks C code |
| `contracts/src/escrow-create.ts` | No escrow anywhere in the new system |
| `contracts/src/escrow-finish.ts` | Same |
| `contracts/src/child-escrow-spawn.ts` | No child escrows |
| `contracts/src/domain-setup.ts` | Permissioned Domain replaced by Hook namespace |
| `contracts/src/credential-issuer.ts` | XRPL credentials replaced by on-chain oracle pubkey registration |
| `contracts/src/mpt-receipt.ts` | MPT milestone receipts are out of scope for this migration |
| `cli/init.ts` | Replaced by `src/regulator.ts` + `src/company.ts` |
| `cli/submit-milestone.ts` | Replaced by `src/company.ts` |
| `cli/recover-spawn.ts` | No child escrows to recover |
| `shared/src/index.ts` | Borsh encoder/decoder replaced by Buffer helpers in `src/types.ts` |

### Replaced

| Old file | New file | Notes |
|---|---|---|
| `shared/src/types.ts` + `shared/src/contract-template.ts` | `src/types.ts` | SiteState/MilestoneAttestation removed; new binary layouts for ProofBlob, VoteEntry, TemplateRecord, Hook parameters, namespace keys |
| `oracle/src/attestation.ts` | Signing logic now in `src/company.ts::buildVoteEntry` | Canonical payload format changed (see below) |
| `oracle/src/quorum-aggregator.ts` | `src/company.ts::buildProofBlob` | Proof blob replaces the bitmap/slot model |
| `contracts/src/config.ts` | Reused directly | Wallet loading and env-var config unchanged |

### New (no predecessor)

| File | Purpose |
|---|---|
| `hook/compliance_hook.c` | XRPL Hook on company account — collateral locking, Byzantine proof verification, fund emission |
| `hook/registry_hook.c` | XRPL Hook on regulator account — oracle registration, committee commitment, reputation updates |
| `hook/Makefile` | Builds both Hooks to `wasm32-unknown-unknown` using Hooks Builder SDK |
| `src/types.ts` | All canonical types and binary-layout constants |
| `src/oracle-registry.ts` | Register oracles, read namespace, read reputation |
| `src/committee.ts` | Deterministic committee selection and on-chain commitment |
| `src/regulator.ts` | Template publication, period opening, registry hook installation |
| `src/company.ts` | Compliance hook installation, collateral locking, proof construction and submission |
| `tests/compliance.test.ts` | Full end-to-end test suite (10 tests) |
| `MIGRATION.md` | This file |

### Kept unchanged

| File | Notes |
|---|---|
| `oracle/src/sensor-simulator.ts` | Sensor simulation logic is Hook-agnostic |
| `contracts/src/config.ts` | Wallet loading unchanged |
| `dashboard/` | Dashboard kept as-is (out of scope) |

---

## Architecture Comparison

### Old system

```
Regulator
  ├─ Creates Permissioned Domain
  ├─ Issues OperatingLicense credential to Operator
  ├─ Issues ContractorCert credential to Contractor
  └─ Issues OracleNode credentials to 5 fixed oracles

Operator (= Company)
  ├─ EscrowCreate (locks 1 XRP → Contractor, encodes SiteState in memo)
  ├─ Per milestone: 3-of-5 oracles sign MilestoneAttestation
  └─ EscrowFinish (submits attestation → WASM verifies → releases funds)

WASM contract (embedded in EscrowFinish)
  └─ Checks: sequence, 3-of-5 quorum, threshold, updates SiteState

Collateral flow: Operator → Escrow ledger object → Contractor
```

### New system

```
Regulator account  ← registry_hook.c installed
  ├─ REGISTER_ORACLE payments → write oracle pubkey to namespace
  ├─ COMMIT_COMMITTEE payments → write ordered K-member committee per period
  └─ REPU (emitted) payments → update reputation scores

Company account  ← compliance_hook.c installed
  ├─ LOCK payment (self) → lock collateral in namespace state
  └─ PROOF payment (self) → verify M-of-K Byzantine oracle consensus
       ├─ Compliant M+ votes → emit Payment back to company
       ├─ Non-compliant M+ votes → emit Payment to contractor
       ├─ Neither → rollback "no consensus"
       └─ Either finalisation → emit REPU to regulator

Collateral flow: Company balance (locked logically in Hook namespace)
                 → Company (compliant) or Contractor (non-compliant)

The regulator never holds company funds at any point.
No EscrowCreate, EscrowFinish, or EscrowCancel transactions exist.
```

---

## Committee Selection Algorithm

### Inputs

- `period_seq` — monotonically increasing period counter (u32)
- `oracles` — full set of registered oracle public keys (ed25519, 32 bytes each)
- `K` — committee size = max(3M − 2, 3) where M is the Byzantine threshold

### Steps

1. **Rank hash computation**: for each oracle compute
   ```
   rank_hash = sha512h( u32be(period_seq) || pubkey_32bytes )
   ```
   where `sha512h` = first 32 bytes of SHA-512. This matches the XRPL Hooks C
   API's `util_sha512h`.

2. **Sort**: sort all oracles ascending by `rank_hash` (treating the 32 bytes as
   a big-endian 256-bit integer).

3. **Selection**: take the first K entries from the sorted list.

4. **Commitment**: the regulator submits a `COMMIT_COMMITTEE` payment to its own
   account. The registry hook writes the ordered pubkeys in chunks of ≤4 into
   namespace state, keyed by:
   ```
   committee_chunk_key(period_seq, chunk) =
       sha512h("COMMITTEE" || u32be(period_seq) || u8(chunk))
   ```

### Properties

- **Deterministic**: the same inputs always produce the same committee.
- **Verifiable**: any party can re-run the algorithm and compare with the
  on-chain commitment.
- **Period-binding**: a different period number produces a different ranking
  for the same oracle set (seeded by the period number).
- **Sybil-resistance**: oracle registration requires a signed transaction from
  the regulator; no self-registration.

---

## Binary Proof Blob Layout

The proof blob is submitted as the `MemoData` of a `PROOF` self-payment.

```
Byte offset  Length  Field
──────────────────────────────────────────────────────────────
0            1       schema_version    (must match Hook param SCHEMA_VER)
1            4       period_seq        (u32 BE — replay protection)
5            4       ledger_ts         (u32 BE — ledger seq of LOCK tx, replay protection)
9            1       vote_count        (number of VoteEntry records, 1 ≤ vote_count ≤ K)
10           N×97    vote_entries      (VoteEntry[vote_count], see below)
──────────────────────────────────────────────────────────────
Minimum:     10 + 1×97 = 107 bytes
Maximum K=16: 10 + 16×97 = 1562 bytes
```

### VoteEntry (97 bytes each)

```
Byte offset  Length  Field
──────────────────────────────────────────────────────────────
0            32      oracle_pubkey    (ed25519 pubkey, no XRPL "ED" prefix)
32           1       vote             (0x01 = compliant, 0x00 = non-compliant)
33           64      signature        (ed25519 signature over the oracle payload)
──────────────────────────────────────────────────────────────
```

### Oracle Canonical Signed Payload (29 bytes)

Each oracle signs this payload with its Ed25519 private key:

```
Byte offset  Length  Field
──────────────────────────────────────────────────────────────
0            4       period_seq         (u32 BE)
4            20      company_account_id (20-byte XRPL AccountID)
24           1       vote               (0x01 or 0x00)
25           4       ledger_ts          (u32 BE — ledger seq of LOCK tx)
──────────────────────────────────────────────────────────────
Total:       29 bytes
```

The `ledger_ts` field is the ledger sequence of the period-opening LOCK
transaction. The compliance hook stores this as `PERIOD_LEDGER` and rejects any
proof where the embedded `ledger_ts` does not match, preventing replay attacks
across periods.

---

## Hook Parameters

### compliance_hook.c (SetHook HookParameters on company account)

| HookParameterName | Bytes | Description |
|---|---|---|
| `REGULATOR`   | 20 | Regulator's 20-byte AccountID — used in `state_foreign()` reads and as destination for reputation-update emissions |
| `CONTRACTOR`  | 20 | Contractor's 20-byte AccountID — payment destination on non-compliant consensus |
| `SCHEMA_VER`  | 1  | Expected proof blob schema version (= 1); Hook rejects mismatches |
| `M_THRESHOLD` | 1  | Minimum votes on one side required for consensus |
| `K_COMMITTEE` | 1  | Committee size; Hook reads exactly K pubkeys from regulator namespace |
| `COLLAT_DROPS`| 8  | Expected collateral in drops (u64 BE); Hook rejects LOCK payments with wrong amount |

HookParameterName encoding: raw ASCII bytes hex-encoded (e.g. `"REGULATOR"` →
`"524547554C41544F52"`).

### registry_hook.c (SetHook HookParameters on regulator account)

| HookParameterName | Bytes | Description |
|---|---|---|
| `REGULATOR` | 20 | Regulator's 20-byte AccountID — only this account may submit REGISTER_ORACLE and COMMIT_COMMITTEE transactions |

---

## Namespace State Keys

### Registry Hook namespace (regulator account)

| Key (32 bytes) | Value | Description |
|---|---|---|
| `pubkey[0..31]` | `u32be(timestamp) \|\| i32be(reputation)` = 8 bytes | One entry per registered oracle; key is the 32-byte ed25519 pubkey verbatim |
| `sha512h("COMMITTEE" \|\| u32be(seq) \|\| u8(chunk))` | Up to 4 × 32 = 128 bytes | Committee chunk for a period. Chunk 0 = members 0–3, chunk 1 = members 4–7, etc. |
| `sha512h("TEMPLATE")` | 79-byte TemplateRecord binary | Active compliance template |

### Compliance Hook namespace (company account)

| Key (32 bytes) | Value | Description |
|---|---|---|
| `"COLLATERAL_DROPS" + zeros` | u64 BE (8 bytes) | Locked collateral in drops |
| `"PERIOD_SEQ" + zeros`       | u32 BE (4 bytes) | Current period sequence number |
| `"PERIOD_LEDGER" + zeros`    | u32 BE (4 bytes) | Ledger sequence of the LOCK transaction (replay protection) |
| `"PERIOD_STATUS" + zeros`    | u8 (1 byte): 0=inactive 1=active 2=finalized | State machine for the current period |

All compliance hook keys are right-zero-padded ASCII strings to exactly 32 bytes.

---

## Cross-Account Namespace: Reads vs. Writes

`state_foreign()` in the XRPL Hooks C API allows a Hook to **read** another
account's Hook namespace without any additional permission. The compliance hook
uses this to read the committee committed by the registry hook.

**Cross-account writes are not supported.** A Hook can only write (`state_set`)
to its own account's namespace. Therefore, reputation score updates from the
compliance hook are implemented as **emitted Payment transactions** sent to the
regulator account with memo type `"REPU"`. The registry hook fires on these
emitted payments and updates the relevant reputation scores.

### Security consideration for REPU transactions

The registry hook verifies that REPU transactions carry an `sfEmitDetails`
field (present only on Hook-emitted transactions; regular user-submitted
transactions cannot set this field). This prevents a malicious actor from
submitting forged reputation updates.

Note that the registry hook cannot currently verify *which* hook emitted the
REPU transaction without knowing the compliance hook's hash at install time.
A future version should include the compliance hook hash in the registry hook
parameters and verify it against `sfEmitDetails.sfEmitHookHash`.

---

## Hooks Testnet Limitations and Workarounds

### 1. `account_namespace` RPC method

The standard XRPL `account_objects` method does not expose Hook namespace state.
The xahaud-specific `account_namespace` RPC is required. All TypeScript code in
`src/oracle-registry.ts` and `src/committee.ts` uses this method.

**Workaround**: the `client.request()` method is cast to `unknown` to bypass
xrpl.js's typed request schema, since `account_namespace` is not in the xrpl.js
type definitions as of v4.x.

### 2. `HookStateSet` transaction type

The `HookStateSet` transaction (used in `src/regulator.ts::publishTemplate`) is
a Hooks-amendment-specific transaction not present in the xrpl.js v4 type
definitions. It is cast to `unknown` before passing to `client.autofill()`.

### 3. SetHook / HookApiVersion

The `SetHook` transaction and its `Flags` field (`hsfOVERRIDE = 1`) are
Hook-amendment-specific. `HookApiVersion: 0` targets the Hooks v3 API available
on the xahaud testnet.

### 4. Self-payment amount validation

On standard XRPL, self-payments of amounts other than the minimum fee are
valid but unusual. The compliance hook validates the payment amount against
the `COLLAT_DROPS` parameter only for LOCK transactions. PROOF self-payments
use 1 drop (the minimum) since no real fund transfer occurs — the collateral
is returned via a Hook-emitted transaction.

### 5. Emitted transaction fee budget

Each Hook execution has a maximum emitted-transaction fee budget determined by
the emitting transaction's fee. The LOCK and PROOF transactions should be
submitted with a fee of at least `base_fee × (1 + emission_count × emission_fee_multiplier)`.
The TypeScript client relies on `client.autofill()` to calculate this. If
emissions fail due to insufficient fee, increase the fee on the PROOF transaction.

### 6. Memo size limit

XRPL transactions have a practical memo size limit (~1KB per memo). With K=16
committee members, the proof blob is at most 10 + 16×97 = 1562 bytes, which may
exceed this limit on some nodes. Recommended: keep K ≤ 10 (blob ≤ 980 bytes).

---

## Role Renaming

| Old name | New name |
|---|---|
| Operator | Company |
| Regulator | Regulator (same) |
| Contractor | Contractor (same) |
| 5 fixed oracles | N registered oracles, K selected per period |
