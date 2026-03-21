/**
 * Usage: npx tsx cli/submit-milestone.ts --phase=0
 *
 * Submits a milestone attestation for the NuclearEscrow contract.
 * Steps:
 *   1. Load .nuclear-state.json
 *   2. Load oracle private keys from .env.testnet
 *   3. Derive Ed25519 private keys from XRPL seeds
 *   4. Run sensor simulator for the given phase
 *   5. Have oracles 0,1,2 sign the attestation
 *   6. Build MilestoneAttestation via QuorumAggregator
 *   7. Submit EscrowFinish on-chain
 *   8. Update .nuclear-state.json on success
 */

import { Client, Wallet } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { TESTNET_WS, loadWallets } from '../contracts/src/config.js';
import { finishEscrow } from '../contracts/src/escrow-finish.js';
import { spawnChildEscrows } from '../contracts/src/child-escrow-spawn.js';
import { mintMilestoneReceipt } from '../contracts/src/mpt-receipt.js';
import { SensorSimulator, PHASE_THRESHOLDS } from '../oracle/src/sensor-simulator.js';
import { signAttestation } from '../oracle/src/attestation.js';
import { QuorumAggregator } from '../oracle/src/quorum-aggregator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Parse CLI args ───────────────────────────────────────────────────────────
function parseArgs(): { phase: number } {
  const args = process.argv.slice(2);
  const phaseArg = args.find(a => a.startsWith('--phase='))?.split('=')[1];
  if (phaseArg === undefined) {
    console.error('Usage: npx tsx cli/submit-milestone.ts --phase=<0-6>');
    process.exit(1);
  }
  const phase = parseInt(phaseArg, 10);
  if (isNaN(phase) || phase < 0 || phase > 6) {
    console.error(`Invalid phase: ${phaseArg}. Must be 0-6.`);
    process.exit(1);
  }
  return { phase };
}

