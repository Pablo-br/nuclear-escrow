// ─── ContractTemplate ─────────────────────────────────────────────────────────
// Defined by the government. Describes the contract structure, metric type,
// fund split, and oracle requirements. Enterprises pick from available templates.

export interface ContractTemplate {
  id: string;
  name: string;                      // e.g., "CO2 Emissions Compliance"
  description: string;               // plain-language overview for enterprises
  industry: string;                  // e.g., "energy", "mining", "chemicals"
  metricType: string;                // machine key: "co2_tons", "radiation_usv", "wastewater_ppm"
  metricUnit: string;                // display unit: "tons CO2/month", "µSv/h", "mg/L"
  metricDescription: string;         // plain-language description used as Claude context
  complianceIsBelow: boolean;        // true = compliant when reading < threshold (default)
                                     // false = compliant when reading > threshold (e.g., energy produced)
  periods: number;                   // total number of compliance periods (e.g., 12 = 1 year monthly)
  periodLengthDays: number;          // length of each period (e.g., 30 for monthly)
  oracleCount: number;               // total oracle slots (default 5)
  quorumRequired: number;            // min oracles needed to attest (default 3)
  oracleCredentialType: string;      // XRPL credential type oracles must hold
  compliancePoolPct: number;         // % of total locked that can return to enterprise (0–100)
  penaltyPoolPct: number;            // % of total locked that goes to contractor on violation (0–100)
                                     // Note: compliancePoolPct + penaltyPoolPct should = 100
  periodDistribution: number[];      // per-period % of each pool (length = periods, must sum to 100)
  violationBehavior: 'period_slice' | 'full_pool' | 'configurable';
                                     // period_slice: only current period's allocation is forfeited
                                     // full_pool: entire penalty pool released on first violation
                                     // configurable: enterprise + government agree per-contract
  createdAt: string;                 // ISO timestamp
  createdBy: string;                 // government account / address
  governmentAddress?: string;        // XRPL address of the issuing government institution
  contractorAddress?: string;        // XRPL address of the contractor (penalty pool recipient)
}

// ─── ContractInstance ──────────────────────────────────────────────────────────
// Created when an enterprise picks a template and fills in their specifics.
// Stored server-side; escrow sequences are populated after on-chain deployment.

export interface ContractInstance {
  id: string;
  templateId: string;
  template: ContractTemplate;        // embedded snapshot at creation time

  // Parties
  enterpriseName: string;
  enterpriseAddress: string;         // XRPL address (funds locked by this wallet)
  contractorAddress: string;         // XRPL address (receives penalty pool on violation)
  regulatorAddress: string;          // XRPL address (issues credentials, signs receipts)

  // Financial terms
  totalLocked: string;               // RLUSD amount as string (e.g., "1000000")
  compliancePool: string;            // computed: totalLocked * compliancePoolPct / 100
  penaltyPool: string;               // computed: totalLocked * penaltyPoolPct / 100

  // Per-period metric thresholds (length = template.periods)
  thresholdPerPeriod: number[];

  // Configurable violation behavior (only if template.violationBehavior === 'configurable')
  agreedViolationBehavior?: 'period_slice' | 'full_pool';

  // Oracle configuration
  oraclePubkeys: string[];           // XRPL-format "ED" + 64hex per oracle
  domainId?: string;                 // XRPL Permissioned Domain ID (set after on-chain init)

  // On-chain state (populated after deployment)
  complianceEscrowSequence?: number; // master compliance escrow (destination = enterprise)
  penaltyEscrowSequence?: number;    // master penalty escrow (destination = contractor)
  complianceChildEscrows?: number[]; // one per period, indexed 0..periods-1
  penaltyChildEscrows?: number[];    // one per period, indexed 0..periods-1

  // Runtime state
  currentPeriod: number;             // 0-based, incremented after each period closes
  periodResults: PeriodResult[];     // history of completed periods
  status: 'negotiating' | 'active' | 'complete' | 'cancelled';
  createdAt: string;
  activatedAt?: string;              // when escrows were deployed on-chain

