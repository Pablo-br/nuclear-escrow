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

  // Fixed small demo collateral per child escrow (testnet wallets are capped at ~100 XRP).
  // The real RLUSD allocation per phase is recorded in the LiabilityRlusd memo below.
  const DEMO_CHILD_COLLATERAL_DROPS = 100000; // 0.1 XRP per child

  const MAX_RETRIES = 3;

  for (let phase = 1; phase <= 6; phase++) {
    const rlusdAmount = Math.floor(totalRlusd * MILESTONE_FUND_PCT[phase] / 100);
    const amount = DEMO_CHILD_COLLATERAL_DROPS;

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

    let sequence: number | null = null;
    let lastError: string = 'unknown';

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const finishAfter = toRippleTime(Date.now() / 1000 + 5);

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
          {
            Memo: {
              MemoType: toMemoHex('LiabilityRlusd'),
              MemoData: Buffer.from(String(rlusdAmount), 'utf-8').toString('hex').toUpperCase(),
            },
          },
        ],
      };

      try {
        const prepared = await client.autofill(tx);
        prepared.LastLedgerSequence = (prepared.LastLedgerSequence as number) + 30;
        const signed = operatorWallet.sign(prepared);
        const result = await client.submitAndWait(signed.tx_blob);

        const meta = (result.result as any).meta ?? (result.result as any).metaData;
        const txResult = meta?.TransactionResult;

        if (txResult === 'tesSUCCESS') {
          const res = result.result as any;
          sequence = res.Sequence ?? res.tx_json?.Sequence;
          console.log(
            `  Phase ${phase}: seq=${sequence}  ${rlusdAmount.toLocaleString()} RLUSD (${MILESTONE_FUND_PCT[phase]}%)${attempt > 1 ? ` (attempt ${attempt})` : ''}`
          );
          break;
        }

        const reason = (result.result as any).engine_result_message ?? txResult ?? 'unknown';
        lastError = `${txResult} — ${reason}`;
        console.error(`[Spawn]   Phase ${phase} attempt ${attempt}/${MAX_RETRIES} FAILED: ${lastError}`);
      } catch (e: any) {
        lastError = e.message ?? String(e);
        console.error(`[Spawn]   Phase ${phase} attempt ${attempt}/${MAX_RETRIES} threw: ${lastError}`);
      }

      if (attempt < MAX_RETRIES) {
        console.log(`[Spawn]   Retrying phase ${phase} in 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    if (sequence === null) {
      throw new Error(`Child EscrowCreate phase ${phase} failed after ${MAX_RETRIES} attempts: ${lastError}`);
    }

    sequences.push(sequence);
  }

  // Verify all escrows exist on-ledger before writing state
  console.log('[Spawn]   Verifying all child escrows on-ledger...');
  const accountObjects: any = await client.request({
    command: 'account_objects',
    account: operatorWallet.address,
    type: 'escrow',
    limit: 400,
  });
  const onChainSeqs = new Set<number>(
    (accountObjects.result.account_objects ?? []).map((o: any) => o.Sequence)
  );
  for (let i = 0; i < sequences.length; i++) {
    const phase = i + 1;
    if (!onChainSeqs.has(sequences[i])) {
      throw new Error(`Child escrow phase ${phase} (seq=${sequences[i]}) not found on-ledger after creation`);
    }
    console.log(`[Spawn]   Phase ${phase} seq=${sequences[i]} confirmed on-ledger ✓`);
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
