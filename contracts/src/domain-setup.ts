import { Client, Wallet } from 'xrpl';

function toHex(str: string): string {
  return Buffer.from(str, 'utf-8').toString('hex').toUpperCase();
}

export async function createDomain(regulatorWallet: Wallet, client: Client): Promise<string> {
  const tx = await client.autofill({
    TransactionType: 'PermissionedDomainSet' as any,
    Account: regulatorWallet.address,
    AcceptedCredentials: [
      { Credential: { Issuer: regulatorWallet.address, CredentialType: toHex('OperatingLicense') } },
      { Credential: { Issuer: regulatorWallet.address, CredentialType: toHex('ContractorCert') } },
      { Credential: { Issuer: regulatorWallet.address, CredentialType: toHex('OracleNode') } },
    ],
  } as any);

  const signed = regulatorWallet.sign(tx);
  const result = await client.submitAndWait(signed.tx_blob);

  const meta = (result.result as any).meta ?? (result.result as any).metaData;
  const txResult = meta?.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    throw new Error(`PermissionedDomainSet failed: ${txResult}`);
  }

  const affectedNodes: any[] = meta?.AffectedNodes ?? [];
  const domainNode = affectedNodes.find(
    (n: any) => n.CreatedNode?.LedgerEntryType === 'PermissionedDomain'
  );

  const domainId: string = domainNode?.CreatedNode?.LedgerIndex;
  if (!domainId) {
    throw new Error('Could not find PermissionedDomain LedgerIndex in tx metadata');
  }

  console.log('Domain created:', domainId);
  return domainId;
}
