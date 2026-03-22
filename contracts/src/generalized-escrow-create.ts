/**
 * Creates the two master escrows for a generic compliance contract:
 *   - Compliance Escrow: destination = enterprise (returned if compliant)
 *   - Penalty Escrow:    destination = contractor (released if violation)
 *
 * Reuses createMasterEscrow() from escrow-create.ts for each pool.
 */

import { Client, Wallet } from 'xrpl';
import { createMasterEscrow, type EscrowConfig } from './escrow-create.js';
import type { ContractInstance } from '../../shared/src/contract-template.js';

export interface ContractEscrowPair {
  complianceSequence: number;  // master compliance escrow sequence (destination = enterprise)
  penaltySequence: number;     // master penalty escrow sequence (destination = contractor)
}

export async function createContractEscrows(
  operatorWallet: Wallet,     // enterprise wallet — signs both EscrowCreate txs
  instance: ContractInstance,
  client: Client
): Promise<ContractEscrowPair> {
  const { template } = instance;

  // Build the per-period thresholds array. The existing SiteState holds [f32;7];
  // for contracts with up to 7 periods this maps directly. For longer contracts
  // the WASM uses the threshold at index min(period, 6), so we encode up to 7.
  const thresholds = padOrTruncate(instance.thresholdPerPeriod, 7);

  const baseConfig: Omit<EscrowConfig, 'contractorAddress' | 'liabilityRlusd'> = {
    facilityId: instance.id.slice(0, 12), // 12 bytes max for facility_id field
    oraclePubkeys: instance.oraclePubkeys,
    thresholds,
    domainId: instance.domainId ?? '0'.repeat(64),
  };

  // ── Compliance Escrow ──────────────────────────────────────────────────────
  // Destination = enterprise. Released when oracle reading meets the compliance criterion.
  console.log('[Contracts] Creating compliance escrow (destination = enterprise)...');
  const complianceConfig: EscrowConfig = {
    ...baseConfig,
    liabilityRlusd: instance.compliancePool,
    contractorAddress: instance.enterpriseAddress,  // compliance → back to enterprise
  };
  const complianceSequence = await createMasterEscrow(operatorWallet, complianceConfig, client);
  console.log(`[Contracts] Compliance escrow created: seq=${complianceSequence}`);

  // ── Penalty Escrow ─────────────────────────────────────────────────────────
  // Destination = contractor. Released when oracle reading violates the criterion.
  console.log('[Contracts] Creating penalty escrow (destination = contractor)...');
  const penaltyConfig: EscrowConfig = {
    ...baseConfig,
    liabilityRlusd: instance.penaltyPool,
    contractorAddress: instance.contractorAddress,  // violation → contractor
  };
  const penaltySequence = await createMasterEscrow(operatorWallet, penaltyConfig, client);
  console.log(`[Contracts] Penalty escrow created: seq=${penaltySequence}`);

  return { complianceSequence, penaltySequence };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function padOrTruncate(arr: number[], len: number): number[] {
  if (arr.length >= len) return arr.slice(0, len);
  const last = arr[arr.length - 1] ?? 0;
  return [...arr, ...Array(len - arr.length).fill(last)];
}
