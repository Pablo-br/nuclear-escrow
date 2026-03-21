import { Client, Wallet, decodeAccountID } from 'xrpl';

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
  client: Client,
  contractorWallet: Wallet
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

  // MPTokenIssuanceID is a 192-bit (48 hex char) value: 4-byte BE sequence + 20-byte account ID.
  // Use the sequence from the autofilled tx (guaranteed populated) rather than result.result.Sequence.
  const txSequence: number = (prepared as any).Sequence;
  const accountIdBytes = decodeAccountID(regulatorWallet.address);
  const seqBuf = Buffer.alloc(4);
  seqBuf.writeUInt32BE(txSequence, 0);
  const issuanceId: string = Buffer.concat([seqBuf, accountIdBytes]).toString('hex').toUpperCase();
  console.log('Minted receipt MPT:', issuanceId);

  // Step 2: Contractor opts in to receive the token
  const optInTx: any = {
    TransactionType: 'MPTokenAuthorize',
    Account: contractorWallet.address,
    MPTokenIssuanceID: issuanceId,
  };
  const optInPrepared = await client.autofill(optInTx);
  const optInSigned = contractorWallet.sign(optInPrepared);
  const optInResult = await client.submitAndWait(optInSigned.tx_blob);
  const optInTxResult =
    ((optInResult.result as any).meta ?? (optInResult.result as any).metaData)?.TransactionResult;
  if (optInTxResult !== 'tesSUCCESS') {
    throw new Error(`MPTokenAuthorize (contractor opt-in) failed: ${optInTxResult}`);
  }
  console.log('Contractor opted in to MPT:', issuanceId);

  // Step 3: Regulator delivers the MPT to the contractor
  const payTx: any = {
    TransactionType: 'Payment',
    Account: regulatorWallet.address,
    Destination: contractorAddress,
    Amount: {
      mpt_issuance_id: issuanceId,
      value: '1',
    },
  };
  const payPrepared = await client.autofill(payTx);
  const paySigned = regulatorWallet.sign(payPrepared);
  const payResult = await client.submitAndWait(paySigned.tx_blob);
  const payTxResult =
    ((payResult.result as any).meta ?? (payResult.result as any).metaData)?.TransactionResult;
  if (payTxResult !== 'tesSUCCESS') {
    throw new Error(`MPT Payment delivery to contractor failed: ${payTxResult}`);
  }
  console.log('MPT receipt delivered to contractor:', contractorAddress);

  return issuanceId;
}
