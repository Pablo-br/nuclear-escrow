#!/bin/bash
set -e

echo ""
echo "=========================================="
echo " NuclearEscrow Live Demo"
echo " XRPL Testnet — $(date)"
echo "=========================================="
echo ""

echo "--- Current state ---"
npx tsx cli/inspect.ts
echo ""
read -p ">>> Press ENTER to trigger MILESTONE 0: Reactor shutdown verified..."

echo ""
echo "--- Triggering M0: radiation sensors below 100 uSv/h ---"
npx tsx cli/submit-milestone.ts --phase=0
echo ""
read -p ">>> Press ENTER to trigger MILESTONE 1: Defueling complete..."

echo ""
echo "--- Triggering M1: fuel rods confirmed in dry cask storage ---"
npx tsx cli/submit-milestone.ts --phase=1
echo ""

echo "--- Final state ---"
npx tsx cli/inspect.ts

echo ""
echo "=========================================="
echo " DEMO COMPLETE"
echo " Open dashboard: http://localhost:5173?demo=1"
echo "=========================================="
