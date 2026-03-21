#!/bin/bash
set -e

# Run from the nuclear-escrow directory
cd "$(dirname "$0")/.."

TSX="cli/node_modules/.bin/tsx"

echo "=== [1/4] Build WASM ==="
bash scripts/build-wasm.sh

echo ""
echo "=== [2/4] Fund wallets ==="
$TSX contracts/src/setup-wallets.ts

echo ""
echo "=== [3/4] Init facility ==="
$TSX cli/init.ts --site=PLANT-FR-001 --liability=847000000

echo ""
echo "=== Waiting 35s for master escrow FinishAfter to pass... ==="
sleep 35

echo ""
echo "=== [4/4] Final state ==="
$TSX cli/inspect.ts

# Extract explorer URL from state
OPERATOR=$(node -e "const s=require('./.nuclear-state.json'); console.log(s.escrowOwner)" 2>/dev/null || echo "")
if [ -n "$OPERATOR" ]; then
  echo ""
  echo "Master escrow explorer: https://testnet.xrpl.org/accounts/${OPERATOR}"
fi

echo ""
echo "=== READY: escrow live, M0 available ==="
echo "Run: bash scripts/run-demo.sh"
