# NuclearEscrow

> **Trustless on-chain escrow for nuclear power plant decommissioning funds — enforced by radiation-monitoring oracles and WASM smart contracts on the XRP Ledger.**

---

## The Problem

Nuclear decommissioning is one of the most underfunded liabilities in the energy sector:

- **France** set aside €23 Bn against an estimated **€74 Bn** needed
- **UK** faces up to **£232 Bn** in decommissioning liabilities
- Operators routinely go bankrupt or restructure, leaving cleanup costs to taxpayers

The root issue: decommissioning funds are controlled by the same operators who have every incentive to defer spending them.

---

## The Solution

NuclearEscrow locks decommissioning funds in a smart-contract escrow on the **XRP Ledger (XRPL)**. Funds can **only** be released when on-chain WASM code verifies:

1. A quorum of **independent radiation-monitoring oracles** (3-of-5) has attested the current radiation level
2. Radiation readings are **below the threshold** defined for the current milestone
3. Milestones are completed **in strict sequence** — no skipping phases

The smart contract, not the operator, is the custodian. Operator bankruptcy cannot touch the funds.

---

## How It Works

### 7-Phase Milestone System

| Phase | Milestone | Condition |
|-------|-----------|-----------|
| 0 | Defueling complete | Radiation < threshold₀ |
| 1 | Spent fuel removed | Radiation < threshold₁ |
| 2 | Primary circuit decontaminated | Radiation < threshold₂ |
| 3 | Reactor vessel dismantled | Radiation < threshold₃ |
| 4 | Building decontaminated | Radiation < threshold₄ |
| 5 | Waste shipped offsite | Radiation < threshold₅ |
| 6 | Site restored | Radiation < threshold₆ |

### Oracle Quorum Flow

```
Radiation Sensors
      │
      ▼
5 Independent Oracles ──── Ed25519 Sign ────► Attestation
      │                                           │
      │   (3-of-5 signatures required)            │
      ▼                                           ▼
 Quorum Aggregator ─── Borsh-encoded ──► EscrowFinish Memo
                                               │
                                               ▼
                                     XRPL Hook → WASM finish()
                                               │
                              ┌────────────────┼───────────────────┐
                              ▼                ▼                   ▼
                        Verify sigs    Check threshold    Check sequence
                              │                │                   │
                              └────────────────┴───────────────────┘
                                               │
                                        ✅ Release funds
                                      to certified contractor
```

---

## Architecture

This is an npm monorepo with 5 workspaces plus a Rust/WASM contract:

```
nuclear-escrow/
├── cli/              # Command-line interface (init, submit-milestone, inspect)
├── contracts/        # XRPL transaction builders (escrow create/finish, credentials)
├── oracle/           # Oracle service: sensor simulation, Ed25519 signing, quorum aggregation
├── shared/           # Shared TypeScript types and Borsh encoders/decoders
├── dashboard/        # React + Vite monitoring dashboard (Express backend)
└── wasm/             # Rust WASM smart contract — on-chain verification logic
    └── src/
        ├── lib.rs        # Entry point: finish() hook
        ├── state.rs      # SiteState & MilestoneAttestation structs
        ├── crypto.rs     # Ed25519 signature verification
        └── checks.rs     # Quorum, threshold, and sequence validation
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Blockchain | XRPL (XRP Ledger), Ripple Hooks |
| Smart Contract | Rust → WASM (ed25519-dalek, borsh, sha2) |
| Cryptography | Ed25519 signatures, SHA-256 (via @noble/curves & @noble/hashes) |
| Serialization | Borsh (binary format, cross-language compatible) |
| Orchestration | TypeScript, Node.js, tsx |
| Dashboard | React 19, Vite 8, Express |
| Package Manager | npm workspaces |

---

## Quick Start

### Prerequisites

- Node.js 20+
- Rust + `wasm-pack` (`cargo install wasm-pack`)
- An XRPL testnet account (seeds provided in `.env.testnet`)

### Install

```bash
git clone https://github.com/Pablo-br/nuclear-escrow.git
cd nuclear-escrow
npm install
```

### Build WASM Contract

```bash
npm run build:wasm
# or directly:
bash scripts/build-wasm.sh
```

### Run Tests

```bash
npm run test:wasm
```

### Deploy to Testnet & Initialize a Facility

```bash
# Deploy infrastructure (regulatory domain, credentials, escrow)
bash scripts/deploy-testnet.sh

# Initialize facility PLANT-FR-001 with 847M RLUSD locked
npx tsx cli/init.ts --site=PLANT-FR-001 --liability=847000000
```

### Submit a Milestone

```bash
# Submit phase 0 (defueling complete)
npx tsx cli/submit-milestone.ts --phase=0

# Inspect current state
npx tsx cli/inspect.ts
```

### Run the Dashboard

```bash
cd dashboard
npm run dev &          # Vite dev server → http://localhost:5173?demo=1
npx tsx server.ts      # Express backend
```

---

## Demo

A complete 4-minute live demo script is available in [`DEMO_SCRIPT.md`](./DEMO_SCRIPT.md).

To reset and run the full demo end-to-end:

```bash
bash scripts/reset-demo.sh
bash scripts/deploy-testnet.sh
npm run dev &
npx tsx dashboard/server.ts &
bash scripts/run-demo.sh
```

---

## Wire Format

The on-chain data uses a compact Borsh binary encoding. Full specification (field offsets, byte sizes, test vectors) is in [`SHARED_TYPES.md`](./SHARED_TYPES.md).

Key structures:
- **`SiteState`** (293 bytes) — escrow state: milestones, oracle public keys, thresholds, timestamps
- **`MilestoneAttestation`** (358 bytes) — oracle attestation: facility ID, phase, sensor reading, 3+ Ed25519 signatures

---

## Security Model

- **No operator key can release funds** — only the WASM contract can authorize `EscrowFinish`
- **Oracle collusion resistance** — requires 3-of-5 independent nodes to agree
- **Threshold enforcement** — radiation reading is part of the signed message; oracles cannot attest false values without being detected
- **Sequence enforcement** — phases cannot be skipped or replayed

---

## License

MIT
