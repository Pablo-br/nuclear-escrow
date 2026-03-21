// CRITICAL: borsh field order defines wire format — do NOT reorder

export interface SiteState {
  // 1. current_milestone: u8
  current_milestone: number;
  // 2. oracle_pubkeys: 5x [u8;32]
  oracle_pubkeys: Uint8Array[]; // length = 5, each 32 bytes
  // 3. thresholds: 7x f32
  thresholds: number[]; // length = 7
  // 4. domain_id: [u8;32]
  domain_id: Uint8Array; // 32 bytes
  // 5. facility_id: [u8;16] — ASCII, zero-padded
  facility_id: Uint8Array; // 16 bytes
  // 6. milestone_timestamps: 7x u64
  milestone_timestamps: bigint[]; // length = 7
}

export interface MilestoneAttestation {
  // 1. milestone_index: u8
  milestone_index: number;
  // 2. sensor_reading_usv: f32
  sensor_reading_usv: number;
  // 3. sensor_reading_hash: [u8;32]
  sensor_reading_hash: Uint8Array; // 32 bytes
  // 4. oracle_signatures: 5x [u8;64] — zero-padded for absent oracles
  oracle_signatures: Uint8Array[]; // length = 5, each 64 bytes
  // 5. signature_bitmap: u8 — bit i=1 if oracle i signed
  signature_bitmap: number;
}
