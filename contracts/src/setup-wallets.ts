import { Client, Wallet } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TESTNET_WS } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WALLET_NAMES = ['regulator', 'operator', 'contractor', 'oracle0', 'oracle1', 'oracle2', 'oracle3', 'oracle4'] as const;

async function main() {
  const client = new Client(TESTNET_WS);
  await client.connect();
  console.log('Connected to XRPL testnet');

  const wallets: Record<string, Wallet> = {};

  for (const name of WALLET_NAMES) {
    process.stdout.write(`Funding ${name}... `);
    // Generate Ed25519 wallet and fund via testnet faucet
    const seed = Wallet.generate('ed25519').seed!;
    const wallet = Wallet.fromSeed(seed, { algorithm: 'ed25519' });
    const funded = await client.fundWallet(wallet);
    wallets[name] = funded.wallet;
    console.log(`${funded.wallet.address}  balance: ${funded.balance} XRP`);
  }

  // Build .env.testnet content
  const lines: string[] = [];
  lines.push(`REGULATOR_SEED=${wallets['regulator'].seed}`);
  lines.push(`OPERATOR_SEED=${wallets['operator'].seed}`);
  lines.push(`CONTRACTOR_SEED=${wallets['contractor'].seed}`);
  for (let i = 0; i < 5; i++) {
    lines.push(`ORACLE${i}_SEED=${wallets[`oracle${i}`].seed}`);
  }
  lines.push('');
  lines.push(`REGULATOR_ADDRESS=${wallets['regulator'].address}`);
  lines.push(`OPERATOR_ADDRESS=${wallets['operator'].address}`);
  lines.push(`CONTRACTOR_ADDRESS=${wallets['contractor'].address}`);
  for (let i = 0; i < 5; i++) {
    lines.push(`ORACLE${i}_ADDRESS=${wallets[`oracle${i}`].address}`);
  }
  // Store oracle public keys (32-byte Ed25519, stripped of "ED" prefix)
  for (let i = 0; i < 5; i++) {
    const pubkeyFull = wallets[`oracle${i}`].publicKey; // "ED" + 64 hex
    lines.push(`ORACLE${i}_PUBKEY=${pubkeyFull}`);
  }

  const envPath = path.resolve(__dirname, '../../.env.testnet');
  fs.writeFileSync(envPath, lines.join('\n') + '\n');
  console.log(`\n.env.testnet written to ${envPath}`);

  await client.disconnect();
  console.log('Done!');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
