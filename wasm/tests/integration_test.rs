use nuclear_escrow_wasm::{finish, host};
use nuclear_escrow_wasm::state::SiteState;
use borsh::BorshDeserialize;
use ed25519_dalek::{SigningKey, Signer};
use rand::rngs::OsRng;

fn generate_keys() -> [SigningKey; 5] {
    let mut rng = OsRng;
    std::array::from_fn(|_| SigningKey::generate(&mut rng))
}

fn build_state(keys: &[SigningKey; 5]) -> SiteState {
    let mut state = SiteState::test_default();
    for (i, k) in keys.iter().enumerate() {
        state.oracle_pubkeys[i] = k.verifying_key().to_bytes();
    }
    state
}

fn serialize_attestation(
    milestone_index: u8,
    sensor_usv: f32,
    sensor_hash: [u8; 32],
    sigs: [[u8; 64]; 5],
    bitmap: u8,
) -> Vec<u8> {
    let mut buf = vec![];
    buf.push(milestone_index);
    buf.extend_from_slice(&sensor_usv.to_le_bytes());
    buf.extend_from_slice(&sensor_hash);
    for sig in &sigs {
        buf.extend_from_slice(sig);
    }
    buf.push(bitmap);
    buf
}

#[test]
fn test_finish_happy_path_and_sequence_block() {
    let keys = generate_keys();
    let state = build_state(&keys);

    let sensor_hash = [0u8; 32];
    let milestone = 1u8;
    let sensor_usv = 5.0f32; // below threshold[1] = 10.0

    let msg = nuclear_escrow_wasm::crypto::sha256_msg(milestone, &sensor_hash, &state.facility_id);

    // Sign with oracles 0, 1, 2 (bitmap = 0b00000111)
    let mut sigs = [[0u8; 64]; 5];
    sigs[0] = keys[0].sign(&msg).to_bytes();
    sigs[1] = keys[1].sign(&msg).to_bytes();
    sigs[2] = keys[2].sign(&msg).to_bytes();

    let attest_bytes = serialize_attestation(milestone, sensor_usv, sensor_hash, sigs, 0b00000111);
    let state_bytes = borsh::to_vec(&state).unwrap();

    // Inject via mock host
    host::set_tx_data(attest_bytes.clone());
    host::set_escrow_data_mock(state_bytes);

    // First call: should succeed
    let result = finish();
    assert_eq!(result, 1, "finish() should return 1 on valid attestation");

    // Read back state and verify milestone advanced
    let updated_bytes = host::read_escrow_data();
    let updated_state = SiteState::try_from_slice(&updated_bytes).unwrap();
    assert_eq!(updated_state.current_milestone, 1, "current_milestone should be 1 after finish()");
    assert_eq!(updated_state.milestone_timestamps[1], 0);

    // Second call: same attestation (milestone=1 again) should fail sequence check
    // State now has current_milestone=1, attestation still claims milestone=1 → not +1
    host::set_tx_data(attest_bytes);
    // escrow data already has updated state with current_milestone=1

    let result2 = finish();
    assert_eq!(result2, 0, "finish() should return 0 when sequence check fails (repeat milestone)");
}