  // Mock oracle simulation (generated at contract signing time)
  mockScenarios?: MockScenario[];
  oraclePool?: OracleConfig[];
  activeScenario?: 'all-compliant' | 'all-violation' | 'mixed';

  // Hook-gated permit system
  hookDeployed?: boolean;                                  // true once SetHook tx confirmed
  // Permit state lives on-chain in the Hook's namespace — query via XRPL ledger_entry
}

// ─── PeriodResult ─────────────────────────────────────────────────────────────
// Recorded after each period closes (oracle attestation submitted + escrow finished).

export interface PeriodResult {
  periodIndex: number;               // 0-based
  verdict: 'compliant' | 'violation';
  metricValue: number;               // the reading that was attested
  threshold: number;                 // what the threshold was for this period
  oracleCount: number;               // how many oracles attested
  txHash: string;                    // EscrowFinish transaction hash
  amountReleased: string;            // RLUSD released this period
  releasedTo: 'enterprise' | 'contractor';
  claudeExplanation: string;         // Claude's compliance verdict explanation
  timestamp: string;                 // ISO timestamp
}

// ─── ComplianceVerdict ────────────────────────────────────────────────────────
// Returned by Claude's evaluateCompliance function each period.

export interface ComplianceVerdict {
  verdict: 'compliant' | 'violation';
  confidence: number;                // 0–1
  explanation: string;               // plain-language explanation of the verdict
  recommendedAction: string;         // what should happen next (release compliance or penalty escrow)
  details: {
    metricValue: number;
    threshold: number;
    metricUnit: string;
    complianceIsBelow: boolean;
    periodIndex: number;
  };
}

// ─── WalletSession ────────────────────────────────────────────────────────────
// Derived from a seed on the server — never contains the seed itself.

export interface WalletSession {
  address: string;
  classicAddress: string;
  publicKey: string;
}

// ─── OnChainEscrow ────────────────────────────────────────────────────────────
// Represents a single EscrowObject returned from account_objects on XRPL.

export interface OnChainEscrow {
  index: string;
  Account: string;
  Destination: string;
  Amount: string;
  FinishAfter?: number;
  CancelAfter?: number;
  Memos?: Array<{ Memo: { MemoType?: string; MemoData?: string } }>;
}

// ─── MockScenario ─────────────────────────────────────────────────────────────
// One of three oracle data scenarios auto-generated at contract creation time.

export interface MockScenario {
  name: 'all-compliant' | 'all-violation' | 'mixed';
  label: string;
  periodReadings: number[];
}

// ─── OracleConfig ─────────────────────────────────────────────────────────────
// Per-oracle configuration in the simulated oracle pool.

export interface OracleConfig {
  index: number;
  byzantineProbability: number;  // 0.0–1.0 chance of reporting opposite of true data
}

// ─── SimulatedOracleVote ──────────────────────────────────────────────────────

export interface SimulatedOracleVote {
  oracleIndex: number;
  reportedReading: number;
  vote: 'compliant' | 'violation';
  byzantine: boolean;
}

// ─── SimulatePeriodResult ─────────────────────────────────────────────────────

export interface SimulatePeriodResult {
  periodIndex: number;
  trueReading: number;
  truelyCompliant: boolean;
  oracleVotes: SimulatedOracleVote[];
  compliantVotes: number;
  violationVotes: number;
  consensus: 'compliant' | 'violation' | 'no-consensus';
  quorumRequired: number;
}

// ─── OracleAttestation (input to evaluateCompliance) ─────────────────────────

export interface OraclePeriodData {
  oracleIndex: number;
  oracleAddress: string;
  metricValue: number;
  metricUnit: string;
  timestamp: number;                 // Unix ms
  signature?: string;                // hex Ed25519 signature (if available)
}
