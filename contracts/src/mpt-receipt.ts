import { Client, Wallet } from 'xrpl';

function toHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

export async function mintMilestoneReceipt(
  regulatorWallet: Wallet,
  contractorAddress: string,
  milestoneIndex: number,
  facilityId: string,
  oracleQuorumHash: string,
  sensorHash: string,
  amountRlusd: number,
  client: Client
): Promise<string> {
  const metadata = JSON.stringify({
    ticker: 'DECOMM-CERT',
    milestone: milestoneIndex,
    facility: facilityId,
    oracle_hash: oracleQuorumHash,
    sensor_hash: sensorHash,
    amount_rlusd: amountRlusd,
    timestamp: Date.now(),
  });

  const tx: any = {
    TransactionType: 'MPTokenIssuanceCreate',
    Account: regulatorWallet.address,
    Flags: 0,
    MaximumAmount: '1',
    MPTokenMetadata: toHex(metadata),
  };

  const prepared = await client.autofill(tx);
  const signed = regulatorWallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = (result.result as any).meta ?? (result.result as any).metaData;
  const txResult = meta?.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    throw new Error(`MPTokenIssuanceCreate failed: ${txResult}`);
  }

  const affectedNodes: any[] = meta?.AffectedNodes ?? [];
  const mptNode = affectedNodes.find(
    (n: any) => n.CreatedNode?.LedgerEntryType === 'MPTokenIssuance'
  );
  const issuanceId: string = mptNode?.CreatedNode?.LedgerIndex ?? 'unknown';
  console.log('Minted receipt MPT:', issuanceId);
  return issuanceId;
}
