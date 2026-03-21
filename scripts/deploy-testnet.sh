#!/bin/bash
set -e

# Run from the nuclear-escrow directory
cd "$(dirname "$0")/.."

TSX="cli/node_modules/.bin/tsx"

echo "=== [1/5] Build WASM ==="
bash scripts/build-wasm.sh

echo ""
echo "=== [2/5] Fund wallets ==="
$TSX contracts/src/setup-wallets.ts

echo ""
echo "=== [3/5] Init facility ==="
$TSX cli/init.ts --site=PLANT-FR-001 --liability=1000000

echo ""
echo "=== Waiting 35s for escrow FinishAfter to pass... ==="
sleep 35

echo "=== [4/5] Submit M0: reactor shutdown ==="
$TSX cli/submit-milestone.ts --phase=0

echo ""
echo "=== Waiting 35s for child escrow FinishAfter to pass... ==="
sleep 35

echo "=== [5/5] Submit M1: defueling ==="
$TSX cli/submit-milestone.ts --phase=1

echo ""
echo "=== Current state ==="
$TSX cli/inspect.ts

# Extract explorer URL from state
OPERATOR=$(node -e "const s=require('./.nuclear-state.json'); console.log(s.escrowOwner)" 2>/dev/null || echo "")
if [ -n "$OPERATOR" ]; then
  echo "Master escrow explorer: https://testnet.xrpl.org/accounts/${OPERATOR}"
fi
