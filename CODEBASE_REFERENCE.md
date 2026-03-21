# NuclearEscrow Codebase Reference

A complete function-level reference for every module in this repository.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [shared/src/types.ts](#sharedsrctypests) — Core TypeScript interfaces
3. [shared/src/index.ts](#sharedsrcindexts) — Borsh serialization utilities
4. [oracle/src/sensor-simulator.ts](#oraclesrcsensor-simulatorts) — Radiation sensor simulation
5. [oracle/src/attestation.ts](#oraclesrcattestationts) — Oracle signing & verification
6. [oracle/src/quorum-aggregator.ts](#oraclesrcquorum-aggregatorts) — Quorum aggregation
7. [contracts/src/config.ts](#contractssrcconfigts) — Configuration & wallet loading
8. [contracts/src/domain-setup.ts](#contractssrcdomain-setupts) — XRPL Permissioned Domain
9. [contracts/src/credential-issuer.ts](#contractssrccredential-issuerts) — Credential management
10. [contracts/src/escrow-create.ts](#contractssrcescrow-creates) — Master escrow creation
11. [contracts/src/escrow-finish.ts](#contractssrcescrow-finishts) — Escrow completion
12. [contracts/src/child-escrow-spawn.ts](#contractssrcchild-escrow-spawnts) — Child escrow spawning
13. [contracts/src/mpt-receipt.ts](#contractssrcmpt-receiptts) — MPT milestone receipts
14. [contracts/src/setup-wallets.ts](#contractssrcsetup-walletsts) — Wallet provisioning
15. [cli/init.ts](#cliinitts) — Facility initialization CLI
16. [cli/submit-milestone.ts](#clisubmit-milestonets) — Milestone submission CLI
17. [cli/inspect.ts](#cliinspectts) — On-chain state inspector CLI
18. [cli/recover-spawn.ts](#clirecover-spawnts) — Child escrow recovery CLI
19. [dashboard/server.ts](#dashboardserverts) — Express API backend
20. [dashboard/src/App.tsx](#dashboardsrcapptsx) — Root React application
21. [dashboard/src/mock-data.ts](#dashboardsrcmock-datats) — Demo mode fixtures
22. [dashboard/src/hooks/useEscrowState.ts](#dashboardsrchooksuseescrowstatets) — Escrow state hook
23. [dashboard/src/hooks/useMilestoneHistory.ts](#dashboardsrchooksusemilestonehistoryts) — Milestone history hook
24. [dashboard/src/components/SiteStatus.tsx](#dashboardsrccomponentssitestatustsx) — Site status card
25. [dashboard/src/components/EscrowBalance.tsx](#dashboardsrccomponentsescrowbalancetsx) — Balance display card
26. [dashboard/src/components/MilestoneTimeline.tsx](#dashboardsrccomponentsmilestonetimelinetsx) — Milestone timeline
27. [dashboard/src/components/OracleHealth.tsx](#dashboardsrccomponentsoraclehealthtsx) — Oracle network card
28. [dashboard/src/components/AuditFeed.tsx](#dashboardsrccomponentsauditfeedtsx) — On-chain audit feed
29. [dashboard/src/components/BankruptcyGuard.tsx](#dashboardsrccomponentsbankruptcyguardtsx) — Bankruptcy guard demo
30. [dashboard/src/components/TerminalModal.tsx](#dashboardsrccomponentsterminaltsx) — Streaming terminal modal
31. [wasm/src/lib.rs](#wasmsrclibrs) — WASM contract entry point
32. [wasm/src/state.rs](#wasmsrcstaters) — WASM state structs & tests
33. [wasm/src/crypto.rs](#wasmsrccryptors) — WASM cryptographic primitives
34. [wasm/src/checks.rs](#wasmsrcchecksrs) — WASM business logic validators

---

## Project Overview

NuclearEscrow is a nuclear decommissioning escrow system built on the XRP Ledger. It enforces a 7-phase decommissioning protocol where funds locked in on-chain escrows are released only when a quorum of independent oracles cryptographically attest that radiation sensor readings have crossed phase-specific safety thresholds. Business logic is enforced by a WebAssembly (WASM) contract embedded in each escrow's `FinishFunction`.

**Key actors:**
- **Regulator** — Issues credentials and mints MPT milestone receipts
- **Operator** — Creates and owns the escrows, submits milestone completions
- **Contractor** — Receives released funds and MPT receipts upon milestone completion
- **Oracles (×5)** — Sign sensor attestations; 3-of-5 quorum required

**Wire format:** All state is serialized using little-endian Borsh encoding. Field order is load-bearing and must not change.

---

## `shared/src/types.ts`

Canonical TypeScript type definitions for the two core on-chain data structures. These are the ground truth for the Borsh wire format used by both the TypeScript layer and the Rust WASM contract.

> **Important:** Comments in this file declare the Borsh field order. Do not reorder fields.

### Interface `SiteState`

The mutable state stored inside each escrow's `Data` field on the XRPL ledger. Encoded as 293 bytes of Borsh.

| Field | Type | Borsh type | Description |
|---|---|---|---|
| `current_milestone` | `number` | `u8` | The last completed milestone index (0 = none done) |
| `oracle_pubkeys` | `Uint8Array[]` | `5 × [u8;32]` | Ed25519 public keys of the 5 authorized oracles (160 bytes) |
| `thresholds` | `number[]` | `7 × f32` | Max allowed radiation (µSv/h) per milestone phase (28 bytes) |
| `domain_id` | `Uint8Array` | `[u8;32]` | XRPL Permissioned Domain ID (32 bytes) |
| `facility_id` | `Uint8Array` | `[u8;16]` | Facility identifier, UTF-8 zero-padded to 16 bytes |
| `milestone_timestamps` | `bigint[]` | `7 × u64` | XRPL ledger close time at which each milestone was completed (56 bytes) |

**Total: 293 bytes**

---

### Interface `MilestoneAttestation`

The payload submitted by the operator in an `EscrowFinish` transaction memo. The WASM contract reads this and validates it. Encoded as 358 bytes of Borsh.

| Field | Type | Borsh type | Description |
|---|---|---|---|
| `milestone_index` | `number` | `u8` | Which milestone (1–6) this attestation is for |
| `sensor_reading_usv` | `number` | `f32` | The radiation reading in µSv/h at time of milestone |
| `sensor_reading_hash` | `Uint8Array` | `[u8;32]` | SHA-256 hash of the full sensor batch JSON |
| `oracle_signatures` | `Uint8Array[]` | `5 × [u8;64]` | Ed25519 signatures from oracles; absent oracles are zero-padded (320 bytes) |
| `signature_bitmap` | `number` | `u8` | Bitmask where bit `i` is set if oracle `i` signed |

**Total: 358 bytes**

---

## `shared/src/index.ts`

Low-level Borsh serialization and deserialization utilities, plus helper functions for building the oracle attestation message. This module is the bridge between TypeScript business logic and the binary wire format consumed by the WASM contract.

**Dependencies:** `@noble/hashes/sha2`, `./types.ts`

---

### Class `BorshWriter` *(internal)*

A stateful byte buffer that appends values in little-endian Borsh encoding. Used internally by `encodeSiteState` and `encodeMilestoneAttestation`.

#### `writeU8(v: number): void`
Appends a single unsigned byte (masked to 8 bits) to the internal buffer.
- **Parameters:** `v` — The value to write; only the low 8 bits are used.
- **Returns:** Nothing.

#### `writeF32(v: number): void`
Appends a 32-bit little-endian IEEE 754 float. Uses a `DataView` to guarantee correct byte order across platforms.
- **Parameters:** `v` — A JavaScript `number` interpreted as a 32-bit float.
- **Returns:** Nothing.

#### `writeU64(v: bigint): void`
Appends a 64-bit little-endian unsigned integer. Requires a `bigint` because JavaScript's `number` cannot represent 64-bit integers precisely.
- **Parameters:** `v` — A `bigint` value.
- **Returns:** Nothing.

#### `writeFixedBytes(bytes: Uint8Array, expectedLen: number): void`
Appends exactly `expectedLen` bytes from `bytes`. Throws if the lengths do not match, acting as a guard against accidental truncation or padding of fixed-size fields.
- **Parameters:**
  - `bytes` — The byte array to append.
  - `expectedLen` — The required length; if `bytes.length !== expectedLen`, throws.
- **Returns:** Nothing.
- **Throws:** `Error` if `bytes.length !== expectedLen`.

#### `toBuffer(): Buffer`
Returns the accumulated bytes as a Node.js `Buffer`.
- **Returns:** `Buffer` containing all bytes written so far.

---

### Class `BorshReader` *(internal)*

A stateful cursor over a `Buffer` that reads values in little-endian Borsh order. Tracks an internal `offset` that advances with each read. Used internally by `decodeSiteState`.

#### `readU8(): number`
Reads one byte at the current offset and advances it by 1.
- **Returns:** `number` (0–255).

#### `readF32(): number`
Reads a 4-byte little-endian float at the current offset and advances it by 4.
- **Returns:** `number`.

#### `readU64(): bigint`
Reads an 8-byte little-endian unsigned integer and advances the offset by 8.
- **Returns:** `bigint`.

#### `readFixedBytes(len: number): Uint8Array`
Reads exactly `len` bytes and advances the offset by `len`.
- **Parameters:** `len` — Number of bytes to read.
- **Returns:** `Uint8Array` slice (shares underlying memory with the source buffer).

---

### `encodeSiteState(s: SiteState): Buffer`

Serializes a `SiteState` object into its canonical 293-byte Borsh representation. Field order is fixed and must match the Rust `SiteState` struct definition exactly.

**Encoding order:**
1. `current_milestone` — 1 byte (u8)
2. `oracle_pubkeys` — 5 × 32 bytes (requires exactly 5 entries)
3. `thresholds` — 7 × 4 bytes (requires exactly 7 entries, written as little-endian f32)
4. `domain_id` — 32 bytes
5. `facility_id` — 16 bytes
6. `milestone_timestamps` — 7 × 8 bytes (requires exactly 7 entries, written as little-endian u64)

- **Parameters:** `s` — A fully-populated `SiteState` object.
- **Returns:** `Buffer` of exactly 293 bytes.
- **Throws:** `Error` if `oracle_pubkeys.length !== 5`, `thresholds.length !== 7`, or `milestone_timestamps.length !== 7`.

---

### `decodeSiteState(b: Buffer): SiteState`

The inverse of `encodeSiteState`. Parses a 293-byte Borsh buffer into a `SiteState` object.

**Note:** The decoded `milestone_timestamps` field is an array of `bigint`. The dashboard's local `decodeSiteState` (in `useEscrowState.ts`) converts these to `number` to avoid React serialization issues.

- **Parameters:** `b` — A `Buffer` of at least 293 bytes in Borsh-encoded `SiteState` format.
- **Returns:** A `SiteState` object.

---

### `encodeMilestoneAttestation(a: MilestoneAttestation): Buffer`

Serializes a `MilestoneAttestation` into its canonical 358-byte Borsh representation. This is the binary payload placed in the `Attestation` memo of an `EscrowFinish` transaction.

**Encoding order:**
1. `milestone_index` — 1 byte (u8)
2. `sensor_reading_usv` — 4 bytes (f32)
3. `sensor_reading_hash` — 32 bytes
4. `oracle_signatures` — 5 × 64 bytes (requires exactly 5 entries; absent oracles must be zero-padded by the caller)
5. `signature_bitmap` — 1 byte (u8)

- **Parameters:** `a` — A `MilestoneAttestation` object.
- **Returns:** `Buffer` of exactly 358 bytes.
- **Throws:** `Error` if `oracle_signatures.length !== 5`.

---

### `facilityIdToBytes(id: string): Uint8Array`

Converts a human-readable facility identifier string (e.g., `"PLANT-FR-001"`) to the fixed 16-byte binary representation used in both `SiteState` and the attestation message.

**Algorithm:** UTF-8 encode the string, zero-pad to 16 bytes. For `"PLANT-FR-001"` (12 bytes), bytes 12–15 will be `0x00`.

- **Parameters:** `id` — A facility identifier string. Must encode to ≤16 bytes in UTF-8.
- **Returns:** `Uint8Array` of exactly 16 bytes.
- **Throws:** `Error` if the UTF-8 encoding exceeds 16 bytes.
- **Note:** Used by both `encodeSiteState` (via `escrow-create.ts`) and `buildAttestationMsg`.

---

### `buildAttestationMsg(milestoneIndex: number, sensorHash: Uint8Array, facilityId: string): Uint8Array`

Constructs the 32-byte message that oracles sign and the WASM contract verifies. This is the canonical message format shared between TypeScript (signing) and Rust (verification).

**Algorithm:**
1. Build a 49-byte input: `[milestoneIndex_byte(1)] ++ sensorHash[32] ++ facilityIdBytes[16]`
2. Return `sha256(input)`

- **Parameters:**
  - `milestoneIndex` — The phase index (0–6); only the low 8 bits are used.
  - `sensorHash` — SHA-256 hash of the serialized sensor batch. Must be exactly 32 bytes.
  - `facilityId` — The facility identifier string (e.g., `"PLANT-FR-001"`).
- **Returns:** `Uint8Array` of 32 bytes (SHA-256 digest).
- **Throws:** `Error` if `sensorHash.length !== 32`.
- **Test vector:** For `milestoneIndex=1`, `sensorHash=sha256("mock-sensor-batch-001")`, `facilityId="PLANT-FR-001"`, the expected output is `11f3e63da67de7dbcd55946bcf995d0b72171f88bfa1f2b0f57a76f128c282af`.

---

## `oracle/src/sensor-simulator.ts`

Simulates the radiation sensor readings that would come from physical dosimeters at a real nuclear decommissioning site. Used in the CLI and tests to generate deterministic sensor batches for each decommissioning phase.

**Dependencies:** `@noble/hashes/sha2`

---

### Interface `SensorBatch`

A snapshot of sensor readings at a point in time.

| Field | Type | Description |
|---|---|---|
| `readings` | `number[]` | 10 individual sensor readings around the phase baseline |
| `median` | `number` | The exact baseline value for this phase (used as the "official" reading) |
| `timestamp` | `number` | `Date.now()` at the time of sampling |
| `phase` | `number` | Current decommissioning phase (0–6) |

---

### Constant `PHASE_THRESHOLDS`

`[100.0, 10.0, 1.0, 0.5, 0.1, 0.1, 0.01]` µSv/h — the maximum allowed radiation reading for each phase (indexed 0–6). These values mirror the default thresholds set at escrow creation.

---

### Class `SensorSimulator`

Manages the simulated phase state and generates deterministic sensor batches.

#### `constructor(facilityId: string)`
Creates a new simulator starting at phase 0 for the given facility.
- **Parameters:** `facilityId` — The facility identifier string (stored but not currently used in calculations).

#### `getCurrentBatch(): SensorBatch`
Generates a `SensorBatch` for the current phase. Uses a deterministic jitter formula (`±2%` based on a linear congruential sequence `(i*7+3) % 11`) so the same phase always produces the same 10 readings. The median is always the exact base reading for the phase (never jittered).

**Base readings per phase:**
- Phase 0: 82.0 µSv/h, Phase 1: 7.5, Phase 2: 0.75, Phase 3: 0.3, Phase 4: 0.08, Phase 5: 0.08, Phase 6: 0.005

- **Returns:** `SensorBatch` with 10 readings, all guaranteed below the phase threshold.
- **Note:** Readings are rounded to 4 decimal places.

#### `serializeBatch(b: SensorBatch): Buffer`
Converts a `SensorBatch` to a deterministic JSON `Buffer`. Keys are sorted alphabetically (`median`, `phase`, `readings`, `timestamp`) to ensure a consistent byte representation regardless of insertion order.
- **Parameters:** `b` — A `SensorBatch` object.
- **Returns:** `Buffer` containing the JSON string.
- **Important:** This serialization is the input to `hashBatch`. Any change in key order or value format would break existing attestation hashes.

#### `hashBatch(b: SensorBatch): Uint8Array`
Computes the SHA-256 hash of the serialized batch. This hash is what oracles actually sign, committing to all sensor values, the timestamp, and the phase number.
- **Parameters:** `b` — A `SensorBatch` object.
- **Returns:** `Uint8Array` of 32 bytes (SHA-256 digest of the JSON serialization).

#### `advancePhase(): void`
Increments the internal phase counter by 1, up to a maximum of 6. Does nothing if already at phase 6.
- **Returns:** Nothing.

#### `getPhase(): number`
Returns the current phase index.
- **Returns:** `number` in range [0, 6].

---

## `oracle/src/attestation.ts`

Implements the oracle signing and verification protocol. Each oracle independently signs the attestation message (a SHA-256 digest binding the milestone index, sensor hash, and facility ID) using its Ed25519 private key.

**Dependencies:** `@noble/curves/ed25519`, `@noble/hashes/sha2`

---

### `facilityIdToBytes(id: string): Uint8Array` *(internal)*

Identical to the function of the same name in `shared/src/index.ts`. UTF-8 encodes the string and zero-pads to 16 bytes. Duplicated here to keep the oracle module self-contained.

---

### `buildAttestationMsg(milestoneIndex: number, sensorReadingHash: Uint8Array, facilityId: string): Uint8Array`

Constructs the 32-byte message for signing. Identical algorithm to `shared/src/index.ts::buildAttestationMsg`. Produces `sha256([milestoneIndex_byte] ++ sensorReadingHash[32] ++ facilityIdBytes[16])`.

- **Parameters:**
  - `milestoneIndex` — Phase index; low 8 bits used.
  - `sensorReadingHash` — SHA-256 of the sensor batch. Must be exactly 32 bytes.
  - `facilityId` — Facility identifier string.
- **Returns:** `Uint8Array` of 32 bytes.
- **Throws:** `Error` if `sensorReadingHash.length !== 32`.

---

### `signAttestation(privateKey: Uint8Array, milestoneIndex: number, sensorReadingHash: Uint8Array, facilityId: string): Uint8Array`

Signs the attestation message using an oracle's Ed25519 private key.

**Algorithm:**
1. Call `buildAttestationMsg(milestoneIndex, sensorReadingHash, facilityId)` → 32-byte message
2. Sign the message with `ed25519.sign(msg, privateKey)` using the `@noble/curves` library

- **Parameters:**
  - `privateKey` — 32-byte Ed25519 raw private key (XRPL format: strip the `"ED"` prefix from the wallet's hex public key to get the private key portion).
  - `milestoneIndex` — Phase index.
  - `sensorReadingHash` — 32-byte sensor batch hash.
  - `facilityId` — Facility identifier string.
- **Returns:** `Uint8Array` of 64 bytes (Ed25519 signature).
- **Note:** This function is called by the `QuorumAggregator` during milestone submission, once per oracle.

---

### `verifyAttestation(publicKey: Uint8Array, sig: Uint8Array, milestoneIndex: number, sensorReadingHash: Uint8Array, facilityId: string): boolean`

Verifies an Ed25519 signature against the expected attestation message. Used internally by `QuorumAggregator.add()` to reject invalid signatures before they enter the aggregation.

**Algorithm:**
1. Reconstruct the message via `buildAttestationMsg`
2. Call `ed25519.verify(sig, msg, publicKey)`
3. Return `false` on any exception (malformed key/signature)

- **Parameters:**
  - `publicKey` — 32-byte Ed25519 raw public key.
  - `sig` — 64-byte Ed25519 signature.
  - `milestoneIndex`, `sensorReadingHash`, `facilityId` — Attestation parameters to reconstruct the message.
- **Returns:** `true` if the signature is valid; `false` otherwise (catches all exceptions).

---

## `oracle/src/quorum-aggregator.ts`

Collects signatures from multiple oracles, verifies each one independently, and builds the final `MilestoneAttestation` struct when quorum is reached.

**Dependencies:** `@noble/curves/ed25519`, `@noble/hashes/sha2`, `./attestation.ts`, `../../shared/src/types.ts`

---

### Class `QuorumAggregator`

Accumulates verified oracle signatures. Maintains two internal `Map`s: `sigs` (oracle index → 64-byte signature) and `pubkeys` (oracle index → 32-byte public key). Only holds signatures that have been successfully verified.

#### `add(oracleIndex: number, sig: Uint8Array, pubkey: Uint8Array, milestoneIndex: number, sensorHash: Uint8Array, facilityId: string): void`

Attempts to add an oracle's signature to the aggregation. Silently ignores invalid signatures rather than throwing. This is by design: in a real system, a faulty or malicious oracle should not halt the process.

**Algorithm:**
1. Call `verifyAttestation(pubkey, sig, milestoneIndex, sensorHash, facilityId)`.
2. If verification fails, return without storing anything.
3. If valid, store `sig` in `this.sigs.set(oracleIndex, sig)` and `pubkey` in `this.pubkeys.set(oracleIndex, pubkey)`.

- **Parameters:**
  - `oracleIndex` — Which oracle slot (0–4) this signature belongs to. Must match the index in `SiteState.oracle_pubkeys`.
  - `sig` — 64-byte Ed25519 signature.
  - `pubkey` — 32-byte Ed25519 public key.
  - `milestoneIndex`, `sensorHash`, `facilityId` — Used to reconstruct the message for verification.
- **Returns:** Nothing.
- **Side effects:** May update `this.sigs` and `this.pubkeys`.

#### `hasQuorum(): boolean`

Returns whether at least 3 valid signatures have been collected.

- **Returns:** `true` if `this.sigs.size >= 3`.
- **Note:** Call before `buildAttestation` to ensure the resulting struct is valid. The WASM contract will reject any attestation with fewer than 3 valid signatures.

#### `buildAttestation(milestoneIndex: number, sensorReadingUsv: number, sensorReadingHash: Uint8Array): MilestoneAttestation`

Constructs the `MilestoneAttestation` struct from all accumulated signatures. Oracle slots without a valid signature are zero-padded (as required by the Borsh encoding spec). The `signature_bitmap` field is computed as a bitmask where bit `i` is set if oracle `i` contributed a valid signature.

**Algorithm:**
1. Iterate oracle indices 0–4.
2. For each index `i`: if `this.sigs.has(i)`, push the 64-byte signature and set bit `i` in `signature_bitmap`. Otherwise, push 64 zero bytes and leave bit `i` unset.
3. Construct and return the `MilestoneAttestation` object.

- **Parameters:**
  - `milestoneIndex` — The phase being attested.
  - `sensorReadingUsv` — The radiation reading value to embed (from `SensorBatch.median`).
  - `sensorReadingHash` — 32-byte hash of the sensor batch.
- **Returns:** A `MilestoneAttestation` ready for Borsh encoding.
- **Note:** Should only be called after `hasQuorum()` returns `true`.

---

## `contracts/src/config.ts`

Provides shared configuration constants and wallet loading for all contracts and CLI scripts.

**Dependencies:** `xrpl`, `fs`, `path`

---

### Constant `TESTNET_WS`

`"wss://s.altnet.rippletest.net:51233"` — The XRPL testnet WebSocket endpoint used by all XRPL client connections in the project.

---

### Constant `RLUSD_ISSUER`

`"rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"` — The genesis account used as a mock RLUSD issuer on testnet.

---

### Interface `WalletSet`

Groups all eight project wallets into a single typed object:

| Field | Type | Description |
|---|---|---|
| `regulator` | `Wallet` | Issues credentials, mints MPT receipts |
| `operator` | `Wallet` | Creates escrows, submits milestones |
| `contractor` | `Wallet` | Receives released funds and MPT receipts |
| `oracles` | `Wallet[]` | Array of 5 oracle wallets |

---

### `loadWallets(): WalletSet`

Reads `.env.testnet` from the repository root, parses its `KEY=VALUE` lines, and constructs Ed25519 `Wallet` objects from each account's seed.

**Algorithm:**
1. Resolve `.env.testnet` relative to the module directory.
2. Read and parse the file line by line using a regex `/^([A-Z_0-9]+)=(.+)$/`.
3. Construct `regulator`, `operator`, and `contractor` wallets from their `_SEED` environment variables.
4. Construct 5 oracle wallets from `ORACLE0_SEED` through `ORACLE4_SEED`.
5. Return all as a `WalletSet`.

- **Returns:** `WalletSet` with all 8 wallets.
- **Throws:** If `.env.testnet` does not exist or any seed is missing, the XRPL `Wallet.fromSeed` call will throw.
- **Note:** All wallets use the `ed25519` algorithm explicitly, matching the format expected by the WASM contract.

---

## `contracts/src/domain-setup.ts`

Creates the XRPL Permissioned Domain that gates access to the escrow system.

**Dependencies:** `xrpl`

---

### `toHex(str: string): string` *(internal)*

Converts a plain UTF-8 string to uppercase hex, as required by XRPL transaction fields like `CredentialType`.
- **Parameters:** `str` — The string to encode.
- **Returns:** Uppercase hex string.

---

### `createDomain(regulatorWallet: Wallet, client: Client): Promise<string>`

Creates a `PermissionedDomain` on the XRPL ledger. The domain specifies which credential types (issued by the regulator) are required to participate in the escrow system.

**Accepted credentials (all issued by the regulator):**
- `OperatingLicense` — Required for the operator
- `ContractorCert` — Required for the contractor
- `OracleNode` — Required for each oracle

**Algorithm:**
1. Construct and autofill a `PermissionedDomainSet` transaction.
2. Sign and submit it with `client.submitAndWait`.
3. On `tesSUCCESS`, extract the `LedgerIndex` of the newly created `PermissionedDomain` ledger object from the transaction metadata.
4. Return the domain ID (a 64-character hex string).

- **Parameters:**
  - `regulatorWallet` — The wallet signing the transaction.
  - `client` — An active XRPL `Client` connection.
- **Returns:** `Promise<string>` — The domain ID (hex-encoded `LedgerIndex`).
- **Throws:** `Error` if the transaction fails or the domain ID cannot be extracted from metadata.
- **Side effects:** Creates a `PermissionedDomain` ledger entry. Logs the domain ID.

---

## `contracts/src/credential-issuer.ts`

Manages the lifecycle of XRPL credentials (issuance and revocation). Credentials are on-chain attestations by the regulator that a given address is authorized to participate in the escrow system.

**Dependencies:** `xrpl`

---

### `toHex(str: string): string` *(internal)*

Identical to the function in `domain-setup.ts`. Converts a UTF-8 string to uppercase hex for XRPL `CredentialType` fields.

---

### `createCredential(regulatorWallet, subjectAddress, credentialType, credentialData, client): Promise<string>` *(internal)*

Generic credential issuance function. Handles the case where a credential already exists (`tecDUPLICATE`) by looking up the existing credential on-ledger instead of failing.

**Algorithm:**
1. Build a `CredentialCreate` transaction with `Subject`, `CredentialType` (hex), and optionally `URI` (hex-encoded credential data blob).
2. Autofill, sign, and submit.
3. If result is `tecDUPLICATE`: fetch the existing credential via `ledger_entry` and return its index.
4. If result is `tesSUCCESS`: extract the `LedgerIndex` from the `CreatedNode` in metadata.
5. Return the credential ID.

- **Parameters:**
  - `regulatorWallet` — The issuer wallet.
  - `subjectAddress` — XRPL address of the credential recipient.
  - `credentialType` — Human-readable credential type string (e.g., `"OperatingLicense"`).
  - `credentialData` — Optional JSON string to embed in the `URI` field. Pass `undefined` to omit.
  - `client` — Active XRPL client.
- **Returns:** `Promise<string>` — The credential's ledger entry ID.
- **Throws:** `Error` if the transaction fails with any result other than `tesSUCCESS` or `tecDUPLICATE`.

---

### `issueOperatingLicense(regulatorWallet, operatorAddress, meta, client): Promise<string>`

Issues an `OperatingLicense` credential to the operator. The credential data blob is a JSON object recording the facility ID, RLUSD liability amount, and jurisdiction.

- **Parameters:**
  - `regulatorWallet` — The regulator wallet (issuer).
  - `operatorAddress` — The operator's XRPL address.
  - `meta` — Object with fields: `facility_id` (string), `liability_rlusd` (string), `jurisdiction` (optional string).
  - `client` — Active XRPL client.
- **Returns:** `Promise<string>` — Credential ledger entry ID.
- **Side effects:** Logs the credential ID. Calls `createCredential` internally.

---

### `issueContractorCert(regulatorWallet, contractorAddress, client): Promise<string>`

Issues a `ContractorCert` credential to the contractor. This credential carries no data blob.

- **Parameters:**
  - `regulatorWallet` — The regulator wallet.
  - `contractorAddress` — The contractor's XRPL address.
  - `client` — Active XRPL client.
- **Returns:** `Promise<string>` — Credential ledger entry ID.
- **Side effects:** Logs the credential ID.

---

### `issueOracleNode(regulatorWallet, oracleAddress, oraclePubkeyHex, client): Promise<string>`

Issues an `OracleNode` credential to an oracle wallet. The credential data blob is a JSON object containing the oracle's Ed25519 public key in hex.

- **Parameters:**
  - `regulatorWallet` — The regulator wallet.
  - `oracleAddress` — The oracle's XRPL address.
  - `oraclePubkeyHex` — The oracle's full public key in XRPL format (`"ED"` prefix + 64 hex chars).
  - `client` — Active XRPL client.
- **Returns:** `Promise<string>` — Credential ledger entry ID.
- **Side effects:** Logs the credential ID.

---

### `revokeCredential(regulatorWallet, subjectAddress, credentialType, client): Promise<void>`

Deletes an existing credential from the ledger using a `CredentialDelete` transaction. This can be used to revoke an operator's license or remove a compromised oracle.

- **Parameters:**
  - `regulatorWallet` — The issuer (must be the same account that issued the credential).
  - `subjectAddress` — The XRPL address whose credential is being revoked.
  - `credentialType` — Human-readable credential type (e.g., `"OracleNode"`).
  - `client` — Active XRPL client.
- **Returns:** `Promise<void>`.
- **Throws:** `Error` if the `CredentialDelete` transaction fails.
- **Side effects:** Logs the revocation.

---

## `contracts/src/escrow-create.ts`

Creates the master escrow that locks the facility's RLUSD liability on-chain. This is the central on-chain artifact of the entire system.

**Dependencies:** `xrpl`, `fs`, `crypto`, `../../shared/src/index.ts`

---

### Interface `EscrowConfig`

Configuration object required to create the master escrow:

| Field | Type | Description |
|---|---|---|
| `facilityId` | `string` | Facility identifier (e.g., `"PLANT-FR-001"`) |
| `liabilityRlusd` | `string` | RLUSD liability amount stored as string in memos |
| `oraclePubkeys` | `string[]` | 5 oracle public keys in XRPL format (`"ED"` + 64 hex chars) |
| `thresholds` | `number[]` | 7 radiation thresholds in µSv/h |
| `domainId` | `string` | 64-char hex Permissioned Domain ID |
| `contractorAddress` | `string` | XRPL address that will receive released funds |

---

### `toMemoHex(str: string): string` *(internal)*

Converts a UTF-8 string to uppercase hex for XRPL memo type fields.

---

### `toRippleTime(unixSeconds: number): number` *(internal)*

Converts a Unix timestamp (seconds) to XRPL Ripple epoch time by subtracting the XRPL epoch offset (946684800 seconds = 2000-01-01 00:00:00 UTC).

- **Parameters:** `unixSeconds` — Unix timestamp in seconds (floating point accepted).
- **Returns:** Integer XRPL ledger time.

---

### `createMasterEscrow(operatorWallet: Wallet, config: EscrowConfig, client: Client): Promise<number>`

Creates the master `EscrowCreate` transaction on the XRPL testnet. This escrow holds a small demo XRP collateral (1 XRP / 1,000,000 drops) with the real RLUSD liability recorded in memos. The WASM contract and full `SiteState` are embedded in transaction memos.

**Algorithm:**
1. Read `contracts/wasm/finish.wasm` from disk, compute its SHA-256 hash, and hex-encode both.
2. Build the `SiteState` struct:
   - Strip the `"ED"` prefix from each oracle public key to get the raw 32-byte Ed25519 key.
   - Decode the 64-char hex `domainId` into a 32-byte array (throws if length is wrong).
   - Encode `facilityId` to 16-byte zero-padded UTF-8.
   - Set `current_milestone = 0`, all `milestone_timestamps = 0`.
3. Encode the `SiteState` to 293-byte Borsh hex.
4. Compute `FinishAfter` = now + 30 seconds, `CancelAfter` = now + 80 years (both in Ripple time).
5. Construct the `EscrowCreate` transaction with:
   - `Amount = "1000000"` (1 XRP demo collateral)
   - `Destination = contractorAddress`
   - Four memos: `FinishFunctionHash` (WASM SHA-256), `SiteState` (Borsh hex), `DomainId`, `LiabilityRlusd`
6. Autofill, sign, and submit with `client.submitAndWait`.
7. On success, extract and return the transaction `Sequence` number (used later as the escrow identifier).

- **Parameters:**
  - `operatorWallet` — Signs and pays for the transaction.
  - `config` — Full escrow configuration.
  - `client` — Active XRPL client.
- **Returns:** `Promise<number>` — The escrow's `Sequence` number.
- **Throws:** `Error` if WASM file is too large (>100KB hex), `domainId` is not 32 bytes, or the transaction fails.
- **Important note on collateral:** `DEMO_COLLATERAL_DROPS = '1000000'` (1 XRP). Testnet wallets receive ~100 XRP from the faucet; locking 847M RLUSD-equivalent in drops would cause `tecUNFUNDED`. The real liability is recorded in the `LiabilityRlusd` memo for auditability.

---

## `contracts/src/escrow-finish.ts`

Submits an `EscrowFinish` transaction that delivers the signed `MilestoneAttestation` to the WASM contract for validation.

**Dependencies:** `xrpl`, `../../shared/src/index.ts`

---

### Interface `FinishResult`

Return type of `finishEscrow`:

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the WASM contract returned 1 (approval) |
| `txHash` | `string` | Transaction hash (empty string on `tefPAST_SEQ` exhaust) |
| `reason` | `string?` | Error message if `success` is false |

---

### Constants *(internal)*

- `MAX_RETRIES = 3` — How many times to retry a `tefPAST_SEQ` error before giving up.
- `LAST_LEDGER_BUFFER = 12` — Added to the autofilled `LastLedgerSequence` to give ~40 additional seconds of headroom (12 ledgers × ~3.3s/ledger). Without this buffer, `tefPAST_SEQ` errors were common on slow testnet connections.

---

### `finishEscrow(submitter: Wallet, owner: string, sequence: number, attestation: MilestoneAttestation, client: Client): Promise<FinishResult>`

Submits an `EscrowFinish` transaction with the Borsh-encoded `MilestoneAttestation` embedded as a memo. Retries up to 3 times if a `tefPAST_SEQ` error occurs (which means the transaction window expired before confirmation).

**Algorithm:**
1. Borsh-encode the `attestation` to 358 bytes.
2. Build the `EscrowFinish` transaction with `Owner`, `OfferSequence`, and an `Attestation` memo.
3. Loop up to `MAX_RETRIES` times:
   a. Autofill the transaction.
   b. Increase `LastLedgerSequence` by `LAST_LEDGER_BUFFER`.
   c. Sign and submit with `client.submitAndWait`.
   d. If `tesSUCCESS`: return `{ success: true, txHash }`.
   e. If any result other than `tefPAST_SEQ`: return `{ success: false, txHash, reason }`.
   f. If `tefPAST_SEQ` (or exception containing that text): record error, continue to next attempt.
4. After exhausting retries, return `{ success: false, txHash: '', reason: ... }`.

- **Parameters:**
  - `submitter` — The wallet signing and paying for the transaction (operator).
  - `owner` — XRPL address of the escrow owner (same as operator).
  - `sequence` — The escrow's sequence number (identifies which escrow to finish).
  - `attestation` — The `MilestoneAttestation` to submit.
  - `client` — Active XRPL client.
- **Returns:** `Promise<FinishResult>`.
- **Note:** A `success: true` result means the XRPL network accepted the transaction AND the WASM contract's `finish()` function returned 1. A `success: false` result with an XRPL error code means network rejection; with `"WASM returned 0"` means contract rejection.

---

## `contracts/src/child-escrow-spawn.ts`

After milestone M0 (Reactor Shutdown) completes, spawns 6 child escrows — one for each remaining phase — each holding the proportional RLUSD allocation for that phase.

**Dependencies:** `xrpl`, `fs`, `crypto`, `../../shared/src/index.ts`

---

### Constants *(internal)*

- `MILESTONE_FUND_PCT = [0, 15, 20, 20, 20, 20, 5]` — Fund allocation percentages per phase. M0 releases nothing (triggers spawn only). M1–M5 release 15–20% each. M6 releases 5% plus accumulated yield.
- `MILESTONE_THRESHOLDS = [100, 10, 1.0, 0.5, 0.1, 0.1, 0.01]` — Radiation thresholds per phase, embedded in each child escrow's `SiteState`.
- `DEMO_CHILD_COLLATERAL_DROPS = 100000` — 0.1 XRP per child escrow (demo testnet constraint).
- `MAX_RETRIES = 3` — Per-escrow retry limit for transient failures.

---

### Interface `ChildEscrowConfig`

Configuration for spawning child escrows (a subset of `EscrowConfig`):

| Field | Type | Description |
|---|---|---|
| `facilityId` | `string` | Facility identifier |
| `oraclePubkeys` | `string[]` | 5 oracle public keys (XRPL format) |
| `domainId` | `string` | 64-char hex Permissioned Domain ID |
| `contractorAddress` | `string` | XRPL address to receive released funds |

---

### `toMemoHex(str: string): string` *(internal)*

Same as in `escrow-create.ts`. Converts UTF-8 to uppercase hex.

---

### `toRippleTime(unixSeconds: number): number` *(internal)*

Same as in `escrow-create.ts`. Converts Unix seconds to XRPL ledger time.

---

### `spawnChildEscrows(operatorWallet: Wallet, totalRlusd: number, facilityConfig: ChildEscrowConfig, client: Client): Promise<number[]>`

Creates 6 `EscrowCreate` transactions on-chain (one per phase 1–6). Each child escrow has its own `SiteState` where `current_milestone` is set to `phase - 1` (so phase 1's escrow starts at milestone 0, requiring attestation of milestone 1 to unlock).

**Algorithm:**
1. Read `contracts/wasm/finish.wasm` and compute its SHA-256 hash (same WASM as the master escrow).
2. For each phase 1–6:
   a. Compute `rlusdAmount = floor(totalRlusd × MILESTONE_FUND_PCT[phase] / 100)`.
   b. Build a `SiteState` with `current_milestone = phase - 1`, the same oracle pubkeys, and a `FinishAfter` of now + 5 seconds.
   c. Encode and submit an `EscrowCreate` with memos: `FinishFunctionHash`, `SiteState`, `ChildPhase` (single byte), `LiabilityRlusd` (text).
   d. On success, record the transaction `Sequence`; on failure, retry up to 3 times with 3-second delays.
   e. Throw if all retries fail.
3. After all 6 escrows are created, fetch `account_objects` for the operator and verify all 6 sequence numbers appear on-chain.
4. Persist `childEscrows: [seq1, seq2, ..., seq6]` to `.nuclear-state.json`.
5. Return the array of 6 sequence numbers.

- **Parameters:**
  - `operatorWallet` — Signs all 6 `EscrowCreate` transactions.
  - `totalRlusd` — The total RLUSD liability (used to compute per-phase allocations).
  - `facilityConfig` — Facility configuration.
  - `client` — Active XRPL client.
- **Returns:** `Promise<number[]>` — Array of 6 escrow sequence numbers (index 0 = phase 1, ..., index 5 = phase 6).
- **Throws:** If any child escrow fails after 3 retries, or if any created escrow cannot be verified on-ledger.
- **Side effects:** Writes `childEscrows` array to `.nuclear-state.json`.

---

## `contracts/src/mpt-receipt.ts`

Mints a Multi-Purpose Token (MPT) milestone receipt and delivers it to the contractor as proof that a decommissioning milestone was verified and paid.

**Dependencies:** `xrpl`

---

### `toHex(str: string): string` *(internal)*

Converts a UTF-8 string to uppercase hex for XRPL memo and metadata fields.

---

### `mintMilestoneReceipt(regulatorWallet, contractorAddress, milestoneIndex, facilityId, oracleQuorumHash, sensorHash, amountRlusd, client, contractorWallet): Promise<string>`

Performs a 3-step on-chain operation to issue an MPT "DECOMM-CERT" token to the contractor for the completed milestone.

**Step 1 — `MPTokenIssuanceCreate`:**
- The regulator creates a new MPT issuance with `MaximumAmount: '1'` (non-fungible, exactly one token).
- `MPTokenMetadata` is a hex-encoded JSON object containing: ticker (`"DECOMM-CERT"`), milestone index, facility ID, oracle quorum hash (the `EscrowFinish` tx hash), sensor hash, RLUSD amount released, and timestamp.
- The `issuanceId` is computed deterministically as `BigEndian(txSequence)[4 bytes] ++ AccountID(regulator)[20 bytes]` = 48 hex characters.

**Step 2 — `MPTokenAuthorize` (contractor opt-in):**
- The contractor must explicitly authorize receipt of the MPT by signing an `MPTokenAuthorize` transaction. This is an XRPL requirement for MPTs.

**Step 3 — `Payment` (delivery):**
- The regulator sends `1` unit of the MPT to the contractor's address.

- **Parameters:**
  - `regulatorWallet` — Signs steps 1 and 3.
  - `contractorAddress` — XRPL address that receives the MPT.
  - `milestoneIndex` — Which phase (0–6) this receipt is for.
  - `facilityId` — Facility identifier string.
  - `oracleQuorumHash` — The `EscrowFinish` transaction hash (serves as the oracle quorum commitment).
  - `sensorHash` — Hex-encoded SHA-256 of the sensor batch.
  - `amountRlusd` — RLUSD amount released at this milestone (for the metadata record).
  - `client` — Active XRPL client.
  - `contractorWallet` — Signs step 2 (contractor opt-in).
- **Returns:** `Promise<string>` — The 48-character hex `issuanceId`.
- **Throws:** `Error` if any of the 3 steps fails.
- **Side effects:** Logs progress at each step.

---

## `contracts/src/setup-wallets.ts`

One-time utility script that generates and funds all 8 project wallets on the XRPL testnet and writes their credentials to `.env.testnet`.

**Usage:** `npx tsx contracts/src/setup-wallets.ts`

---

### `main(): Promise<void>` *(entry point)*

Generates and funds all 8 wallets sequentially, with a 5-second delay between each faucet request to avoid rate limiting.

**Algorithm:**
1. Connect to XRPL testnet.
2. For each name in `['regulator', 'operator', 'contractor', 'oracle0', ..., 'oracle4']`:
   a. Generate a new random Ed25519 seed.
   b. Fund it via the testnet faucet with `client.fundWallet(wallet)`.
   c. Log the address and balance.
   d. Wait 5 seconds.
3. Construct `.env.testnet` content with sections:
   - `REGULATOR_SEED`, `OPERATOR_SEED`, `CONTRACTOR_SEED`, `ORACLE0_SEED`–`ORACLE4_SEED`
   - Corresponding `_ADDRESS` entries
   - `ORACLE0_PUBKEY`–`ORACLE4_PUBKEY` (full `"ED"` + 64 hex format, stored for use in escrow creation)
4. Write to `../../.env.testnet` relative to the module.
5. Disconnect.

- **Returns:** `Promise<void>`.
- **Side effects:** Creates/overwrites `.env.testnet` with credentials for all 8 accounts.
- **Important:** `.env.testnet` is in `.gitignore` and should never be committed.

---

## `cli/init.ts`

Full facility initialization script. Orchestrates domain creation, credential issuance, and master escrow creation in the correct dependency order.

**Usage:** `npx tsx cli/init.ts --site=PLANT-FR-001 --liability=847000000`

---

### `parseArgs(): { site: string; liability: string }` *(internal)*

Parses `--site=` and `--liability=` from `process.argv`. Exits with an error message if either is missing.

- **Returns:** `{ site, liability }` as strings.

---

### `main(): Promise<void>` *(entry point)*

Full initialization flow:

1. Parse CLI args.
2. Connect to XRPL testnet.
3. Load all wallets from `.env.testnet`.
4. `createDomain(regulator, client)` → `domainId`
5. `issueOperatingLicense(regulator, operator.address, { facility_id, liability_rlusd, jurisdiction: 'FR' }, client)` → `opLicenseId`
6. `issueContractorCert(regulator, contractor.address, client)` → `contractorCertId`
7. For each of the 5 oracle wallets: `issueOracleNode(regulator, oracle.address, oracle.publicKey, client)` → `oracleCertIds`
8. `createMasterEscrow(operator, { facilityId, liabilityRlusd, oraclePubkeys, thresholds: DEFAULT_THRESHOLDS, domainId, contractorAddress }, client)` → `escrowSequence`
9. Write `.nuclear-state.json` with all IDs, addresses, and the empty `childEscrows: []` array.
10. Print a formatted summary table and the XRPL explorer URL.

**Default thresholds:** `[100.0, 10.0, 1.0, 0.5, 0.1, 0.1, 0.01]` µSv/h

- **Side effects:** Creates domain, 7 credentials, and 1 escrow on-chain. Writes `.nuclear-state.json`.

---

## `cli/submit-milestone.ts`

Submits a single milestone attestation end-to-end: simulates sensors, collects oracle signatures, builds the quorum attestation, submits to the chain, spawns child escrows (after M0), and mints an MPT receipt.

**Usage:** `npx tsx cli/submit-milestone.ts --phase=0`

---

### `parseArgs(): { phase: number }` *(internal)*

Parses `--phase=` from `process.argv`. Validates that the value is an integer between 0 and 6 inclusive.

- **Returns:** `{ phase: number }`.
- **Exits:** With error if argument is missing or out of range.

---

### `main(): Promise<void>` *(entry point)*

**Algorithm:**

1. **Parse args** — Get `phase` (0–6).
2. **Load state** — Read `.nuclear-state.json`. Exit if missing. Determine which escrow sequence to target (master for phase 0, `childEscrows[phase - 1]` for phases 1–6).
3. **Sequence guard** — If `phase !== state.current_milestone`, print a message and exit cleanly (phase already done or out of order).
4. **Load wallets** — Call `loadWallets()` to get all 8 wallets.
5. **Derive oracle keys** — Strip `"ED"` prefix from each oracle wallet's `privateKey` and `publicKey` to get raw 32-byte Uint8Arrays.
6. **Sensor simulation** — Create a `SensorSimulator`, call `advancePhase()` `phase` times to reach the target phase, then call `getCurrentBatch()` and `hashBatch(batch)`.
7. **Threshold check** — If `batch.median >= PHASE_THRESHOLDS[phase]`, exit with an error.
8. **Oracle signing** — For oracles 0, 1, 2: call `signAttestation(privateKey, phase, sensorHash, facilityId)` and `agg.add(...)`.
9. **Quorum check** — Call `agg.hasQuorum()`. Exit if less than 3.
10. **Build attestation** — Call `agg.buildAttestation(phase, batch.median, sensorHash)`.
11. **Submit** — Connect to XRPL, call `finishEscrow(operator, escrowOwner, escrowSequence, attestation, client)`.
12. **On success:**
    - Update `state.current_milestone = phase + 1` in `.nuclear-state.json`.
    - If `phase === 0`: spawn 6 child escrows via `spawnChildEscrows(...)`.
    - Mint an MPT receipt via `mintMilestoneReceipt(...)` and append the `issuanceId` to `state.milestoneReceipts`.
13. **On failure:** Print the rejection reason and exit with code 1.

- **Side effects:** Writes to `.nuclear-state.json` on success. Submits multiple on-chain transactions.

---

## `cli/inspect.ts`

Queries the XRPL ledger and prints a formatted status table for the facility: master escrow status, all child escrows, and MPT milestone receipts.

**Usage:** `npx tsx cli/inspect.ts`

---

### `checkEscrow(client: Client, owner: string, seq: number): Promise<{ exists: boolean; amount?: string }>` *(internal)*

Fetches a single escrow from the ledger using `ledger_entry`.

- **Parameters:**
  - `client` — Active XRPL client.
  - `owner` — The escrow owner's XRPL address.
  - `seq` — The escrow's sequence number.
- **Returns:** `{ exists: true, amount: string }` if found, or `{ exists: false }` if not found (catches all exceptions, treating them as "not found").

---

### `getMPTIssuances(client: Client, account: string): Promise<any[]>` *(internal)*

Fetches all `mpt_issuance` objects for a given account using `account_objects`.

- **Parameters:**
  - `client` — Active XRPL client.
  - `account` — The XRPL address to query (typically the regulator).
- **Returns:** Array of MPT issuance objects, or `[]` on error.

---

### `main(): Promise<void>` *(entry point)*

Reads `.nuclear-state.json`, connects to XRPL, and prints a multi-section status table:

1. **Header** — Facility ID, operator, contractor, regulator, liability.
2. **Master escrow** — Sequence, status (ACTIVE/RELEASED), current milestone.
3. **Child escrows** — For each of the 6 phases: phase, sequence, allocation %, RLUSD amount, status.
4. **Milestone receipts** — Lists MPT issuance IDs from state file.
5. **On-chain MPT issuances** — Fetches and lists live MPT issuances from the regulator account.

- **Side effects:** None (read-only).

---

## `cli/recover-spawn.ts`

Utility script to re-run child escrow spawning if it failed during `submit-milestone --phase=0`.

**Usage:** `npx tsx cli/recover-spawn.ts`

---

### `main(): Promise<void>` *(entry point)*

Reads `.nuclear-state.json`, loads wallets, connects to XRPL, and calls `spawnChildEscrows` directly with the facility parameters from state. Prints the resulting sequence numbers.

- **Note:** This is idempotent only if the previous attempt left no partially-created escrows. If some child escrows were created, calling this again will create duplicates.

---

## `dashboard/server.ts`

An Express HTTP server (port 3001) that acts as a backend for the React dashboard. It serves state, proxies XRPL RPC calls to avoid browser CORS restrictions, and spawns CLI processes to stream output.

**Dependencies:** `express`, `fs/promises`, `child_process`, `https`

---

### CORS middleware *(internal)*

Adds `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Methods: GET, POST, OPTIONS` to all responses. Handles `OPTIONS` preflight requests with `204 No Content`. This is required for the Vite dev server (port 5173) to call the backend (port 3001).

---

### `GET /state`

Returns the contents of `.nuclear-state.json` as a JSON response.

- **Response:** `200` with parsed JSON state object; `404` with `{ error: 'state file not found' }` if the file does not exist.
- **Logs:** Request origin and timestamp.

---

### `POST /xrpl-rpc`

Proxies an XRPL JSON-RPC request body to the XRPL testnet HTTPS endpoint (`s.altnet.rippletest.net:51234`) and streams the response back. Avoids browser Same-Origin Policy restrictions that would block direct XRPL calls from the frontend.

- **Request body:** XRPL JSON-RPC object (e.g., `{ method: 'ledger_entry', params: [...] }`).
- **Response:** Proxied XRPL response JSON.
- **Error:** `502` with error message if the upstream request fails.
- **Logs:** Method name and timestamp.

---

### `xrplAccountTx(account: string): Promise<unknown[]>` *(internal)*

Makes a direct HTTPS request to the XRPL testnet to fetch the last 50 transactions for an account. Returns the `transactions` array or `[]` on any error.

- **Parameters:** `account` — XRPL address to query.
- **Returns:** `Promise<unknown[]>` — Array of transaction objects.
- **Note:** Used only by the `/audit` endpoint.

---

### `GET /audit`

Fetches recent transactions for both the operator and regulator accounts, deduplicates by hash, sorts newest-first, and returns up to 100 events.

**Algorithm:**
1. Read `.nuclear-state.json` to get `escrowOwner` (operator) and `wallets.regulator.address`.
2. Call `xrplAccountTx` in parallel for both accounts.
3. Flatten the results, deduplicate by transaction `hash`.
4. Sort descending by `tx.date` or `transaction.date`.
5. Return the first 100 entries as JSON.

- **Response:** JSON array of raw XRPL transaction objects.
- **Error:** `500` if state file is missing or parsing fails.

---

### `POST /deploy`

Spawns `bash scripts/full-reset.sh` in the project root and streams its stdout/stderr to the HTTP response as a chunked plain-text stream. Used by the dashboard's "Start Demo" button.

- **Response:** Chunked `text/plain` stream ending with `\n[exit 0]` (success) or `\n[exit N]` (failure).
- **Note:** The `TerminalModal` React component reads this stream and displays it line by line.

---

### `POST /milestone/:phase`

Spawns `npx tsx cli/submit-milestone.ts --phase=<phase>` and streams its output the same way as `/deploy`.

- **Parameters:** `:phase` (URL param) — Integer 0–6.
- **Response:** Chunked `text/plain` stream.
- **Error:** `400 Invalid phase` if the value is out of range.

---

## `dashboard/src/App.tsx`

The root React component. Manages global application state, polls for facility state, and composes all sub-components into the dashboard layout.

---

### Component `App` *(default export)*

**State:**
- `nucState` — Parsed `.nuclear-state.json` object (or `null` before first load).
- `stateLoaded` — Whether the first `/state` fetch has completed (used for the loading screen).
- `modalConfig` — `{ url, title }` for the `TerminalModal`, or `null` when closed.
- `milestoneRunning` — `true` while a `POST /milestone/:phase` is in flight (disables demo buttons).

**Data sources:**
- `useEscrowState(escrowOwner, escrowSequence, childEscrows)` — Live on-chain `siteState` and `escrowBalance`.
- `useMilestoneHistory(escrowOwner)` — List of completed `MilestoneEvent` objects.

**Polling:** `/state` is polled every 4 seconds via `setInterval`. Falls back to `FALLBACK_STATE` if the server returns a non-OK response.

**Demo mode:** Enabled when the URL contains `?demo=1`. Shows a demo bar with two buttons.

---

#### `handleStartDemo(): void`

Sets `modalConfig` to trigger a `TerminalModal` that POSTs to `/deploy` and streams the full-reset script output.

---

#### `handleNextStep(): void`

POSTs to `/milestone/${currentMilestone}` (the next phase to submit). Sets `milestoneRunning = true` during the request to disable buttons.

---

#### `handleModalClose(): void`

Clears `modalConfig`, closing the terminal modal.

---

**Rendered components:**
- `SiteStatus` — Facility name, phase, bankruptcy banner.
- `EscrowBalance` — Locked RLUSD display with mock yield ticker.
- `OracleHealth` — 5-oracle status grid (uses mock data).
- `MilestoneTimeline` — 7-step visual timeline with on-chain history.
- `AuditFeed` — Live transaction feed from the operator and regulator accounts.
- `BankruptcyGuard` — Interactive comparison panel.
- `TerminalModal` — Streaming log output overlay (conditional).

---

## `dashboard/src/mock-data.ts`

Static mock data for demo mode and initial rendering before real data loads. Also defines the shared TypeScript interfaces for dashboard data types.

---

### Interfaces

#### `SiteState`
Browser-compatible mirror of `shared/src/types.ts::SiteState`. Uses `number[]` for `milestone_timestamps` instead of `bigint[]` to avoid React serialization issues.

#### `OracleNode`
Represents one oracle's display state:
- `index` — 0-based index.
- `address` — XRPL address.
- `status` — `'online'` or `'offline'`.
- `lastAttestationMinutesAgo` — Minutes since last seen (for display).
- `contributedToLastQuorum` — Whether this oracle signed the last milestone.

#### `MilestoneEvent`
One completed milestone's on-chain record:
- `index` — Phase number.
- `txHash` — `EscrowFinish` transaction hash.
- `timestamp` — Unix milliseconds.
- `rlusdReleased` — Amount released as a string.
- `radiationReading` — µSv/h reading at completion.
- `oracleIds` — Addresses of oracles who signed.

#### `AuditEvent`
One line in the audit feed:
- `timestamp` — Unix milliseconds.
- `eventType` — Display string (e.g., `'EscrowFinish'`).
- `detail` — Human-readable description.
- `txHash` — For linking to the explorer.

---

### Helper `facilityIdBytes(id: string): Uint8Array` *(internal)*

UTF-8 encodes the string and zero-pads to 16 bytes. Mirrors `shared/src/index.ts::facilityIdToBytes`.

---

### Mock constants

| Export | Value | Description |
|---|---|---|
| `MOCK_SITE_STATE` | `SiteState` | Phase 1, 5 zero pubkeys, PLANT-FR-001 |
| `MOCK_ORACLES` | `OracleNode[]` | 5 oracles with realistic addresses and statuses |
| `MOCK_MILESTONE_HISTORY` | `MilestoneEvent[]` | M0 (no release) and M1 (127M RLUSD) |
| `MOCK_ESCROW_BALANCE` | `'847500000'` | Demo total liability in drops |
| `MOCK_YIELD_EARNED` | `'14250'` | Starting yield for the EscrowBalance ticker |
| `MOCK_AUDIT_EVENTS` | `AuditEvent[]` | EscrowCreate, 2× CredentialCreate, EscrowFinish |

---

## `dashboard/src/hooks/useEscrowState.ts`

React hook that polls the XRPL ledger for live escrow state. Handles the progression from master escrow (deleted after M0) to child escrows by trying each sequence number in order.

---

### `decodeSiteState(hex: string): SiteState` *(internal)*

Browser-native Borsh decoder for `SiteState`. Mirrors `shared/src/index.ts::decodeSiteState` but uses `DataView` (available in browsers) instead of Node.js `Buffer`, and converts `u64` timestamp fields to `number` rather than `bigint` to avoid React state serialization issues.

- **Parameters:** `hex` — Hex string of the Borsh-encoded `SiteState` (from the `Data` field of an XRPL escrow ledger object).
- **Returns:** `SiteState` with `milestone_timestamps` as `number[]`.

---

### `xrplRpc(method: string, params: unknown): Promise<unknown>` *(internal)*

Sends a JSON-RPC request to the local `/xrpl-rpc` proxy endpoint (which forwards to the XRPL testnet). Avoids direct browser → XRPL calls that would fail CORS.

- **Parameters:** `method` — XRPL RPC method name; `params` — Method parameters.
- **Returns:** The `result` field of the XRPL response.

---

### `useEscrowState(escrowOwner: string, escrowSequence: number, childEscrows: number[]): EscrowStateResult`

Polls the XRPL ledger every 4 seconds to find the first active escrow in the candidate list `[escrowSequence, ...childEscrows]`. Returns the decoded `SiteState` and `Amount` from whichever escrow is found first.

**Algorithm:**
1. If `escrowOwner === 'mock'`: immediately return mock data and stop.
2. On mount: poll immediately, then set a 4-second interval.
3. On each poll: try each sequence in `[escrowSequence, ...childEscrows]` sequentially using `xrplRpc('ledger_entry', { escrow: { owner, seq } })`.
4. For the first hit: decode `node.Data` as `SiteState` and extract `node.Amount` as the balance string.
5. If no escrow is found: set `error = 'no active escrow found'`.

- **Parameters:**
  - `escrowOwner` — XRPL address owning the escrows. Pass `'mock'` for demo mode.
  - `escrowSequence` — Master escrow sequence number.
  - `childEscrows` — Array of 6 child escrow sequence numbers (may be empty before M0).
- **Returns:** `EscrowStateResult`:
  - `siteState` — Decoded `SiteState` or `null` if not yet loaded.
  - `escrowBalance` — Amount in XRP drops as a string.
  - `loading` — `true` until the first successful fetch.
  - `error` — Error message or `null`.
- **Note:** The `escrowOwner` dependency in `useEffect` causes the effect to re-run when the owner changes (e.g., after state file updates). `escrowSequence` changes do not trigger a re-run; the interval polls all candidates on each tick.

---

## `dashboard/src/hooks/useMilestoneHistory.ts`

React hook that polls the XRPL ledger for completed milestone transactions and parses them into `MilestoneEvent` objects.

---

### `xrplRpc(method: string, params: unknown): Promise<unknown>` *(internal)*

Identical to the function in `useEscrowState.ts`. Proxies XRPL RPC calls through the local server.

---

### `useMilestoneHistory(escrowOwner: string): MilestoneHistoryResult`

Fetches up to 200 `account_tx` entries for the `escrowOwner` and filters for successful `EscrowFinish` transactions.

**Algorithm:**
1. If `escrowOwner === 'mock'`: return `MOCK_MILESTONE_HISTORY` immediately.
2. On mount: fetch immediately, then set an 8-second interval.
3. On each fetch: call `xrplRpc('account_tx', { account: escrowOwner, limit: 200, ... })`.
4. Filter for `TransactionType === 'EscrowFinish'` and `TransactionResult === 'tesSUCCESS'`.
5. For each match: attempt to extract a `milestone` field from hex-decoded memo data (falls back to event count).
6. Convert the XRPL timestamp to Unix milliseconds using the `XRPL_EPOCH_OFFSET = 946684800`.
7. Extract the `delivered_amount` from metadata for the `rlusdReleased` field.
8. Sort by `milestone_index` ascending.

- **Parameters:** `escrowOwner` — XRPL address to query (or `'mock'`).
- **Returns:** `MilestoneHistoryResult`:
  - `milestones` — Sorted array of `MilestoneEvent` objects (may be empty).
  - `loading` — `true` until the first fetch completes.

---

## `dashboard/src/components/SiteStatus.tsx`

Displays the current facility name, decommissioning phase name, phase badge, bankruptcy protection banner, and permissioned domain reference.

---

### `facilityIdToString(bytes: Uint8Array): string` *(internal)*

Decodes a 16-byte facility ID `Uint8Array` to a human-readable string by stripping trailing null bytes.

---

### Component `SiteStatus({ siteState }: Props)`

- **Props:** `siteState: SiteState | null` — Falls back to phase 0 and `'PLANT-FR-001'` if null.
- **Renders:**
  - Facility ID badge (navy).
  - Phase name from `PHASE_NAMES[milestone]` (gray for phase 0, amber for 1–5, green for phase 6).
  - Red banner: "Bankruptcy protection: ACTIVE".
  - Permissioned domain reference label.

**Phase names:** `['Pre-shutdown', 'Defueling', 'Fuel storage', 'Decontamination', 'Demolition', 'Soil remediation', 'Site released']`

---

## `dashboard/src/components/EscrowBalance.tsx`

Displays the locked RLUSD balance and a simulated yield ticker that increments by 0.001 RLUSD per second.

---

### Component `EscrowBalance({ balance, yieldEarned }: Props)`

- **Props:**
  - `balance: string` — RLUSD amount from `useEscrowState`. Displayed with locale formatting.
  - `yieldEarned: string` — Starting yield value. When `yieldEarned` changes, the display resets to the new value.
- **Internal state:** `displayYield` — Local float that increments every 1,000ms via `setInterval`. Formatted to 3 decimal places.
- **Renders:** Balance number, "locked on-chain" label, yield earned, and a warning: "Operator cannot withdraw. Funds release only on verified milestones."

---

## `dashboard/src/components/MilestoneTimeline.tsx`

Shows a 7-step vertical timeline of decommissioning phases with fund allocation percentages. Completed steps are clickable to show a detail tooltip.

---

### `truncateHash(hash: string): string` *(internal)*

Abbreviates a transaction hash to `first6…last6` format for display in tooltips. Returns the hash unchanged if ≤12 characters.

---

### `formatTs(ts: number): string` *(internal)*

Formats a Unix millisecond timestamp into a locale string: `DD Mon YYYY, HH:MM` (en-GB).

---

### `formatRlusd(raw: string): string` *(internal)*

Converts a raw RLUSD amount string to locale-formatted display (e.g., `"127125000"` → `"127,125,000 RLUSD"`). Returns `"—"` for zero amounts.

---

### Component `MilestoneTimeline({ currentMilestone, milestoneHistory }: Props)`

- **Props:**
  - `currentMilestone: number` — The currently active phase index.
  - `milestoneHistory: MilestoneEvent[]` — List of completed milestone events from the blockchain.
- **State:** `activeTooltip: number | null` — Which milestone step's tooltip is open.

**Step classification:**
- `i < currentMilestone` → completed (✓, clickable)
- `i === currentMilestone` → active (●)
- `i > currentMilestone` → locked (🔒)

**Tooltip:** Clicking a completed step toggles a floating card showing completion time, radiation reading, RLUSD released, transaction link, and oracle IDs.

**Track click handler:** Closes the tooltip when clicking the background track (not a step).

---

## `dashboard/src/components/OracleHealth.tsx`

Displays the status grid for all 5 oracles with online/offline indicators and quorum contribution badges.

---

### `truncateAddress(addr: string): string` *(internal)*

Abbreviates an XRPL address to `first6…last4` format.

---

### Component `OracleHealth({ oracles }: Props)`

- **Props:** `oracles: OracleNode[]` — Array of 5 oracle status objects (currently always `MOCK_ORACLES`).
- **Renders:** A 5-column grid where each cell shows:
  - Colored status dot (green = online, red = offline).
  - Oracle number label.
  - Optional "Quorum" badge if `contributedToLastQuorum`.
  - Truncated address.
  - "Last attestation: N min ago" text.
  - "Signed last milestone" line if contributed to quorum.
- **Caption:** "3-of-5 quorum required to verify each milestone".

---

## `dashboard/src/components/AuditFeed.tsx`

Polls the `/audit` endpoint every 4 seconds and displays a live feed of on-chain events relevant to the facility.

---

### `formatTime(ts: number): string` *(internal)*

Formats a Unix millisecond timestamp as `HH:MM:SS` (en-GB time format).

---

### `classifyTx(tx: Record<string, unknown>, meta: Record<string, unknown>): AuditEvent | null` *(internal)*

Converts a raw XRPL transaction object into an `AuditEvent` display item, or returns `null` if the transaction type is not recognized.

**Recognized types:**
- `CredentialCreate` → `"Credential issued to <Subject>"`.
- `EscrowCreate` → `"Escrow created: <Amount> RLUSD locked"`.
- `EscrowFinish` → `"Milestone COMPLETE — <drops> drops released"` or `"Milestone REJECTED by WASM"` based on `TransactionResult`. Extracts the amount from the deleted `Escrow` object in `AffectedNodes`.
- `MPTokenIssuanceCreate` → `"Milestone receipt (MPT) issued to contractor"`.

---

### Component `AuditFeed({ escrowOwner }: Props)`

- **Props:** `escrowOwner: string` — XRPL address to watch (or `'mock'`).
- **State:** `events: AuditEvent[]` — Displayed event list. Initialized to reversed `MOCK_AUDIT_EVENTS`.

**Polling behavior:** If `escrowOwner !== 'mock'`, fetches `/audit` every 4 seconds and updates `events` with classified transactions. On error, keeps the current list unchanged.

**Renders:** A scrollable list where each row shows timestamp, event type, detail text, and a "view ↗" link to the XRPL explorer. Badge shows "Mock" or "Live" depending on mode.

---

## `dashboard/src/components/BankruptcyGuard.tsx`

Interactive comparison panel demonstrating that escrow funds are structurally inaccessible to creditors even in bankruptcy.

---

### Component `BankruptcyGuard()`

- **State:** `simState: 'idle' | 'shaking' | 'resolved'`

**States:**
- `idle` — Shows the two-column comparison table and a "Simulate operator bankruptcy" button.
- `shaking` — After clicking the button, displays an overlay with "BANKRUPTCY FILED" for 1.5 seconds (achieved with a `setTimeout`).
- `resolved` — After the shake, shows a "Reset simulation" button and a result box: "Escrow balance: UNCHANGED — 847,500,000 RLUSD protected by WASM".

---

#### `handleSimulate(): void`

Transitions `simState` to `'shaking'`, then after 1.5 seconds transitions to `'resolved'`. Does nothing if `simState !== 'idle'`.

**Two-column comparison:**

| Traditional system | NuclearEscrow |
|---|---|
| Funds held in operator treasury | Funds locked in WASM escrow on-chain |
| Creditors can seize funds in bankruptcy | Structurally inaccessible to creditors |
| Cleanup stops — legal battles for years | Cleanup continues with new contractor |
| Taxpayer inherits liability | Funds wait for next verified milestone |
| No audit trail | Every action permanently on-chain |

---

## `dashboard/src/components/TerminalModal.tsx`

A modal overlay that streams the HTTP response of a POST request and displays it as a live terminal. Used for `/deploy` and `/milestone/:phase` output.

---

### Component `TerminalModal({ url, title, onClose }: TerminalModalProps)`

- **Props:**
  - `url: string` — The endpoint to POST to when the component mounts.
  - `title: string` — Header text describing the operation.
  - `onClose: () => void` — Callback called when the user clicks "Close" or the backdrop (only allowed after completion).
- **State:**
  - `lines: string[]` — Current output lines, updated as chunks arrive.
  - `status: 'running' | 'done' | 'error'` — `'done'` if the response ends with `[exit 0]`; `'error'` otherwise.

**Streaming algorithm:**
1. On mount: `fetch(url, { method: 'POST' })`.
2. Get a `ReadableStream` reader from `resp.body`.
3. Loop: `reader.read()` → decode chunk with `TextDecoder` (streaming mode) → `setLines(rawBuffer.split('\n'))`.
4. After `done === true`: set `status` based on whether the final text ends with `[exit 0]`.
5. On exception: append a `[client error]` line and set `status = 'error'`.
6. On unmount: set `cancelled = true` and call `reader.cancel()`.

**Auto-scroll:** A `useEffect` that watches `lines` calls `bottomRef.current?.scrollIntoView({ behavior: 'smooth' })` to keep the terminal scrolled to the bottom.

**UI:**
- Header with title, spinner (while running), or Done/Error badge.
- "Close" button appears only when `status !== 'running'`.
- `<pre>` block with all output lines joined by newlines.
- Backdrop click closes the modal (only if not running).

---

## `wasm/src/lib.rs`

The WASM contract entry point and host interface layer. This is the code that runs inside the XRPL ledger sandbox when an `EscrowFinish` transaction is processed.

---

### Host module — wasm32 target *(internal)*

When compiled to `wasm32-unknown-unknown`, these functions call externally-provided host functions via `extern "C"`. In production XRPL execution, these would be provided by the ledger runtime.

#### `get_tx_data() -> Vec<u8>`
Calls `xrpl_get_tx_data_raw(ptr, len)` to copy the EscrowFinish transaction's memo data (the Borsh-encoded `MilestoneAttestation`) into a buffer.

#### `get_escrow_data() -> Vec<u8>`
Calls `xrpl_get_escrow_data_raw(ptr, len)` to copy the escrow's current `Data` field (the Borsh-encoded `SiteState`) into a buffer.

#### `set_escrow_data(data: &[u8])`
Calls `xrpl_set_escrow_data_raw(ptr, len)` to write the updated `SiteState` back to the escrow's `Data` field. This persists state across milestone submissions.

#### `current_ledger_time() -> u64`
Returns 0 in the current implementation (placeholder; production would read from XRPL host).

---

### Host module — native/test target *(internal, `pub`)*

When compiled for native targets (tests), these functions use `thread_local!` `RefCell<Vec<u8>>` to simulate the host interface. This allows the business logic to be tested without a real XRPL runtime.

#### `set_tx_data(data: Vec<u8>)`
Sets the mock transaction data buffer for testing.

#### `set_escrow_data_mock(data: Vec<u8>)`
Sets the mock escrow data buffer for testing (distinct from `set_escrow_data` which is the write-back path).

#### `read_escrow_data() -> Vec<u8>`
Returns a clone of the current mock escrow data buffer. Used in tests to verify state was updated correctly.

#### `get_tx_data() -> Vec<u8>` / `get_escrow_data() -> Vec<u8>` / `set_escrow_data(data: &[u8])`
Thread-local implementations matching the wasm32 interface.

#### `current_ledger_time() -> u64`
Returns 0 in tests.

---

### `finish() -> i32` *(#[no_mangle], extern "C")*

The single entry point called by the XRPL ledger when an `EscrowFinish` transaction targets this escrow. Returns `1` (allow) or `0` (deny).

**Algorithm (all steps must pass; any failure returns 0):**

1. **Deserialize tx data** — Call `host::get_tx_data()` and `MilestoneAttestation::try_from_slice(&tx_bytes)`. Returns 0 on deserialization failure (malformed attestation).

2. **Deserialize escrow data** — Call `host::get_escrow_data()` and `SiteState::try_from_slice(&escrow_bytes)`. Returns 0 on deserialization failure.

3. **check_sequence** — Calls `checks::check_sequence(&attest, &state)`. Returns 0 if `attest.milestone_index != state.current_milestone + 1`. This enforces strict sequential ordering.

4. **verify_oracle_quorum** — Calls `checks::verify_oracle_quorum(&attest, &state)`. Returns 0 if fewer than 3 signatures are valid. Verifies each signature that has its bitmap bit set.

5. **check_threshold** — Calls `checks::check_threshold(&attest, &state)`. Returns 0 if `attest.sensor_reading_usv > state.thresholds[milestone_index]`.

6. **Update milestone** — Sets `state.current_milestone = attest.milestone_index`.

7. **Record timestamp** — If `milestone_index < 7`, sets `state.milestone_timestamps[milestone_index] = host::current_ledger_time()`.

8. **Persist state** — Borsh-serializes the updated `SiteState` and calls `host::set_escrow_data(&encoded)`. Returns 0 if serialization fails.

9. **Return 1** — Success.

- **Returns:** `1` if all checks pass and state is persisted; `0` otherwise.
- **Note:** This function is the security core of the entire system. No keys or credentials can override its decision. A return of 0 causes the XRPL ledger to reject the `EscrowFinish` transaction, leaving the escrow and its funds untouched.

---

## `wasm/src/state.rs`

Rust struct definitions for the two core on-chain data types, derived with Borsh serialization. These must stay in sync with `shared/src/types.ts`.

---

### Struct `SiteState`

`#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]`

| Field | Rust type | Bytes | Description |
|---|---|---|---|
| `current_milestone` | `u8` | 1 | Last completed milestone (0 = none) |
| `oracle_pubkeys` | `[[u8; 32]; 5]` | 160 | 5 Ed25519 oracle public keys |
| `thresholds` | `[f32; 7]` | 28 | Radiation thresholds per phase (µSv/h) |
| `domain_id` | `[u8; 32]` | 32 | XRPL Permissioned Domain ledger entry ID |
| `facility_id` | `[u8; 16]` | 16 | UTF-8 facility ID, zero-padded |
| `milestone_timestamps` | `[u64; 7]` | 56 | Ledger close times of completed milestones |

**Total: 293 bytes.**

#### `impl SiteState::test_default() -> Self`

Creates a `SiteState` with default values for unit testing:
- `current_milestone = 0`
- All oracle pubkeys zeroed
- `thresholds = [100.0, 10.0, 1.0, 0.5, 0.1, 0.1, 0.01]`
- `domain_id` zeroed
- `facility_id = "PLANT-FR-001\0\0\0\0"` (12 ASCII bytes + 4 zero bytes)
- All timestamps zeroed

---

### Struct `MilestoneAttestation`

`#[derive(BorshDeserialize, Clone, Debug)]` — Note: only `BorshDeserialize` (not `Serialize`); the WASM contract only reads attestations, never writes them.

| Field | Rust type | Bytes | Description |
|---|---|---|---|
| `milestone_index` | `u8` | 1 | Phase being attested (1–6) |
| `sensor_reading_usv` | `f32` | 4 | Radiation reading in µSv/h |
| `sensor_reading_hash` | `[u8; 32]` | 32 | SHA-256 of sensor batch JSON |
| `oracle_signatures` | `[[u8; 64]; 5]` | 320 | Ed25519 sigs; absent = 64 zero bytes |
| `signature_bitmap` | `u8` | 1 | Bit `i` set if oracle `i` signed |

**Total: 358 bytes.**

---

### Tests (`#[cfg(test)]`)

#### `test_sitestate_roundtrip`

Serializes `SiteState::test_default()` and deserializes it, verifying all fields round-trip correctly with `assert_eq!`. Guards against Borsh field ordering bugs.

#### `test_sitestate_byte_length`

Asserts that the Borsh-serialized `SiteState` is exactly 293 bytes. Formula: `1 + 160 + 28 + 32 + 16 + 56 = 293`.

#### `test_milestone_attestation_byte_length`

Constructs a 358-byte zero buffer, deserializes it as `MilestoneAttestation`, and verifies the decoded `milestone_index` is 0 (the first byte). Asserts the buffer length is 358 bytes.

#### `test_facility_id_encoding`

Verifies that `test_default()` produces `facility_id = b"PLANT-FR-001\0\0\0\0"` — specifically that the first 12 bytes are the ASCII string and the last 4 bytes are `0x00`.

---

## `wasm/src/crypto.rs`

Cryptographic primitives used by the WASM contract's quorum verification logic.

**Dependencies:** `sha2`, `ed25519-dalek`

---

### `sha256_msg(milestone_index: u8, sensor_hash: &[u8; 32], facility_id: &[u8; 16]) -> [u8; 32]`

Computes the attestation message digest. This is the exact Rust equivalent of `oracle/src/attestation.ts::buildAttestationMsg`.

**Algorithm:**
1. Create a `Sha256` hasher.
2. Feed `[milestone_index]` (1 byte).
3. Feed `sensor_hash` (32 bytes).
4. Feed `facility_id` (16 bytes).
5. Return the 32-byte digest.

- **Parameters:**
  - `milestone_index` — The phase index.
  - `sensor_hash` — SHA-256 of the sensor batch (32 bytes).
  - `facility_id` — Zero-padded facility identifier (16 bytes).
- **Returns:** `[u8; 32]` — SHA-256 digest of the 49-byte concatenation.
- **Note:** The input is identical to the TypeScript implementation. Both produce the same output for the same inputs, which is what allows cross-language signature verification.

---

### `ed25519_verify(pubkey: &[u8; 32], sig: &[u8; 64], msg: &[u8; 32]) -> bool`

Verifies an Ed25519 signature using the `ed25519-dalek` crate's strict verification mode.

**Algorithm:**
1. Construct a `VerifyingKey` from `pubkey`. Returns `false` if the key is invalid (e.g., not on the curve).
2. Construct a `Signature` from `sig`. Returns `false` if malformed.
3. Call `vk.verify_strict(msg, &signature).is_ok()`. Strict mode rejects non-canonical signatures.

- **Parameters:**
  - `pubkey` — 32-byte Ed25519 public key (raw, no prefix).
  - `sig` — 64-byte Ed25519 signature.
  - `msg` — 32-byte message digest to verify against.
- **Returns:** `true` if the signature is valid; `false` on any error.

---

## `wasm/src/checks.rs`

The three business logic validation functions called by `finish()` in `lib.rs`. Each takes the attestation and current state as inputs and returns a boolean.

**Dependencies:** `crate::state`, `crate::crypto`

---

### `check_sequence(attest: &MilestoneAttestation, state: &SiteState) -> bool`

Ensures milestones are submitted in strict sequential order. Prevents replaying a past milestone or skipping ahead.

**Logic:** `attest.milestone_index == state.current_milestone + 1`

- **Returns:** `true` only if the attestation is for exactly the next expected milestone.
- **Example:** If `state.current_milestone = 2`, only `attest.milestone_index = 3` is accepted.

---

### `verify_oracle_quorum(attest: &MilestoneAttestation, state: &SiteState) -> bool`

Verifies that at least 3 out of 5 authorized oracles have signed the attestation message for this exact milestone, sensor hash, and facility.

**Algorithm:**
1. Compute `msg = sha256_msg(attest.milestone_index, &attest.sensor_reading_hash, &state.facility_id)`.
2. For each oracle `i` from 0 to 4:
   a. Check bit `i` in `attest.signature_bitmap`. Skip if not set.
   b. Call `ed25519_verify(&state.oracle_pubkeys[i], &attest.oracle_signatures[i], &msg)`.
   c. If valid, increment `valid_count`.
3. Return `valid_count >= 3`.

- **Returns:** `true` if at least 3 valid signatures are found.
- **Security note:** Only oracles whose public keys are registered in `state.oracle_pubkeys` can contribute valid signatures. An attacker cannot add unauthorized oracle keys.

---

### `check_threshold(attest: &MilestoneAttestation, state: &SiteState) -> bool`

Confirms that the reported sensor reading is at or below the allowed threshold for this phase.

**Logic:** `attest.sensor_reading_usv <= state.thresholds[attest.milestone_index as usize]`

- **Returns:** `true` if the reading is within the allowed limit; `false` if `milestone_index >= 7` (out of bounds) or the reading exceeds the threshold.
- **Security note:** The `sensor_reading_usv` field is part of the oracle-signed attestation message (via its hash). Oracles cannot sign for a reading that wasn't observed, and the WASM contract checks the numeric value independently.

---

*End of CODEBASE_REFERENCE.md*
