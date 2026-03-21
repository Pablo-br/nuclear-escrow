import { Client, Wallet } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { encodeSiteState, facilityIdToBytes } from '../../shared/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface EscrowConfig {
  facilityId: string;
  liabilityRlusd: string;
  oraclePubkeys: string[];   // 5 hex strings, 32 bytes each (Ed25519 pubkeys, stripped of XRPL "ED" prefix)
  thresholds: number[];       // 7 values in uSv/h
  domainId: string;
  contractorAddress: string;
}

function toMemoHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

// Ripple epoch = Unix epoch - 946684800
function toRippleTime(unixSeconds: number): number {
  return Math.floor(unixSeconds) - 946684800;
}

export async function createMasterEscrow(
  operatorWallet: Wallet,
  config: EscrowConfig,
  client: Client
): Promise<number> {
  // 1. Read WASM, compute SHA-256 hash (store hash on-chain as commitment)
  const wasmPath = path.resolve(__dirname, '../wasm/finish.wasm');
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmHex = wasmBuffer.toString('hex').toUpperCase();

  if (wasmHex.length > 200000) {
    throw new Error(`WASM too large: ${wasmBuffer.length} bytes`);
  }
  const wasmHash = createHash('sha256').update(wasmBuffer).digest('hex').toUpperCase();
  console.log(`WASM size: ${wasmBuffer.length} bytes (${wasmHex.length} hex chars)`);
  console.log(`WASM SHA-256: ${wasmHash}`);

  // 2. Build SiteState using encodeSiteState
  const oracle_pubkeys = config.oraclePubkeys.map(hex => {
    const stripped = hex.startsWith('ED') || hex.startsWith('ed') ? hex.slice(2) : hex;
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  });

  const domain_id = new Uint8Array(Buffer.from(config.domainId, 'hex'));
  if (domain_id.length !== 32) {
    throw new Error(`domainId must be 32 bytes hex, got ${domain_id.length} bytes`);
  }

  const siteState = {
    current_milestone: 0,
    oracle_pubkeys,
    thresholds: config.thresholds,
    domain_id,
    facility_id: facilityIdToBytes(config.facilityId),
    milestone_timestamps: Array(7).fill(BigInt(0)) as bigint[],
  };
  const encodedState = encodeSiteState(siteState);
  const stateHex = encodedState.toString('hex').toUpperCase();
  console.log(`SiteState Data size: ${encodedState.length} bytes`);

  // 3. CancelAfter = current time + 80 years in Ripple epoch
  const cancelAfter = toRippleTime(Date.now() / 1000 + 2524608000);

  // 4. EscrowCreate transaction
  //    Amount uses XRP drops (demo substitute for RLUSD).
  //    WASM and SiteState stored in Memos since EscrowCreate FinishFunction
  //    is not yet in standard xrpl.js types.
  const amountDrops = String(parseInt(config.liabilityRlusd));

  // FinishAfter = now + 30s (gives enough ledger closes before the first EscrowFinish)
  const finishAfter = toRippleTime(Date.now() / 1000 + 30);

  const tx: any = {
    TransactionType: 'EscrowCreate',
    Account: operatorWallet.address,
    Amount: amountDrops,
    Destination: config.contractorAddress,
    FinishAfter: finishAfter,
    CancelAfter: cancelAfter,
    Memos: [
      {
        // WASM hash stored as commitment (full bytecode stored off-chain / in contracts/wasm/)
        Memo: {
          MemoType: toMemoHex('FinishFunctionHash'),
          MemoData: wasmHash,
        },
      },
      {
        Memo: {
          MemoType: toMemoHex('SiteState'),
          MemoData: stateHex,
        },
      },
      {
        Memo: {
          MemoType: toMemoHex('DomainId'),
          MemoData: config.domainId.toUpperCase(),
        },
      },
    ],
  };

  const prepared = await client.autofill(tx);
  const signed = operatorWallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = (result.result as any).meta ?? (result.result as any).metaData;
  const txResult = meta?.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    throw new Error(`EscrowCreate failed: ${txResult}`);
  }

  const res = result.result as any;
  // xrpl.js v4 may store tx fields at root or under tx_json
  const sequence: number = res.Sequence ?? res.tx_json?.Sequence ?? res.seq;
  console.log(`Escrow created: sequence=${sequence}, hash=${res.hash ?? res.tx_json?.hash}`);
  return sequence;
}
