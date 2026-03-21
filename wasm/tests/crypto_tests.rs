use nuclear_escrow_wasm::crypto::sha256_msg;
use sha2::{Digest, Sha256};

#[test]
fn test_vector_match() {
    // facility_id = b"PLANT-FR-001\x00\x00\x00\x00"
    let mut facility_id = [0u8; 16];
    facility_id[..12].copy_from_slice(b"PLANT-FR-001");

    // sensor_hash = sha256(b"mock-sensor-batch-001")
    let sensor_hash: [u8; 32] = Sha256::digest(b"mock-sensor-batch-001").into();

    // milestone_index = 1
    let msg = sha256_msg(1, &sensor_hash, &facility_id);

    let hex_out = hex::encode(msg);
    println!("TEST VECTOR HEX: {}", hex_out);

    assert_eq!(
        hex_out,
        "11f3e63da67de7dbcd55946bcf995d0b72171f88bfa1f2b0f57a76f128c282af",
        "Test vector does not match SHARED_TYPES.md ground truth"
    );
}
