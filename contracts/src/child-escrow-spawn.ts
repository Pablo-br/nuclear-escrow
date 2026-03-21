import { Client, Wallet } from 'xrpl';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { encodeSiteState, facilityIdToBytes } from '../../shared/src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MILESTONE_FUND_PCT = [0, 15, 20, 20, 20, 20, 5]; // M0 triggers only
const MILESTONE_THRESHOLDS = [100, 10, 1.0, 0.5, 0.1, 0.1, 0.01];

export interface ChildEscrowConfig {
  facilityId: string;
  oraclePubkeys: string[]; // 5 "ED"+64hex strings
  domainId: string;
  contractorAddress: string;
}

function toMemoHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

function toRippleTime(unixSeconds: number): number {
  return Math.floor(unixSeconds) - 946684800;
}

export async function spawnChildEscrows(
  operatorWallet: Wallet,
  totalRlusd: number,
  facilityConfig: ChildEscrowConfig,
  client: Client
): Promise<number[]> {
  const wasmPath = path.resolve(__dirname, '../wasm/finish.wasm');
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmHash = createHash('sha256').update(wasmBuffer).digest('hex').toUpperCase();

  const oracle_pubkeys = facilityConfig.oraclePubkeys.map(hex => {
    const stripped = (hex.startsWith('ED') || hex.startsWith('ed')) ? hex.slice(2) : hex;
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  });

  const domain_id = new Uint8Array(Buffer.from(facilityConfig.domainId, 'hex'));
  const cancelAfter = toRippleTime(Date.now() / 1000 + 2524608000); // 80 years

  const sequences: number[] = [];

  for (let phase = 1; phase <= 6; phase++) {
    const amount = Math.floor(totalRlusd * MILESTONE_FUND_PCT[phase] / 100);

    // SiteState for this child escrow: current_milestone = phase - 1
    // WASM check_sequence: attest.milestone_index == state.current_milestone + 1
    // so this child will only accept attestation for milestone `phase`
    const siteState = {
      current_milestone: phase - 1,
      oracle_pubkeys,
      thresholds: MILESTONE_THRESHOLDS,
      domain_id,
      facility_id: facilityIdToBytes(facilityConfig.facilityId),
      milestone_timestamps: Array(7).fill(BigInt(0)) as bigint[],
    };

    const encodedState = encodeSiteState(siteState);
    const stateHex = encodedState.toString('hex').toUpperCase();
    const finishAfter = toRippleTime(Date.now() / 1000 + 30);

    const tx: any = {
      TransactionType: 'EscrowCreate',
      Account: operatorWallet.address,
      Amount: String(amount),
      Destination: facilityConfig.contractorAddress,
      FinishAfter: finishAfter,
      CancelAfter: cancelAfter,
      Memos: [
        { Memo: { MemoType: toMemoHex('FinishFunctionHash'), MemoData: wasmHash } },
        { Memo: { MemoType: toMemoHex('SiteState'), MemoData: stateHex } },
        {
          Memo: {
            MemoType: toMemoHex('ChildPhase'),
            MemoData: Buffer.from([phase]).toString('hex').toUpperCase(),
          },
        },
      ],
    };

    const prepared = await client.autofill(tx);
    const signed = operatorWallet.sign(prepared);
    const result = await client.submitAndWait(signed.tx_blob);

    const meta = (result.result as any).meta ?? (result.result as any).metaData;
    if (meta?.TransactionResult !== 'tesSUCCESS') {
      throw new Error(`Child EscrowCreate phase ${phase} failed: ${meta?.TransactionResult}`);
    }

    const res = result.result as any;
    const sequence: number = res.Sequence ?? res.tx_json?.Sequence;
    console.log(
      `  Phase ${phase}: seq=${sequence}  amount=${amount} drops (${MILESTONE_FUND_PCT[phase]}%)`
    );
    sequences.push(sequence);
  }

  // Persist to .nuclear-state.json
  const statePath = path.resolve(__dirname, '../../.nuclear-state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    state.childEscrows = sequences;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  return sequences;
}
