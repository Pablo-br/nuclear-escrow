import { Client } from 'xrpl';
import fs from 'fs';
import { TESTNET_WS, loadWallets } from '../contracts/src/config.js';
import { spawnChildEscrows } from '../contracts/src/child-escrow-spawn.js';

async function main() {
  const state = JSON.parse(fs.readFileSync('.nuclear-state.json', 'utf-8'));
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
