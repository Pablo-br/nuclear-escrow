use borsh::{BorshDeserialize, BorshSerialize};

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct SiteState {
    pub current_milestone: u8,
    pub oracle_pubkeys: [[u8; 32]; 5],
    pub thresholds: [f32; 7],
    pub domain_id: [u8; 32],
    pub facility_id: [u8; 16],
    pub milestone_timestamps: [u64; 7],
}

#[derive(BorshDeserialize, Clone, Debug)]
pub struct MilestoneAttestation {
    pub milestone_index: u8,
    pub sensor_reading_usv: f32,
    pub sensor_reading_hash: [u8; 32],
    pub oracle_signatures: [[u8; 64]; 5],
    pub signature_bitmap: u8,
}

impl SiteState {
    pub fn test_default() -> Self {
        let mut facility_id = [0u8; 16];
        facility_id[..12].copy_from_slice(b"PLANT-FR-001");
        // remaining 4 bytes are 0x00

        SiteState {
            current_milestone: 0,
            oracle_pubkeys: [[0u8; 32]; 5],
            thresholds: [100.0, 10.0, 1.0, 0.5, 0.1, 0.1, 0.01],
            domain_id: [0u8; 32],
            facility_id,
            milestone_timestamps: [0u64; 7],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::{BorshDeserialize, BorshSerialize};

    #[test]
    fn test_sitestate_roundtrip() {
        let state = SiteState::test_default();
        let encoded = borsh::to_vec(&state).expect("serialize failed");
        let decoded = SiteState::try_from_slice(&encoded).expect("deserialize failed");
        assert_eq!(state.current_milestone, decoded.current_milestone);
        assert_eq!(state.facility_id, decoded.facility_id);
        assert_eq!(state.thresholds, decoded.thresholds);
        assert_eq!(state.domain_id, decoded.domain_id);
        assert_eq!(state.oracle_pubkeys, decoded.oracle_pubkeys);
        assert_eq!(state.milestone_timestamps, decoded.milestone_timestamps);
    }

    #[test]
    fn test_sitestate_byte_length() {
        let state = SiteState::test_default();
        let encoded = borsh::to_vec(&state).expect("serialize failed");
        // 1 + 160 + 28 + 32 + 16 + 56 = 293
        assert_eq!(encoded.len(), 293, "SiteState must be exactly 293 bytes");
    }

    #[test]
    fn test_milestone_attestation_byte_length() {
        // MilestoneAttestation: 1 + 4 + 32 + 320 + 1 = 358
        // Build manually to verify size
        let mut buf = vec![0u8; 358];
        buf[0] = 1; // milestone_index
        // f32 = 4 bytes at offset 1
        // sensor_reading_hash = 32 bytes at offset 5
        // oracle_signatures = 320 bytes at offset 37
        // signature_bitmap = 1 byte at offset 357
        let decoded = MilestoneAttestation::try_from_slice(&buf).expect("deserialize failed");
        assert_eq!(decoded.milestone_index, 1);

        // Re-check: verify BorshDeserialize reads exactly 358 bytes
        assert_eq!(buf.len(), 358);
    }

    #[test]
    fn test_facility_id_encoding() {
        let state = SiteState::test_default();
        assert_eq!(&state.facility_id[..12], b"PLANT-FR-001");
        assert_eq!(&state.facility_id[12..], &[0u8; 4]);
    }
}
