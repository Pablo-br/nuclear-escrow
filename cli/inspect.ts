/**
 * Usage: npx tsx cli/inspect.ts
 *
 * Fetches on-chain state for the NuclearEscrow facility and prints a
 * formatted summary table.
 */

import { Client } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { TESTNET_WS } from '../contracts/src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MILESTONE_NAMES = [
  'M0: Reactor Shutdown',
  'M1: Defueling',
  'M2: Component Removal',
  'M3: Structure Decon',
  'M4: Site Clearance',
  'M5: License Termination',
  'M6: Final Release',
];

const MILESTONE_FUND_PCT = [0, 15, 20, 20, 20, 20, 5];

async function checkEscrow(
  client: Client,
  owner: string,
  seq: number
): Promise<{ exists: boolean; amount?: string }> {
  try {
    const resp = await (client as any).request({
      command: 'ledger_entry',
      escrow: { owner, seq },
      ledger_index: 'validated',
    });
    const node = (resp.result as any).node;
    return { exists: true, amount: node?.Amount };
  } catch {
    return { exists: false };
  }
}

async function getMPTIssuances(client: Client, account: string): Promise<any[]> {
  try {
    const resp = await (client as any).request({
      command: 'account_objects',
      account,
      type: 'mpt_issuance',
    });
    return (resp.result as any).account_objects ?? [];
  } catch {
    return [];
  }
}

async function main() {
  const statePath = path.resolve(__dirname, '../.nuclear-state.json');
  if (!fs.existsSync(statePath)) {
    console.error('.nuclear-state.json not found. Run cli/init.ts first.');
    process.exit(1);
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const client = new Client(TESTNET_WS);
  await client.connect();

  const currentMilestone: number = state.current_milestone ?? 0;
  const childEscrows: number[] = state.childEscrows ?? [];
  const milestoneReceipts: string[] = state.milestoneReceipts ?? [];
  const contractorAddr: string = state.wallets?.contractor?.address ?? 'N/A';
  const regulatorAddr: string = state.wallets?.regulator?.address ?? 'N/A';
  const liability = parseInt(state.liability ?? '0');

  // Fetch master escrow on-chain status
  const master = await checkEscrow(client, state.escrowOwner, state.escrowSequence);

  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║            NuclearEscrow Facility Inspector                       ║');
  console.log('╠══════════════════════════════════════════════════════════════════╣');
  console.log(`║  Facility  : ${state.facilityId.padEnd(53)}║`);
  console.log(`║  Operator  : ${state.escrowOwner.padEnd(53)}║`);
  console.log(`║  Contractor: ${contractorAddr.padEnd(53)}║`);
  console.log(`║  Regulator : ${regulatorAddr.padEnd(53)}║`);
  console.log(`║  Liability : ${String(liability + ' drops XRP').padEnd(53)}║`);
  console.log('╠══════════════════════════════════════════════════════════════════╣');

  // Master escrow block
  const masterStatus = master.exists ? 'ACTIVE  ' : 'RELEASED';
  const milestoneName = MILESTONE_NAMES[currentMilestone] ?? `M${currentMilestone}`;
  console.log('║  MASTER ESCROW                                                    ║');
  console.log(`║    Sequence : ${String(state.escrowSequence).padEnd(53)}║`);
  console.log(`║    Status   : ${masterStatus.padEnd(53)}║`);
  console.log(`║    Milestone: ${currentMilestone}/6  ${milestoneName.padEnd(48)}║`);
  console.log(`║    Explorer : https://testnet.xrpl.org/accounts/${state.escrowOwner.slice(0, 14)}...║`);
  console.log('╠══════════════════════════════════════════════════════════════════╣');

  // Child escrows
  console.log('║  CHILD ESCROWS                                                    ║');
  if (childEscrows.length === 0) {
    console.log('║    (none — spawn triggered by M0 completion)                      ║');
  } else {
    console.log(`║    ${'Phase'.padEnd(7)} ${'Sequence'.padEnd(12)} ${'Alloc'.padEnd(7)} ${'Amount(d)'.padEnd(12)} ${'Status'.padEnd(10)}║`);
    console.log(`║    ${'─'.repeat(55)}║`);
    for (let i = 0; i < childEscrows.length; i++) {
      const phase = i + 1;
      const seq = childEscrows[i];
      const pct = MILESTONE_FUND_PCT[phase];
      const amount = Math.floor(liability * pct / 100);
      const cs = await checkEscrow(client, state.escrowOwner, seq);
      const st = cs.exists ? 'active    ' : 'released  ';
      const row = `M${phase}      ${String(seq).padEnd(12)} ${String(pct + '%').padEnd(7)} ${String(amount).padEnd(12)} ${st}`;
      console.log(`║    ${row.padEnd(62)}║`);
    }
  }
  console.log('╠══════════════════════════════════════════════════════════════════╣');

  // Milestone receipts
  console.log('║  MILESTONE RECEIPTS (MPT DECOMM-CERT)                             ║');
  if (milestoneReceipts.length === 0) {
    console.log('║    (none minted yet)                                              ║');
  } else {
    for (let i = 0; i < milestoneReceipts.length; i++) {
      const id = milestoneReceipts[i];
      const label = `M${i}: ${id.slice(0, 20)}...`;
      console.log(`║    ${label.padEnd(63)}║`);
    }
  }

  // On-chain MPT issuances from regulator
  if (regulatorAddr !== 'N/A') {
    const onChainMPTs = await getMPTIssuances(client, regulatorAddr);
    if (onChainMPTs.length > 0) {
      console.log('╠══════════════════════════════════════════════════════════════════╣');
      console.log(`║  ON-CHAIN MPT ISSUANCES  (regulator: ${regulatorAddr.slice(0, 10)}...)              ║`);
      for (const m of onChainMPTs) {
        const id = (m.index ?? m.MPTokenIssuanceID ?? 'N/A').slice(0, 20);
        console.log(`║    ${id.padEnd(63)}║`);
      }
    }
  }

  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`\nExplorer: https://testnet.xrpl.org/accounts/${state.escrowOwner}\n`);

  await client.disconnect();
}

main().catch((e) => {
  console.error('Error:', e.message ?? e);
  process.exit(1);
});
