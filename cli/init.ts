/**
 * Usage: npx tsx cli/init.ts --site=PLANT-FR-001 --liability=1000000
 *
 * Full facility initialization flow:
 *   1. Load wallets from .env.testnet
 *   2. Create Permissioned Domain
 *   3. Issue OperatingLicense to operator
 *   4. Issue ContractorCert to contractor
 *   5. Issue OracleNode credentials to each oracle
 *   6. Create master EscrowCreate with WASM + SiteState
 *   7. Save .nuclear-state.json
 */

import { Client } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { TESTNET_WS, loadWallets } from '../contracts/src/config.js';
import { createDomain } from '../contracts/src/domain-setup.js';
import {
  issueOperatingLicense,
  issueContractorCert,
  issueOracleNode,
} from '../contracts/src/credential-issuer.js';
import { createMasterEscrow } from '../contracts/src/escrow-create.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse CLI args
function parseArgs(): { site: string; liability: string } {
  const args = process.argv.slice(2);
  const site = args.find(a => a.startsWith('--site='))?.split('=')[1];
  const liability = args.find(a => a.startsWith('--liability='))?.split('=')[1];
  if (!site || !liability) {
    console.error('Usage: npx tsx cli/init.ts --site=PLANT-FR-001 --liability=1000000');
    process.exit(1);
  }
  return { site, liability };
}

// Default radiation thresholds per milestone (µSv/h), index 0..6
const DEFAULT_THRESHOLDS = [100.0, 10.0, 1.0, 0.5, 0.1, 0.1, 0.01];

async function main() {
  const { site, liability } = parseArgs();
  console.log(`\n=== NuclearEscrow Init: site=${site} liability=${liability} RLUSD ===\n`);

  const client = new Client(TESTNET_WS);
  await client.connect();
  console.log('Connected to XRPL testnet\n');

  // 1. Load wallets
  const { regulator, operator, contractor, oracles } = loadWallets();
  console.log('Wallets loaded:');
  console.log(`  regulator:  ${regulator.address}`);
  console.log(`  operator:   ${operator.address}`);
  console.log(`  contractor: ${contractor.address}`);
  oracles.forEach((o, i) => console.log(`  oracle${i}:    ${o.address}`));
  console.log();

  // 2. Create Permissioned Domain
  console.log('Creating Permissioned Domain...');
  const domainId = await createDomain(regulator, client);

  // 3. Issue OperatingLicense to operator
  console.log('\nIssuing OperatingLicense...');
  const opLicenseId = await issueOperatingLicense(
    regulator,
    operator.address,
    { facility_id: site, liability_rlusd: liability, jurisdiction: 'FR' },
    client
  );

  // 4. Issue ContractorCert to contractor
  console.log('\nIssuing ContractorCert...');
  const contractorCertId = await issueContractorCert(regulator, contractor.address, client);

  // 5. Issue OracleNode credentials
  console.log('\nIssuing OracleNode credentials...');
  const oracleCertIds: string[] = [];
  const oraclePubkeys: string[] = [];
  for (let i = 0; i < 5; i++) {
    const pubkeyFull = oracles[i].publicKey; // "ED" + 64 hex
    oraclePubkeys.push(pubkeyFull);
    const certId = await issueOracleNode(regulator, oracles[i].address, pubkeyFull, client);
    oracleCertIds.push(certId);
  }

  // 6. Create master escrow
  console.log('\nCreating Master Escrow...');
  const escrowSequence = await createMasterEscrow(
    operator,
    {
      facilityId: site,
      liabilityRlusd: liability,
      oraclePubkeys,
      thresholds: DEFAULT_THRESHOLDS,
      domainId,
      contractorAddress: contractor.address,
    },
    client
  );

  // 7. Save .nuclear-state.json
  const state = {
    domainId,
    escrowOwner: operator.address,
    escrowSequence,
    facilityId: site,
    liability,
    credentials: {
      operatingLicense: opLicenseId,
      contractorCert: contractorCertId,
      oracleNodes: oracleCertIds,
    },
    wallets: {
      regulator: { address: regulator.address },
      operator: { address: operator.address },
      contractor: { address: contractor.address },
      oracles: oracles.map((o, i) => ({
        address: o.address,
        publicKey: o.publicKey,
        credentialId: oracleCertIds[i],
      })),
    },
    childEscrows: [],
    createdAt: new Date().toISOString(),
  };

  const statePath = path.resolve(__dirname, '../.nuclear-state.json');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`\n.nuclear-state.json written to ${statePath}`);

  // 8. Print summary
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║              NuclearEscrow Facility Initialized               ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║  Facility ID:        ${site.padEnd(41)} ║`);
  console.log(`║  Domain ID:          ${domainId.slice(0, 41).padEnd(41)} ║`);
  console.log(`║  Escrow Owner:       ${operator.address.padEnd(41)} ║`);
  console.log(`║  Escrow Sequence:    ${String(escrowSequence).padEnd(41)} ║`);
  console.log(`║  Contractor:         ${contractor.address.padEnd(41)} ║`);
  console.log(`║  Liability:          ${(liability + ' drops XRP').padEnd(41)} ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  Credentials                                                  ║');
  console.log(`║    OperatingLicense: ${opLicenseId.slice(0, 41).padEnd(41)} ║`);
  console.log(`║    ContractorCert:   ${contractorCertId.slice(0, 41).padEnd(41)} ║`);
  oracleCertIds.forEach((id, i) => {
    console.log(`║    OracleNode[${i}]:   ${id.slice(0, 41).padEnd(41)} ║`);
  });
  console.log('╚══════════════════════════════════════════════════════════════╝\n');
  console.log(`Explorer: https://testnet.xrpl.org/accounts/${operator.address}`);

  await client.disconnect();
}

main().catch((e) => {
  console.error('Error:', e.message ?? e);
  process.exit(1);
});
