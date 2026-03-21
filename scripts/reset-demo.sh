#!/bin/bash
set -e
echo "=== Resetting demo state ==="
rm -f .nuclear-state.json
echo "Cleared .nuclear-state.json"
echo "Run deploy-testnet.sh to rebuild from scratch"
