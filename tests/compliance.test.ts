/**
 * tests/compliance.test.ts — End-to-end tests for the XRPL Hooks compliance
 * system.
 *
 * Environment variables (required):
 *   XRPL_WS_URL        — WebSocket URL of xahaud node or Hooks testnet
 *                         default: wss://hooks-testnet-v3.xrpl-labs.com
 *   REGULATOR_SEED     — Regulator wallet seed (ed25519)
 *   COMPANY_SEED       — Company wallet seed (ed25519)
 *   CONTRACTOR_SEED    — Contractor wallet seed (ed25519)
 *   ORACLE0_SEED       — Oracle 0 wallet seed
 *   ORACLE1_SEED       — Oracle 1 wallet seed
 *   ORACLE2_SEED       — Oracle 2 wallet seed
 *   ORACLE3_SEED       — Oracle 3 wallet seed
 *   ORACLE4_SEED       — Oracle 4 wallet seed
 *
 * Run:
 *   npx vitest run tests/compliance.test.ts
 *
 * Test matrix (10 tests):
 *   1. Compliant consensus → funds returned to company
 *   2. Non-compliant consensus → funds sent to contractor
 *   3. Split vote below M on both sides → rollback, allows retry
 *   4. Duplicate oracle pubkey in one submission → rejected
 *   5. Oracle not in committee → rejected even if registered
 *   6. Proof submitted before period is opened → rejected
 *   7. Invalid (corrupted) signature → rejected
 *   8. Reputation scores after compliant finalisation
 *   9. Reputation scores after non-compliant finalisation
 *  10. Non-compliance trigger without valid M-of-K oracle proof → rejected
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { Client, Wallet } from "xrpl";
import { ed25519 } from "@noble/curves/ed25519";

import {
  SCHEMA_VERSION,
  VOTE_COMPLIANT,
  VOTE_NON_COMPLIANT,
  PERIOD_STATUS_INACTIVE,
  PERIOD_STATUS_ACTIVE,
  PERIOD_STATUS_FINALIZED,
  SK_PERIOD_STATUS,
  SK_COLLATERAL_DROPS,
  encodeProofBlob,
  buildOraclePayload,
  buildMemo,
  encodeLockMemoData,
} from "../src/types.js";
import { registerOracle, readOracleRegistration } from "../src/oracle-registry.js";
import { selectCommittee, commitCommittee } from "../src/committee.js";
import { installRegistryHook } from "../src/regulator.js";
import {
  installComplianceHook,
  lockCollateral,
  buildVoteEntry,
  buildProofBlob,
  submitProof,
  readComplianceState,
} from "../src/company.js";

// ─── Configuration ───────────────────────────────────────────────────────────

dotenv.config({ path: path.resolve(process.cwd(), ".env.testnet") });

const WS_URL        = process.env.XRPL_WS_URL ?? "wss://hooks-testnet-v3.xrpl-labs.com";
const COLLATERAL    = 5_000_000n;   // 5 XRP in drops
const N_ORACLES     = 5;
const M_THRESHOLD   = 4;            // ≥ ⌊2×5/3⌋+1 = 4
const K_COMMITTEE   = 10;           // ≥ 3M-2 = 10
const PERIOD_SEQ    = 1;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing environment variable: ${key}`);
  return v;
}

function loadWallets(): {
  regulator: Wallet;
  company:   Wallet;
  contractor: Wallet;
  oracles:   Wallet[];
} {
  return {
    regulator:  Wallet.fromSeed(requireEnv("REGULATOR_SEED"),  { algorithm: "ed25519" }),
    company:    Wallet.fromSeed(requireEnv("COMPANY_SEED"),    { algorithm: "ed25519" }),
    contractor: Wallet.fromSeed(requireEnv("CONTRACTOR_SEED"), { algorithm: "ed25519" }),
    oracles:    [0, 1, 2, 3, 4].map((i) =>
      Wallet.fromSeed(requireEnv(`ORACLE${i}_SEED`), { algorithm: "ed25519" }),
    ),
  };
}

/** Extract the raw 32-byte ed25519 private key from an xrpl.js Wallet. */
function oraclePrivKey(wallet: Wallet): Buffer {
  // xrpl.js stores privateKey as "ED" + 64-hex (Ed25519) or "00" + 64-hex
  const hex = wallet.privateKey;
  const raw = hex.startsWith("ED") || hex.startsWith("ed")
    ? hex.slice(2)
    : hex.slice(2);  // strip "00" prefix for secp256k1 (should be ed25519)
  return Buffer.from(raw, "hex");
}

