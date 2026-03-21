use sha2::{Digest, Sha256};
use ed25519_dalek::{VerifyingKey, Signature};

pub fn sha256_msg(milestone_index: u8, sensor_hash: &[u8; 32], facility_id: &[u8; 16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update([milestone_index]);
    hasher.update(sensor_hash);
    hasher.update(facility_id);
    hasher.finalize().into()
}

pub fn ed25519_verify(pubkey: &[u8; 32], sig: &[u8; 64], msg: &[u8; 32]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pubkey) else { return false; };
    let Ok(signature) = Signature::from_slice(sig) else { return false; };
    vk.verify_strict(msg, &signature).is_ok()
}
