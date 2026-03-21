import { Client } from 'xrpl';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TESTNET_WS, loadWallets } from '../contracts/src/config.js';
import { spawnChildEscrows } from '../contracts/src/child-escrow-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const statePath = path.resolve(__dirname, '../.nuclear-state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
  const { operator, contractor, oracles } = loadWallets();
  const client = new Client(TESTNET_WS);
  await client.connect();
  const seqs = await spawnChildEscrows(
    operator,
    parseInt(state.liability),
    {
      facilityId: state.facilityId,
      oraclePubkeys: oracles.map((o: any) => o.publicKey),
      domainId: state.domainId,
      contractorAddress: contractor.address,
    },
    client
  );
  await client.disconnect();
  console.log('Done. Child escrow sequences:', seqs);
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
