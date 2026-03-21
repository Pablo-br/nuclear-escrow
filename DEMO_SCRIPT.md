# NuclearEscrow — Demo Script (4 minutes)

## Setup (before entering the room)
- Run: bash scripts/reset-demo.sh && bash scripts/deploy-testnet.sh
- Start dashboard: cd dashboard && npm run dev & npx tsx server.ts &
- Open browser to: http://localhost:5173?demo=1
- Have XRPL explorer open to the master escrow

## Live demo steps

**[0:00] Show the problem (30 seconds)**
"Every nuclear plant must set aside a decommissioning fund.
 France: €23Bn set aside against €74Bn needed.
 UK: up to £232Bn in liabilities.
 The money keeps disappearing. NuclearEscrow makes that structurally impossible."

**[0:30] Show the dashboard (45 seconds)**
- Point to EscrowBalance: "847 million RLUSD locked on-chain. The operator cannot touch it."
- Point to SiteStatus: "PLANT-FR-001, pre-decommission phase."
- Point to OracleHealth: "5 independent radiation monitoring oracles, all live."
- Point to MilestoneTimeline: "6 phases. Each phase gates the next. Each releases funds only on verified physical evidence."

**[1:15] Run Milestone 0 (60 seconds)**
- Press ENTER on run-demo.sh or click "Run M0" on dashboard
- Walk through the output as it prints:
  "Radiation sensor reading: 82 uSv/h — below the 100 threshold"
  "Oracles 0, 1, 2 independently sign the attestation"
  "EscrowFinish submitted to XRPL"
  "WASM executes on-chain: sequence check ✓, quorum check ✓, threshold check ✓"
  "Returns 1 — milestone complete"

**[2:15] Show bankruptcy protection (30 seconds)**
- Click "Simulate operator bankruptcy" on the dashboard
- "The operator just filed for bankruptcy. Watch the escrow balance."
- Show: balance unchanged
- "A bankruptcy court has no more claim on these funds than it has on a deployed satellite. The code is the custodian."

**[3:00] Run Milestone 1 (45 seconds)**
- Press ENTER or click "Run M1"
- "Defueling verified. 15% of the fund — 127 million RLUSD — releases directly to the certified contractor."
- Show contractor wallet balance update
- Show MPT receipt in contractor wallet

**[3:45] Close (15 seconds)**
"The escrow knows the site is safe. It does not trust the operator. It trusts the physics.
 When the work is done, the money flows. When it is not done, nothing moves."
