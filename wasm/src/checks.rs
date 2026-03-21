use crate::state::{MilestoneAttestation, SiteState};
use crate::crypto::{sha256_msg, ed25519_verify};

pub fn check_sequence(attest: &MilestoneAttestation, state: &SiteState) -> bool {
    attest.milestone_index == state.current_milestone + 1
}

pub fn verify_oracle_quorum(attest: &MilestoneAttestation, state: &SiteState) -> bool {
    let msg = sha256_msg(
        attest.milestone_index,
        &attest.sensor_reading_hash,
        &state.facility_id,
    );
    let mut valid_count = 0u8;
    for i in 0..5 {
        if attest.signature_bitmap & (1 << i) != 0 {
            if ed25519_verify(&state.oracle_pubkeys[i], &attest.oracle_signatures[i], &msg) {
                valid_count += 1;
            }
        }
    }
    valid_count >= 3
}

pub fn check_threshold(attest: &MilestoneAttestation, state: &SiteState) -> bool {
    let idx = attest.milestone_index as usize;
    if idx >= state.thresholds.len() {
        return false;
    }
    attest.sensor_reading_usv <= state.thresholds[idx]
}