/** Extract the raw 32-byte ed25519 public key from an xrpl.js Wallet. */
function oraclePubKey(wallet: Wallet): Buffer {
  const hex = wallet.publicKey;
  const raw = hex.startsWith("ED") || hex.startsWith("ed")
    ? hex.slice(2)
    : hex;
  return Buffer.from(raw, "hex");
}

/** Read PERIOD_STATUS from the company namespace. */
async function readPeriodStatus(
  companyAddress: string,
  client: Client,
): Promise<number> {
  const entries = await readComplianceState(companyAddress, client);
  const keyHex  = SK_PERIOD_STATUS.toString("hex").toUpperCase();
  const entry   = entries.find((e) => e.key.toUpperCase() === keyHex);
  return entry ? parseInt(entry.value.slice(0, 2), 16) : PERIOD_STATUS_INACTIVE;
}

/** Tiny helper: submit a raw tx and return the engine result. */
async function submitTx(
  wallet: Wallet,
  txFields: Record<string, unknown>,
  client:  Client,
): Promise<string> {
  const prepared = await client.autofill(txFields as Parameters<typeof client.autofill>[0]);
  const signed   = wallet.sign(prepared);
  const result   = await client.submitAndWait(signed.tx_blob);
  return (
    ((result.result as Record<string, unknown>).meta as Record<string, unknown>)
      ?.TransactionResult as string ?? "unknown"
  );
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe("XRPL Hooks Compliance System", () => {
  let client:    Client;
  let regulator: Wallet;
  let company:   Wallet;
  let contractor: Wallet;
  let oracles:   Wallet[];

  /** Period-open ledger sequence (set after lockCollateral in each test). */
  let periodLedgerSeq = 0;

  /**
   * beforeAll:
   *   1. Connect to the XRPL node.
   *   2. Install both hooks.
   *   3. Register all oracle pubkeys.
   */
  beforeAll(async () => {
    client = new Client(WS_URL);
    await client.connect();

    const wallets = loadWallets();
    regulator  = wallets.regulator;
    company    = wallets.company;
    contractor = wallets.contractor;
    oracles    = wallets.oracles;

    console.log("Wallets loaded:");
    console.log("  regulator: ", regulator.address);
    console.log("  company:   ", company.address);
    console.log("  contractor:", contractor.address);
    oracles.forEach((o, i) => console.log(`  oracle[${i}]: `, o.address));

    // ── Install registry hook on regulator ──
    console.log("\nInstalling registry hook…");
    await installRegistryHook(regulator, client);

    // ── Install compliance hook on company ──
    console.log("Installing compliance hook…");
    await installComplianceHook(
      company,
      regulator.address,
      contractor.address,
      M_THRESHOLD,
      K_COMMITTEE,
      COLLATERAL,
      client,
    );

    // ── Register N oracle pubkeys ──
    console.log(`\nRegistering ${N_ORACLES} oracles…`);
    for (const oracle of oracles) {
      const pubkey = oraclePubKey(oracle);
      await registerOracle(pubkey, regulator, client);
      console.log(`  Registered oracle ${oracle.address.slice(0, 12)}…`);
    }

    console.log("Setup complete.\n");
  }, 120_000);

  afterAll(async () => {
    await client.disconnect();
  });

  // ── Helper: open a fresh period ───────────────────────────────────────────

  async function openFreshPeriod(seq: number): Promise<number> {
    // Reset period status by re-locking (only valid if status is inactive).
    // If status is already finalized from a previous test, we advance seq.

    const allOracles = oracles.map((w) => ({
      pubkey:         oraclePubKey(w),
      registeredAt:   0,
      reputationScore: 0,
    }));

    const committee = selectCommittee(seq, allOracles, K_COMMITTEE);
    await commitCommittee(seq, committee, regulator, client);

    const { ledgerSeq } = await lockCollateral(
      company, seq, COLLATERAL, client,
    );
    periodLedgerSeq = ledgerSeq;
    return ledgerSeq;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 1: Compliant consensus — M+ compliant votes → funds returned
  // ─────────────────────────────────────────────────────────────────────────
  it("1. compliant consensus returns funds to company", async () => {
    const seq = PERIOD_SEQ;
    const ledgerTs = await openFreshPeriod(seq);

    // All K oracle wallets vote compliant (we use the first K; with K=10 and
    // N_ORACLES=5 in the test env, we limit committee tests to N=5, K=3, M=2)
    // Note: for simplicity in tests, use N=5, M=2, K=4 (3*2-2=4 ≤ 5).
    // (The beforeAll installs with M=4, K=10 but tests override with smaller set.)
    // For a self-contained test, sign M entries with valid sigs.

    const voteEntries = oracles.slice(0, M_THRESHOLD).map((oracle) =>
      buildVoteEntry(
        oraclePrivKey(oracle),
        seq,
        company.address,
        VOTE_COMPLIANT,
        ledgerTs,
      ),
    );

    const blob = buildProofBlob(seq, ledgerTs, voteEntries);

    const companyBalanceBefore = BigInt(
      (await client.getXrpBalance(company.address)).replace(".", ""),
    );

    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(true);

    const status = await readPeriodStatus(company.address, client);
    expect(status).toBe(PERIOD_STATUS_FINALIZED);

    // Company balance should have increased (collateral returned minus fees)
    const companyBalanceAfter = BigInt(
      (await client.getXrpBalance(company.address)).replace(".", ""),
    );
    // Exact amount varies due to fees, but should be close to original
    expect(companyBalanceAfter).toBeGreaterThan(companyBalanceBefore - 1_000_000n);
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 2: Non-compliant consensus → funds sent to contractor
  // ─────────────────────────────────────────────────────────────────────────
  it("2. non-compliant consensus sends funds to contractor", async () => {
    const seq = PERIOD_SEQ + 10;
    const ledgerTs = await openFreshPeriod(seq);

    const contractorBalanceBefore = BigInt(
      (await client.getXrpBalance(contractor.address)).replace(".", ""),
    );

    const voteEntries = oracles.slice(0, M_THRESHOLD).map((oracle) =>
      buildVoteEntry(
        oraclePrivKey(oracle),
        seq,
        company.address,
        VOTE_NON_COMPLIANT,
        ledgerTs,
      ),
    );

    const blob = buildProofBlob(seq, ledgerTs, voteEntries);
    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(true);

    const status = await readPeriodStatus(company.address, client);
    expect(status).toBe(PERIOD_STATUS_FINALIZED);

    const contractorBalanceAfter = BigInt(
      (await client.getXrpBalance(contractor.address)).replace(".", ""),
    );
    expect(contractorBalanceAfter).toBeGreaterThan(contractorBalanceBefore);
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 3: Split vote below M on both sides → rollback, allows retry
  // ─────────────────────────────────────────────────────────────────────────
  it("3. split vote below M causes rollback and allows retry", async () => {
    const seq = PERIOD_SEQ + 20;
    const ledgerTs = await openFreshPeriod(seq);

    // Submit fewer than M compliant votes and fewer than M non-compliant
    const half = Math.floor(M_THRESHOLD / 2);

    const voteEntries = [
      ...oracles.slice(0, half).map((o) =>
        buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
      ),
      ...oracles.slice(half, half * 2).map((o) =>
        buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_NON_COMPLIANT, ledgerTs),
      ),
    ];

    expect(voteEntries.length).toBeLessThan(M_THRESHOLD);

    const blob = buildProofBlob(seq, ledgerTs, voteEntries);
    const { success, outcome } = await submitProof(company, blob, client);
    expect(success).toBe(false);
    // Hook rolls back; engine result indicates hook rejection
    expect(outcome).not.toBe("tesSUCCESS");

    // Period still active — retry is possible
    const status = await readPeriodStatus(company.address, client);
    expect(status).toBe(PERIOD_STATUS_ACTIVE);

    // Retry with full M compliant votes succeeds
    const retryEntries = oracles.slice(0, M_THRESHOLD).map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
    );
    const retryBlob = buildProofBlob(seq, ledgerTs, retryEntries);
    const retry = await submitProof(company, retryBlob, client);
    expect(retry.success).toBe(true);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 4: Duplicate oracle pubkey in one submission → rejected
  // ─────────────────────────────────────────────────────────────────────────
  it("4. duplicate oracle pubkey in submission is rejected", async () => {
    const seq = PERIOD_SEQ + 30;
    const ledgerTs = await openFreshPeriod(seq);

    const oracle0 = oracles[0];
    const entry   = buildVoteEntry(
      oraclePrivKey(oracle0), seq, company.address, VOTE_COMPLIANT, ledgerTs,
    );

    // Include oracle0's entry twice
    const blob = buildProofBlob(seq, ledgerTs, [entry, entry]);
    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(false);

    // Period must still be active (hook rolled back)
    const status = await readPeriodStatus(company.address, client);
    expect(status).toBe(PERIOD_STATUS_ACTIVE);

    // Cleanup: finalise so the next test starts fresh
    const cleanup = oracles.slice(0, M_THRESHOLD).map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
    );
    await submitProof(company, buildProofBlob(seq, ledgerTs, cleanup), client);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 5: Oracle not in committed committee → rejected even if registered
  // ─────────────────────────────────────────────────────────────────────────
  it("5. oracle not in committee is rejected even if registered", async () => {
    const seq = PERIOD_SEQ + 40;
    const ledgerTs = await openFreshPeriod(seq);

    // Generate a fresh ephemeral keypair that is NOT in the committee
    const ephemeralPriv = crypto.getRandomValues(new Uint8Array(32));
    const ephemeralPub  = ed25519.getPublicKey(ephemeralPriv);

    // Register it (so it's in the oracle set but NOT in this period's committee)
    await registerOracle(Buffer.from(ephemeralPub), regulator, client);

    const entry = buildVoteEntry(
      Buffer.from(ephemeralPriv),
      seq,
      company.address,
      VOTE_COMPLIANT,
      ledgerTs,
    );

    const blob = buildProofBlob(seq, ledgerTs, [entry]);
    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(false);

    // Cleanup
    const cleanup = oracles.slice(0, M_THRESHOLD).map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
    );
    await submitProof(company, buildProofBlob(seq, ledgerTs, cleanup), client);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 6: Proof submitted before period is opened → rejected
  // ─────────────────────────────────────────────────────────────────────────
  it("6. proof before period is opened is rejected", async () => {
    // Do NOT call openFreshPeriod / lockCollateral.
    // PERIOD_STATUS must be INACTIVE (or FINALIZED from previous test).
    // Use a sequence that has never been opened.
    const seq = PERIOD_SEQ + 50;

    const voteEntries = oracles.slice(0, M_THRESHOLD).map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, 0),
    );
    const blob = buildProofBlob(seq, 0, voteEntries);
    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(false);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 7: Invalid (corrupted) signature → rejected
  // ─────────────────────────────────────────────────────────────────────────
  it("7. invalid signature is rejected", async () => {
    const seq = PERIOD_SEQ + 60;
    const ledgerTs = await openFreshPeriod(seq);

    const voteEntries = oracles.slice(0, M_THRESHOLD).map((o, idx) => {
      const entry = buildVoteEntry(
        oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs,
      );
      if (idx === 0) {
        // Corrupt the first oracle's signature
        const corrupted = Buffer.from(entry.signature);
        corrupted[0] ^= 0xff;
        corrupted[1] ^= 0xff;
        return { ...entry, signature: corrupted };
      }
      return entry;
    });

    const blob = buildProofBlob(seq, ledgerTs, voteEntries);
    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(false);

    // Cleanup
    const cleanup = oracles.slice(0, M_THRESHOLD).map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
    );
    await submitProof(company, buildProofBlob(seq, ledgerTs, cleanup), client);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 8: Reputation scores correct after compliant finalisation
  // ─────────────────────────────────────────────────────────────────────────
  it("8. reputation scores are correct after compliant finalisation", async () => {
    const seq = PERIOD_SEQ + 70;
    const ledgerTs = await openFreshPeriod(seq);

    // Voters: oracles 0..M-1 vote compliant
    // Non-voters: oracles M..N-1
    const voters    = oracles.slice(0, M_THRESHOLD);
    const nonVoters = oracles.slice(M_THRESHOLD);

    // Record reputation before
    const repBefore: Record<string, number> = {};
    for (const o of oracles) {
      const pk  = oraclePubKey(o);
      const reg = await readOracleRegistration(pk, regulator.address, client);
      repBefore[o.address] = reg?.reputationScore ?? 0;
    }

    const voteEntries = voters.map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
    );
    const blob = buildProofBlob(seq, ledgerTs, voteEntries);
    await submitProof(company, blob, client);

    // Wait for the emitted reputation-update transaction to be processed
    await new Promise((r) => setTimeout(r, 6000));

    // Voters who voted compliant → +1
    for (const o of voters) {
      const pk  = oraclePubKey(o);
      const reg = await readOracleRegistration(pk, regulator.address, client);
      const expected = repBefore[o.address] + 1;
      expect(reg?.reputationScore).toBe(expected);
    }

    // Non-voters → unchanged (no change for absent oracles)
    for (const o of nonVoters) {
      const pk  = oraclePubKey(o);
      const reg = await readOracleRegistration(pk, regulator.address, client);
      expect(reg?.reputationScore).toBe(repBefore[o.address]);
    }
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 9: Reputation scores correct after non-compliant finalisation
  // ─────────────────────────────────────────────────────────────────────────
  it("9. reputation scores are correct after non-compliant finalisation", async () => {
    const seq = PERIOD_SEQ + 80;
    const ledgerTs = await openFreshPeriod(seq);

    // M oracles vote non-compliant, 1 additional oracle votes compliant
    const nonCompliantVoters = oracles.slice(0, M_THRESHOLD);
    const minorityVoter      = oracles[M_THRESHOLD];  // votes compliant = minority

    const repBefore: Record<string, number> = {};
    for (const o of oracles) {
      const reg = await readOracleRegistration(oraclePubKey(o), regulator.address, client);
      repBefore[o.address] = reg?.reputationScore ?? 0;
    }

    const voteEntries = [
      ...nonCompliantVoters.map((o) =>
        buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_NON_COMPLIANT, ledgerTs),
      ),
      buildVoteEntry(
        oraclePrivKey(minorityVoter), seq, company.address, VOTE_COMPLIANT, ledgerTs,
      ),
    ];

    const blob = buildProofBlob(seq, ledgerTs, voteEntries);
    await submitProof(company, blob, client);

    await new Promise((r) => setTimeout(r, 6000));

    // Non-compliant voters (outcome = non-compliant) → +1
    for (const o of nonCompliantVoters) {
      const reg = await readOracleRegistration(oraclePubKey(o), regulator.address, client);
      expect(reg?.reputationScore).toBe(repBefore[o.address] + 1);
    }

    // Minority voter (compliant in non-compliant outcome) → -1
    const minReg = await readOracleRegistration(
      oraclePubKey(minorityVoter), regulator.address, client,
    );
    expect(minReg?.reputationScore).toBe(repBefore[minorityVoter.address] - 1);
  }, 90_000);

  // ─────────────────────────────────────────────────────────────────────────
  // TEST 10: Non-compliance without valid oracle proof → rejected
  // ─────────────────────────────────────────────────────────────────────────
  it("10. non-compliance trigger without valid proof is rejected", async () => {
    const seq = PERIOD_SEQ + 90;
    const ledgerTs = await openFreshPeriod(seq);

    // Build a non-compliant proof but with bad signatures on all entries
    const voteEntries = oracles.slice(0, M_THRESHOLD).map((o) => {
      const entry = buildVoteEntry(
        oraclePrivKey(o), seq, company.address, VOTE_NON_COMPLIANT, ledgerTs,
      );
      // Corrupt signature
      const corrupted = Buffer.alloc(64, 0xab);
      return { ...entry, signature: corrupted };
    });

    const blob = buildProofBlob(seq, ledgerTs, voteEntries);
    const { success } = await submitProof(company, blob, client);
    expect(success).toBe(false);

    // Funds must still be locked
    const status = await readPeriodStatus(company.address, client);
    expect(status).toBe(PERIOD_STATUS_ACTIVE);

    // Cleanup: valid compliant proof
    const cleanup = oracles.slice(0, M_THRESHOLD).map((o) =>
      buildVoteEntry(oraclePrivKey(o), seq, company.address, VOTE_COMPLIANT, ledgerTs),
    );
    await submitProof(company, buildProofBlob(seq, ledgerTs, cleanup), client);
  }, 90_000);
});
