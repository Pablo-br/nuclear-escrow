/**
 * Spawns one compliance child escrow + one penalty child escrow per period.
 *
 * In a compliance period:
 *   - If the enterprise is compliant → compliance child escrow is finished (EscrowFinish)
 *     → funds return to enterprise
 *   - If the enterprise violates → penalty child escrow is finished
 *     → funds go to contractor
 *
 * Only ONE child per pool wins each period. The other expires via CancelAfter.
 */

import { Client, Wallet } from 'xrpl';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { encodeSiteState, facilityIdToBytes } from '../../shared/src/index.js';
import type { ContractInstance } from '../../shared/src/contract-template.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MAX_RETRIES = 3;

function toMemoHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

function toRippleTime(unixSeconds: number): number {
  return Math.floor(unixSeconds) - 946684800;
}

export interface PeriodEscrowPair {
  complianceSequence: number;
  penaltySequence: number;
}

/**
 * Spawns the child escrow pair for a single period.
 *
 * @param operatorWallet   Enterprise wallet (pays for both EscrowCreate txs)
 * @param instance         The contract instance (provides oracle keys, thresholds, etc.)
 * @param periodIndex      0-based period index
 * @param client           Active XRPL client
 */
export async function spawnPeriodEscrows(
  operatorWallet: Wallet,
  instance: ContractInstance,
  periodIndex: number,
  client: Client
): Promise<PeriodEscrowPair> {
  const { template } = instance;
  const wasmPath = path.resolve(__dirname, '../wasm/finish.wasm');
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmHash = createHash('sha256').update(wasmBuffer).digest('hex').toUpperCase();

  const oracle_pubkeys = instance.oraclePubkeys.map(hex => {
    const stripped = (hex.startsWith('ED') || hex.startsWith('ed')) ? hex.slice(2) : hex;
    return new Uint8Array(Buffer.from(stripped, 'hex'));
  });

  const domain_id = new Uint8Array(Buffer.from(instance.domainId ?? '0'.repeat(64), 'hex'));
  const thresholds = padOrTruncate(instance.thresholdPerPeriod, 7);

  // SiteState for this period: current_milestone = periodIndex
  // The WASM will accept an attestation for milestone periodIndex + 1
  const siteState = {
    current_milestone: periodIndex,
    oracle_pubkeys,
    thresholds,
    domain_id,
    facility_id: facilityIdToBytes(instance.id.slice(0, 12)),
    milestone_timestamps: Array(7).fill(BigInt(0)) as bigint[],
  };

  const encodedState = encodeSiteState(siteState);
  const stateHex = encodedState.toString('hex').toUpperCase();

  // Period allocation
  const pctIndex = Math.min(periodIndex, template.periodDistribution.length - 1);
  const periodPct = template.periodDistribution[pctIndex];

  const complianceAllocation = Math.floor(
    Number(instance.compliancePool) * periodPct / 100
  );
  const penaltyAllocation = Math.floor(
    Number(instance.penaltyPool) * periodPct / 100
  );

  // CancelAfter: a bit longer than period length so only one period is active at a time
  const periodDurationSec = template.periodLengthDays * 24 * 60 * 60;
  const cancelAfterUnix = Date.now() / 1000 + periodDurationSec + 3600; // +1h buffer
  const cancelAfter = toRippleTime(cancelAfterUnix);

  const complianceSeq = await createChildEscrow({
    operatorWallet,
    destination: instance.enterpriseAddress,
    allocationRlusd: complianceAllocation,
    periodIndex,
    poolType: 'compliance',
    contractId: instance.id,
    wasmHash,
    stateHex,
    cancelAfter,
    client,
    label: `P${periodIndex}-compliance`,
  });

  const penaltySeq = await createChildEscrow({
    operatorWallet,
    destination: instance.contractorAddress,
    allocationRlusd: penaltyAllocation,
    periodIndex,
    poolType: 'penalty',
    contractId: instance.id,
    wasmHash,
    stateHex,
    cancelAfter,
    client,
    label: `P${periodIndex}-penalty`,
  });

  return { complianceSequence: complianceSeq, penaltySequence: penaltySeq };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface ChildEscrowParams {
  operatorWallet: Wallet;
  destination: string;
  allocationRlusd: number;
  periodIndex: number;
  poolType: 'compliance' | 'penalty';
  contractId: string;
  wasmHash: string;
  stateHex: string;
  cancelAfter: number;
  client: Client;
  label: string;
}

async function createChildEscrow(p: ChildEscrowParams): Promise<number> {
  // Demo collateral: 0.1 XRP per child (testnet constraint)
  const DEMO_COLLATERAL_DROPS = 100000;

  let lastError = 'unknown';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const finishAfter = toRippleTime(Date.now() / 1000 + 5);

    const tx: any = {
      TransactionType: 'EscrowCreate',
      Account: p.operatorWallet.address,
      Amount: String(DEMO_COLLATERAL_DROPS),
      Destination: p.destination,
      FinishAfter: finishAfter,
      CancelAfter: p.cancelAfter,
      Memos: [
        { Memo: { MemoType: toMemoHex('FinishFunctionHash'), MemoData: p.wasmHash } },
        { Memo: { MemoType: toMemoHex('SiteState'), MemoData: p.stateHex } },
        {
          Memo: {
            MemoType: toMemoHex('ContractId'),
            MemoData: Buffer.from(p.contractId, 'utf-8').toString('hex').toUpperCase(),
          },
        },
        {
          Memo: {
            MemoType: toMemoHex('PoolType'),
            MemoData: Buffer.from(p.poolType, 'utf-8').toString('hex').toUpperCase(),
          },
        },
        {
          Memo: {
            MemoType: toMemoHex('PeriodIndex'),
            MemoData: Buffer.from([p.periodIndex]).toString('hex').toUpperCase(),
          },
        },
        {
          Memo: {
            MemoType: toMemoHex('LiabilityRlusd'),
            MemoData: Buffer.from(String(p.allocationRlusd), 'utf-8').toString('hex').toUpperCase(),
          },
        },
      ],
    };

    try {
      const prepared = await p.client.autofill(tx);
      prepared.LastLedgerSequence = (prepared.LastLedgerSequence as number) + 30;
      const signed = p.operatorWallet.sign(prepared);
      const result = await p.client.submitAndWait(signed.tx_blob);

      const meta = (result.result as any).meta ?? (result.result as any).metaData;
      const txResult = meta?.TransactionResult;

      if (txResult === 'tesSUCCESS') {
        const res = result.result as any;
        const sequence: number = res.Sequence ?? res.tx_json?.Sequence;
        console.log(
          `[Spawn] ${p.label}: seq=${sequence}  ${p.allocationRlusd.toLocaleString()} RLUSD → ${p.destination.slice(0, 10)}…`
        );
        return sequence;
      }

      lastError = `${txResult} — ${(result.result as any).engine_result_message ?? ''}`;
      console.error(`[Spawn] ${p.label} attempt ${attempt}/${MAX_RETRIES} FAILED: ${lastError}`);
    } catch (e: any) {
      lastError = e.message ?? String(e);
      console.error(`[Spawn] ${p.label} attempt ${attempt}/${MAX_RETRIES} threw: ${lastError}`);
    }

    if (attempt < MAX_RETRIES) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  throw new Error(`Child escrow ${p.label} failed after ${MAX_RETRIES} attempts: ${lastError}`);
}

function padOrTruncate(arr: number[], len: number): number[] {
  if (arr.length >= len) return arr.slice(0, len);
  const last = arr[arr.length - 1] ?? 0;
  return [...arr, ...Array(len - arr.length).fill(last)];
}
