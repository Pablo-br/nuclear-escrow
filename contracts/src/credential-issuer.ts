import { Client, Wallet } from 'xrpl';

function toHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

async function createCredential(
  regulatorWallet: Wallet,
  subjectAddress: string,
  credentialType: string,
  credentialData: string | undefined,
  client: Client
): Promise<string> {
  const tx: any = {
    TransactionType: 'CredentialCreate',
    Account: regulatorWallet.address,
    Subject: subjectAddress,
    CredentialType: toHex(credentialType),
  };
  if (credentialData !== undefined) {
    tx.CredentialData = toHex(credentialData);
  }

  const prepared = await client.autofill(tx);
  const signed = regulatorWallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = (result.result as any).meta ?? (result.result as any).metaData;
  const txResult = meta?.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    throw new Error(`CredentialCreate failed: ${txResult}`);
  }

  const affectedNodes: any[] = meta?.AffectedNodes ?? [];
  const credNode = affectedNodes.find(
    (n: any) => n.CreatedNode?.LedgerEntryType === 'Credential'
  );
  const credentialId: string = credNode?.CreatedNode?.LedgerIndex ?? 'unknown';
  return credentialId;
}

export async function issueOperatingLicense(
  regulatorWallet: Wallet,
  operatorAddress: string,
  meta: { facility_id: string; liability_rlusd: string; jurisdiction?: string },
  client: Client
): Promise<string> {
  const credentialId = await createCredential(
    regulatorWallet,
    operatorAddress,
    'OperatingLicense',
    JSON.stringify(meta),
    client
  );
  console.log('OperatingLicense issued:', credentialId);
  return credentialId;
}

export async function issueContractorCert(
  regulatorWallet: Wallet,
  contractorAddress: string,
  client: Client
): Promise<string> {
  const credentialId = await createCredential(
    regulatorWallet,
    contractorAddress,
    'ContractorCert',
    undefined,
    client
  );
  console.log('ContractorCert issued:', credentialId);
  return credentialId;
}

export async function issueOracleNode(
  regulatorWallet: Wallet,
  oracleAddress: string,
  oraclePubkeyHex: string,
  client: Client
): Promise<string> {
  const credentialId = await createCredential(
    regulatorWallet,
    oracleAddress,
    'OracleNode',
    JSON.stringify({ pubkey: oraclePubkeyHex }),
    client
  );
  console.log(`OracleNode issued for ${oracleAddress}:`, credentialId);
  return credentialId;
}

export async function revokeCredential(
  regulatorWallet: Wallet,
  subjectAddress: string,
  credentialType: string,
  client: Client
): Promise<void> {
  const tx: any = {
    TransactionType: 'CredentialDelete',
    Account: regulatorWallet.address,
    Subject: subjectAddress,
    CredentialType: toHex(credentialType),
  };
  const prepared = await client.autofill(tx);
  const signed = regulatorWallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = (result.result as any).meta ?? (result.result as any).metaData;
  const txResult = meta?.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    throw new Error(`CredentialDelete failed: ${txResult}`);
  }
  console.log(`Credential ${credentialType} revoked for ${subjectAddress}`);
}
