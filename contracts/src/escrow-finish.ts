import { Client, Wallet } from 'xrpl';
import { encodeMilestoneAttestation, type MilestoneAttestation } from '../../shared/src/index.js';

export interface FinishResult {
  success: boolean;
  txHash: string;
  reason?: string;
}

const MAX_RETRIES = 3;
// ~40 seconds of extra headroom (40s / 3.3s per ledger ≈ 12) on top of autofill's default ~20.
const LAST_LEDGER_BUFFER = 12;

export async function finishEscrow(
  submitter: Wallet,
  owner: string,
  sequence: number,
  attestation: MilestoneAttestation,
  client: Client
): Promise<FinishResult> {
  const encoded = encodeMilestoneAttestation(attestation);
  const tx: any = {
    TransactionType: 'EscrowFinish',
    Account: submitter.address,
    Owner: owner,
    OfferSequence: sequence,
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from('Attestation', 'utf-8').toString('hex').toUpperCase(),
          MemoData: encoded.toString('hex').toUpperCase(),
        },
      },
    ],
  };

  let lastError = 'unknown';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const prepared = await client.autofill(tx);
      prepared.LastLedgerSequence = (prepared.LastLedgerSequence as number) + LAST_LEDGER_BUFFER;
      const signed = submitter.sign(prepared);
      const result = await client.submitAndWait(signed.tx_blob);

      const txHash: string = (result.result as any).hash ?? '';
      const meta = (result.result as any).meta ?? (result.result as any).metaData;
      const txResult: string = meta?.TransactionResult ?? 'unknown';

      if (txResult === 'tesSUCCESS') return { success: true, txHash };

      const reason: string = (result.result as any).engine_result_message ?? txResult ?? 'unknown';
      if (txResult !== 'tefPAST_SEQ') return { success: false, txHash, reason };
      lastError = reason;
    } catch (e: any) {
      lastError = e.message ?? String(e);
      const isPastSeq = lastError.includes('tefPAST_SEQ') || lastError.includes('LastLedgerSequence');
      if (!isPastSeq) throw e;
    }
  }

  return { success: false, txHash: '', reason: `tefPAST_SEQ after ${MAX_RETRIES} attempts: ${lastError}` };
}
