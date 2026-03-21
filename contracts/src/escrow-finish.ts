import { Client, Wallet } from 'xrpl';
import { encodeMilestoneAttestation, type MilestoneAttestation } from '../../shared/src/index.js';

export interface FinishResult {
  success: boolean;
  txHash: string;
  reason?: string;
}

export async function finishEscrow(
  submitter: Wallet,
  owner: string,
  sequence: number,
  attestation: MilestoneAttestation,
  client: Client
): Promise<FinishResult> {
  const encoded = encodeMilestoneAttestation(attestation);
  const dataHex = encoded.toString('hex').toUpperCase();

  const tx: any = {
    TransactionType: 'EscrowFinish',
    Account: submitter.address,
    Owner: owner,
    OfferSequence: sequence,
    Memos: [
      {
        Memo: {
          MemoType: Buffer.from('Attestation', 'utf-8').toString('hex').toUpperCase(),
          MemoData: dataHex,
        },
      },
    ],
  };

  const prepared = await client.autofill(tx);
  // Extend LastLedgerSequence by 30 extra ledgers (total ~50) to avoid tefPAST_SEQ
  // caused by WSL2 WebSocket latency between autofill and submitAndWait's pre-flight check.
  prepared.LastLedgerSequence = (prepared.LastLedgerSequence as number) + 30;
  const signed = submitter.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const txHash: string = (result.result as any).hash ?? '';
  const meta = (result.result as any).meta ?? (result.result as any).metaData;
  const txResult: string = meta?.TransactionResult ?? 'unknown';

  if (txResult === 'tesSUCCESS') {
    return { success: true, txHash };
  } else {
    const reason: string = (result.result as any).engine_result_message
      ?? meta?.TransactionResult
      ?? 'unknown';
    return { success: false, txHash, reason };
  }
}
