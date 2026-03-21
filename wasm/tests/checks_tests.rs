use nuclear_escrow_wasm::checks::{check_sequence, check_threshold, verify_oracle_quorum};
use nuclear_escrow_wasm::state::{MilestoneAttestation, SiteState};
use borsh::BorshDeserialize;
use ed25519_dalek::{SigningKey, Signer};
use rand::rngs::OsRng;

fn make_attestation(
    milestone_index: u8,
    sensor_usv: f32,
    sensor_hash: [u8; 32],
    sigs: [[u8; 64]; 5],
    bitmap: u8,
) -> MilestoneAttestation {
    let mut buf = vec![];
    buf.push(milestone_index);
    buf.extend_from_slice(&sensor_usv.to_le_bytes());
    buf.extend_from_slice(&sensor_hash);
    for sig in &sigs {
        buf.extend_from_slice(sig);
    }
    buf.push(bitmap);
    MilestoneAttestation::try_from_slice(&buf).unwrap()
}

fn zeroed_attestation(milestone_index: u8) -> MilestoneAttestation {
    make_attestation(milestone_index, 5.0, [0u8; 32], [[0u8; 64]; 5], 0)
}

// --- check_sequence tests ---

#[test]
fn test_sequence_valid_0_to_1() {
    let state = SiteState::test_default(); // current_milestone = 0
    let attest = zeroed_attestation(1);
    assert!(check_sequence(&attest, &state));
}

#[test]
fn test_sequence_skip_invalid() {
    let state = SiteState::test_default(); // current_milestone = 0
    let attest = zeroed_attestation(2);
    assert!(!check_sequence(&attest, &state));
}

#[test]
fn test_sequence_same_invalid() {
    let state = SiteState::test_default(); // current_milestone = 0
    let attest = zeroed_attestation(0);
    assert!(!check_sequence(&attest, &state));
}

#[test]
fn test_sequence_3_to_4() {
    let mut state = SiteState::test_default();
    state.current_milestone = 3;
    let attest = zeroed_attestation(4);
    assert!(check_sequence(&attest, &state));
}

// --- check_threshold tests ---

#[test]
fn test_threshold_at_boundary() {
    let state = SiteState::test_default();
    // milestone 1 threshold = 10.0
    let attest = make_attestation(1, 10.0, [0u8; 32], [[0u8; 64]; 5], 0);
    assert!(check_threshold(&attest, &state)); // at threshold: true
}

#[test]
fn test_threshold_above() {
    let state = SiteState::test_default();
    // milestone 1 threshold = 10.0
    let attest = make_attestation(1, 10.1, [0u8; 32], [[0u8; 64]; 5], 0);
    assert!(!check_threshold(&attest, &state)); // above: false
}

#[test]
fn test_threshold_below() {
    let state = SiteState::test_default();
    // milestone 1 threshold = 10.0
    let attest = make_attestation(1, 9.9, [0u8; 32], [[0u8; 64]; 5], 0);
    assert!(check_threshold(&attest, &state)); // below: true
}

// --- verify_oracle_quorum tests ---

fn build_quorum_state_and_signing_keys() -> (SiteState, [SigningKey; 5]) {
    let mut rng = OsRng;
    let keys: [SigningKey; 5] = std::array::from_fn(|_| SigningKey::generate(&mut rng));
    let mut state = SiteState::test_default();
    for (i, k) in keys.iter().enumerate() {
        state.oracle_pubkeys[i] = k.verifying_key().to_bytes();
    }
    (state, keys)
}

fn sign_msg(key: &SigningKey, msg: &[u8; 32]) -> [u8; 64] {
    key.sign(msg).to_bytes()
}

fn build_msg(state: &SiteState, milestone: u8, sensor_hash: &[u8; 32]) -> [u8; 32] {
    nuclear_escrow_wasm::crypto::sha256_msg(milestone, sensor_hash, &state.facility_id)
}

#[test]
fn test_quorum_3_valid() {
    let (state, keys) = build_quorum_state_and_signing_keys();
    let sensor_hash = [0u8; 32];
    let msg = build_msg(&state, 1, &sensor_hash);

    let mut sigs = [[0u8; 64]; 5];
    sigs[0] = sign_msg(&keys[0], &msg);
    sigs[1] = sign_msg(&keys[1], &msg);
    sigs[2] = sign_msg(&keys[2], &msg);
    // bitmap: oracles 0,1,2 → 0b00000111
    let attest = make_attestation(1, 5.0, sensor_hash, sigs, 0b00000111);
    assert!(verify_oracle_quorum(&attest, &state));
}

#[test]
fn test_quorum_2_valid_insufficient() {
    let (state, keys) = build_quorum_state_and_signing_keys();
    let sensor_hash = [0u8; 32];
    let msg = build_msg(&state, 1, &sensor_hash);

    let mut sigs = [[0u8; 64]; 5];
    sigs[0] = sign_msg(&keys[0], &msg);
    sigs[1] = sign_msg(&keys[1], &msg);
    // bitmap: oracles 0,1 → 0b00000011
    let attest = make_attestation(1, 5.0, sensor_hash, sigs, 0b00000011);
    assert!(!verify_oracle_quorum(&attest, &state));
}

#[test]
fn test_quorum_3_bitmap_one_bad_sig() {
    let (state, keys) = build_quorum_state_and_signing_keys();
    let sensor_hash = [0u8; 32];
    let msg = build_msg(&state, 1, &sensor_hash);

    let mut sigs = [[0u8; 64]; 5];
    sigs[0] = sign_msg(&keys[0], &msg);
    sigs[1] = sign_msg(&keys[1], &msg);
    // sigs[2] is zeroed (invalid) but bitmap claims oracle 2 signed
    // bitmap: oracles 0,1,2 → 0b00000111
    let attest = make_attestation(1, 5.0, sensor_hash, sigs, 0b00000111);
    assert!(!verify_oracle_quorum(&attest, &state)); // only 2 valid, not ≥3
}
