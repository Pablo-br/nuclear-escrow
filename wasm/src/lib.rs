pub mod state;
pub mod crypto;
pub mod checks;

use borsh::{BorshDeserialize, BorshSerialize};
use state::{MilestoneAttestation, SiteState};
use checks::{check_sequence, check_threshold, verify_oracle_quorum};

// On wasm32: call XRPL host functions via extern "C".
// On host (tests/native): use thread-local mock state.

#[cfg(target_arch = "wasm32")]
mod host {
    extern "C" {
        fn xrpl_get_tx_data_raw(ptr: *mut u8, len: usize) -> usize;
        fn xrpl_get_escrow_data_raw(ptr: *mut u8, len: usize) -> usize;
        fn xrpl_set_escrow_data_raw(ptr: *const u8, len: usize);
    }

    pub fn get_tx_data() -> Vec<u8> {
        let mut buf = vec![0u8; 1024];
        let n = unsafe { xrpl_get_tx_data_raw(buf.as_mut_ptr(), buf.len()) };
        buf.truncate(n);
        buf
    }

    pub fn get_escrow_data() -> Vec<u8> {
        let mut buf = vec![0u8; 1024];
        let n = unsafe { xrpl_get_escrow_data_raw(buf.as_mut_ptr(), buf.len()) };
        buf.truncate(n);
        buf
    }

    pub fn set_escrow_data(data: &[u8]) {
        unsafe { xrpl_set_escrow_data_raw(data.as_ptr(), data.len()) };
    }

    pub fn current_ledger_time() -> u64 {
        0 // production: read from XRPL host
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub mod host {
    use std::cell::RefCell;
    thread_local! {
        static TX_DATA: RefCell<Vec<u8>> = RefCell::new(vec![]);
        static ESCROW_DATA: RefCell<Vec<u8>> = RefCell::new(vec![]);
    }

    pub fn set_tx_data(data: Vec<u8>) {
        TX_DATA.with(|d| *d.borrow_mut() = data);
    }

    pub fn set_escrow_data_mock(data: Vec<u8>) {
        ESCROW_DATA.with(|d| *d.borrow_mut() = data);
    }

    pub fn read_escrow_data() -> Vec<u8> {
        ESCROW_DATA.with(|d| d.borrow().clone())
    }

    pub fn get_tx_data() -> Vec<u8> {
        TX_DATA.with(|d| d.borrow().clone())
    }

    pub fn get_escrow_data() -> Vec<u8> {
        ESCROW_DATA.with(|d| d.borrow().clone())
    }

    pub fn set_escrow_data(data: &[u8]) {
        ESCROW_DATA.with(|d| *d.borrow_mut() = data.to_vec());
    }

    pub fn current_ledger_time() -> u64 {
        0
    }
}

#[no_mangle]
pub extern "C" fn finish() -> i32 {
    // 1. Deserialize tx data -> MilestoneAttestation
    let tx_bytes = host::get_tx_data();
    let Ok(attest) = MilestoneAttestation::try_from_slice(&tx_bytes) else { return 0; };

    // 2. Deserialize escrow data -> SiteState
    let escrow_bytes = host::get_escrow_data();
    let Ok(mut state) = SiteState::try_from_slice(&escrow_bytes) else { return 0; };

    // 3. check_sequence
    if !check_sequence(&attest, &state) { return 0; }

    // 4. verify_oracle_quorum
    if !verify_oracle_quorum(&attest, &state) { return 0; }

    // 5. check_threshold
    if !check_threshold(&attest, &state) { return 0; }

    // 6. Update milestone
    state.current_milestone = attest.milestone_index;

    // 7. Record timestamp
    let idx = attest.milestone_index as usize;
    if idx < state.milestone_timestamps.len() {
        state.milestone_timestamps[idx] = host::current_ledger_time();
    }

    // 8. Persist updated state
    let Ok(encoded) = borsh::to_vec(&state) else { return 0; };
    host::set_escrow_data(&encoded);

    // 9. Success
    1
}
