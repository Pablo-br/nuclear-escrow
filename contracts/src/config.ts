import { Wallet } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TESTNET_WS = "wss://s.altnet.rippletest.net:51233";
// Mock RLUSD issuer for testnet (use regulator as IOU issuer in demo)
export const RLUSD_ISSUER = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";

export interface WalletSet {
  regulator: Wallet;
  operator: Wallet;
  contractor: Wallet;
  oracles: Wallet[];
}

export function loadWallets(): WalletSet {
  const envPath = path.resolve(__dirname, '../../.env.testnet');
  const content = fs.readFileSync(envPath, 'utf-8');
  const env: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }

  const regulator = Wallet.fromSeed(env['REGULATOR_SEED']!, { algorithm: 'ed25519' });
  const operator = Wallet.fromSeed(env['OPERATOR_SEED']!, { algorithm: 'ed25519' });
  const contractor = Wallet.fromSeed(env['CONTRACTOR_SEED']!, { algorithm: 'ed25519' });
  const oracles = [0, 1, 2, 3, 4].map(i =>
    Wallet.fromSeed(env[`ORACLE${i}_SEED`]!, { algorithm: 'ed25519' })
  );

  return { regulator, operator, contractor, oracles };
}
