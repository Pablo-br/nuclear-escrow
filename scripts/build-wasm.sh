#!/usr/bin/env bash
set -e
cargo build --manifest-path wasm/Cargo.toml --target wasm32-unknown-unknown --release 2>&1
cp wasm/target/wasm32-unknown-unknown/release/nuclear_escrow_wasm.wasm contracts/wasm/finish.wasm
echo "WASM size: $(wc -c < contracts/wasm/finish.wasm) bytes"
