export interface ContractCondition {
  phase: number;
  description: string;
  radiationThreshold: number;
}

export interface CycleEvent {
  timestamp: number;
  radiationLevel: number;
  threshold: number;
  passed: boolean;
  amountToCompany: number;
  amountToGovernment: number;
}

export interface Contract {
  id: string;
  facilityName: string;
  governmentWallet: string;
  companyWallet: string;
  totalAmount: number;
  durationYears: number;
  status: 'pending_acceptance' | 'active' | 'completed';
  currentPhase: number;
  
  fundsFrozen: number;
  fundsRecovered: number;
  fundsPenalized: number;
  
  conditions: ContractCondition[];
  history: CycleEvent[];
}

const now = Date.now();
const THIRTY_MINS = 30 * 60 * 1000;

export const MOCK_CONTRACTS: Contract[] = [
  {
    id: "CTR-FR-001",
    facilityName: "PLANT-FR-001",
    governmentWallet: "rGovT...XYZ",
    companyWallet: "rEmpres...ABC",
    totalAmount: 10000000,
    durationYears: 50,
    status: 'active',
    currentPhase: 2,
    fundsFrozen: 8000000,
    fundsRecovered: 1900000,
    fundsPenalized: 100000,
    conditions: [
      { phase: 0, description: "Defueling complete", radiationThreshold: 100 },
      { phase: 1, description: "Spent fuel removed", radiationThreshold: 10 },
      { phase: 2, description: "Primary circuit decontaminated", radiationThreshold: 1 },
      { phase: 3, description: "Reactor vessel dismantled", radiationThreshold: 0.5 },
      { phase: 4, description: "Building decontaminated", radiationThreshold: 0.1 },
      { phase: 5, description: "Waste shipped offsite", radiationThreshold: 0.1 },
      { phase: 6, description: "Site restored", radiationThreshold: 0.01 },
    ],
    history: [
      { timestamp: now - THIRTY_MINS * 3, radiationLevel: 0.8, threshold: 1.0, passed: true, amountToCompany: 50000, amountToGovernment: 0 },
      { timestamp: now - THIRTY_MINS * 2, radiationLevel: 1.2, threshold: 1.0, passed: false, amountToCompany: 0, amountToGovernment: 50000 },
      { timestamp: now - THIRTY_MINS * 1, radiationLevel: 0.9, threshold: 1.0, passed: true, amountToCompany: 50000, amountToGovernment: 0 },
    ]
  },
  {
    id: "CTR-UK-005",
    facilityName: "PLANT-UK-005",
    governmentWallet: "rGovT...XYZ",
    companyWallet: "rEmpres...ABC",
    totalAmount: 25000000,
    durationYears: 30,
    status: 'pending_acceptance',
    currentPhase: 0,
    fundsFrozen: 0,
    fundsRecovered: 0,
    fundsPenalized: 0,
    conditions: [
      { phase: 0, description: "Defueling complete", radiationThreshold: 50 },
      { phase: 1, description: "Spent fuel removed", radiationThreshold: 5 },
    ],
    history: []
  }
];