async function main() {
  const { phase } = parseArgs();

  // ── 1. Load .nuclear-state.json ───────────────────────────────────────────
  const statePath = path.resolve(__dirname, '../.nuclear-state.json');
  if (!fs.existsSync(statePath)) {
    console.error('.nuclear-state.json not found. Run cli/init.ts first.');
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const currentMilestone: number = state.current_milestone ?? 0;
  const facilityId: string = state.facilityId;
  const escrowOwner: string = state.escrowOwner;

  // Phase 0 uses the master escrow; phases 1-6 use their dedicated child escrow
  let escrowSequence: number;
  if (phase === 0) {
    escrowSequence = state.escrowSequence;
  } else {
    const childEscrows: number[] = state.childEscrows ?? [];
    if (childEscrows.length < phase) {
      console.error(`Child escrow for phase ${phase} not found. Run --phase=0 first to spawn child escrows.`);
      process.exit(1);
    }
    escrowSequence = childEscrows[phase - 1];
  }

  console.log(`\n=== NuclearEscrow Submit Milestone: phase=${phase} ===`);
  console.log(`Facility: ${facilityId}  |  Current milestone: ${currentMilestone}\n`);

  // ── Check phase matches current_milestone ─────────────────────────────────
  if (phase !== currentMilestone) {
    console.log(`[Sensor]  Phase ${phase} requested but current milestone is ${currentMilestone}`);
    console.log(`[Chain]   (skipping chain call — sequence blocked)`);
    console.log(`[Result]  WASM returned 0 -> REJECTED: milestone ${phase} already processed or out of sequence`);
    process.exit(0);
  }

  // ── 2. Load oracle private keys from .env.testnet ────────────────────────
  const { regulator, operator, contractor, oracles } = loadWallets();

  // ── 3. Derive Ed25519 private keys (strip XRPL "ED" prefix) ──────────────
  const oraclePrivKeys = oracles.map(w =>
    new Uint8Array(Buffer.from(w.privateKey.slice(2), 'hex'))
  );
  const oraclePubKeys = oracles.map(w =>
    new Uint8Array(Buffer.from(w.publicKey.slice(2), 'hex'))
  );

  // ── 4. Sensor simulator ───────────────────────────────────────────────────
  const sim = new SensorSimulator(facilityId);
  // Advance to target phase
  for (let i = 0; i < phase; i++) sim.advancePhase();

  const batch = sim.getCurrentBatch();
  const sensorHash = sim.hashBatch(batch);
  const threshold = PHASE_THRESHOLDS[phase];
  const sensorOk = batch.median < threshold;

  console.log(
    `[Sensor]  Phase ${phase} reading: ${batch.median} uSv/h (threshold: ${threshold}) -> ${sensorOk ? 'OK' : 'FAIL'}`
  );
  if (!sensorOk) {
    console.error('[Sensor]  Reading exceeds threshold — cannot submit attestation.');
    process.exit(1);
  }

  // ── 5. Oracles 0,1,2 sign ────────────────────────────────────────────────
  const agg = new QuorumAggregator();
  for (const idx of [0, 1, 2]) {
    const sig = signAttestation(oraclePrivKeys[idx], phase, sensorHash, facilityId);
    agg.add(idx, sig, oraclePubKeys[idx], phase, sensorHash, facilityId);
    console.log(`[Oracle${idx}] Signed milestone ${phase}`);
  }

  // ── 6. Check quorum ───────────────────────────────────────────────────────
  if (!agg.hasQuorum()) {
    console.error('[Quorum]  Failed to reach quorum (need 3/5).');
    process.exit(1);
  }
  console.log(`[Quorum]  3/5 oracles agreed -> submitting`);

  // ── 7. Build MilestoneAttestation ────────────────────────────────────────
  const attestation = agg.buildAttestation(phase, batch.median, sensorHash);

  // ── 8. Submit EscrowFinish ────────────────────────────────────────────────
  const client = new Client(TESTNET_WS);
  await client.connect();

  let result;
  try {
    result = await finishEscrow(operator, escrowOwner, escrowSequence, attestation, client);
  } finally {
    await client.disconnect();
  }

  console.log(`[Chain]   EscrowFinish tx: ${result.txHash}`);

  if (result.success) {
    console.log(`[Result]  WASM returned 1 -> milestone ${phase} COMPLETE`);

    // ── 9. Update .nuclear-state.json ──────────────────────────────────────
    state.current_milestone = phase + 1;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`[State]   current_milestone is now ${state.current_milestone}`);

    // ── 10. Spawn child escrows after M0 ───────────────────────────────────
    if (phase === 0) {
      console.log('\n[Spawn]   Spawning 6 child escrows...');
      const childClient = new Client(TESTNET_WS);
      await childClient.connect();
      let childSeqs: number[];
      try {
        childSeqs = await spawnChildEscrows(
          operator,
          parseInt(state.liability),
          {
            facilityId,
            oraclePubkeys: oracles.map(o => o.publicKey),
            domainId: state.domainId,
            contractorAddress: contractor.address,
          },
          childClient
        );
      } finally {
        await childClient.disconnect();
      }
      console.log(`[Spawn]   Spawned 6 child escrows: [${childSeqs.join(', ')}]`);
    }

    // ── 11. Mint MPT milestone receipt ─────────────────────────────────────
    try {
      const receiptClient = new Client(TESTNET_WS);
      await receiptClient.connect();
      let issuanceId: string;
      try {
        issuanceId = await mintMilestoneReceipt(
          regulator,
          contractor.address,
          phase,
          facilityId,
          result.txHash,
          Buffer.from(sensorHash).toString('hex'),
          parseInt(state.liability),
          receiptClient
        );
      } finally {
        await receiptClient.disconnect();
      }
      // Persist receipt ID to state
      const freshState = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      freshState.milestoneReceipts = freshState.milestoneReceipts ?? [];
      freshState.milestoneReceipts.push(issuanceId);
      fs.writeFileSync(statePath, JSON.stringify(freshState, null, 2));
      console.log(`[Receipt] MPT receipt minted: ${issuanceId}`);
    } catch (e: any) {
      console.warn(`[Receipt] MPT mint skipped: ${e.message ?? e}`);
    }
  } else {
    console.log(`[Result]  WASM returned 0 -> REJECTED: ${result.reason ?? 'unknown'}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Error:', e.message ?? e);
  process.exit(1);
});
