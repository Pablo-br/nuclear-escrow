#!/bin/bash
set -e
echo "=== Full reset including wallets ==="
rm -f .nuclear-state.json .env.testnet
bash scripts/deploy-testnet.sh
