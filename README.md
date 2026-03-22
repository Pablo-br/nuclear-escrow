# NuclearEscrow — XRPL Compliance Escrow Platform

A web application that lets regulators publish compliance contract templates on the XRP Ledger and companies sign those contracts by locking XRP into on-chain escrow. Oracle consensus determines whether funds are released at the end of each compliance period or withheld.

---

## How it works

Regulators define the rules: what metric to track, how many periods, what thresholds must be met, and how funds are split. Companies find a regulator by their XRPL public key, select a template, and deposit XRP into escrow. At the end of each period, oracles attest to the real-world metric value. If the quorum of oracles confirms compliance, the period's escrow is released back to the company. A bonus escrow is released at the end only if every period was compliant.

---

## Regulator Portal

Used by regulators, government agencies, or any entity that wants to define and enforce compliance standards.

**Workflow (4 steps):**

1. **Connect Wallet** — Enter your XRPL seed to derive your regulator address. Your seed is used locally to sign transactions; it is never stored.

2. **Create Template** — Define a compliance contract template:
   - **Name & description** — human-readable label for companies to browse
   - **Industry** — energy, manufacturing, mining, chemicals, nuclear, agriculture, water, or other
   - **Metric type & unit** — what is being measured (e.g. `co2_tons`, displayed as `tons CO2/month`)
   - **Period length** — how many days each compliance period lasts
   - **Oracle count & quorum** — how many oracles will attest and how many must agree (e.g. 3-of-5)
   - **Fund split** — percentage of the total deposit held in the periodic compliance pool (returned each period if compliant) vs. the bonus pool (returned only if all periods are compliant)
   - **Violation behavior** — what happens when a period fails: release only that period's slice, release the full pool, or configurable per contract
   - **Compliance periods** — one row per period, each with its own threshold, direction (below/above), and weight percentage

3. **My Templates** — View all templates you have published. You can cancel a template from here.

4. **Active Hooks** — View all unresolved escrow objects currently on your XRPL account.

---

## Company Portal

Used by companies or any entity that needs to enter into a compliance contract with a regulator and lock funds into escrow.

**Workflow (4 steps):**

1. **Connect Wallet** — Enter your XRPL seed to derive your company address.

2. **Find Regulator** — Paste the regulator's XRPL public key (ED… hex format). The app resolves it to an XRPL address and loads all templates that regulator has published.

3. **Configure Contract** — Select a template and set up your contract:
   - **Deposit amount** — total XRP to lock, entered in drops (1 XRP = 1,000,000 drops)
   - **Fund split preview** — shows how the deposit splits between the periodic pool and the bonus pool
   - **Period breakdown** — table showing each period's weight, estimated drops, deadline date, and your chosen threshold for that period
   - Signing submits one `EscrowCreate` transaction per period plus one for the bonus pool

4. **My Hooks** — View all active escrow objects on your account. Each row shows the label (period number or bonus), amount locked, deadline, and a link to the compliance dashboard for that contract.

---

## Prerequisites

- **Node.js 20 or later**
- An **XRPL Testnet account** with funded XRP — get one at the [XRPL faucet](https://xrpl.org/resources/dev-tools/xrp-faucets)

No Rust, WASM toolchain, or CLI setup is required to run the portals.

---

## Installation

```bash
git clone git@github.com:Pablo-br/nuclear-escrow.git
cd nuclear-escrow
npm install
```

---

## Running

Open two terminals:

**Terminal 1 — Backend API:**
```bash
cd dashboard
npx tsx server.ts
```

**Terminal 2 — Frontend:**
```bash
# from the repo root
npm run dev
```

Then open **http://localhost:5173** in your browser.

---

## Environment variables

If you have pre-configured testnet seeds, copy the provided example file:

```bash
cp .env.testnet .env
```

Otherwise no `.env` file is required — you can enter any funded testnet seed directly in the portal UI.
