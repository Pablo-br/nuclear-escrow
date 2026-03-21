// ─── Shared types (browser-compatible, mirrors shared/src/types.ts) ─────────

export interface SiteState {
  current_milestone: number;
  oracle_pubkeys: Uint8Array[];
  thresholds: number[];
  domain_id: Uint8Array;
  facility_id: Uint8Array;
  milestone_timestamps: number[];
}

export interface OracleNode {
  index: number;
  address: string;
  status: 'online' | 'offline';
  lastAttestationMinutesAgo: number;
  contributedToLastQuorum: boolean;
}

export interface MilestoneEvent {
  index: number;
  txHash: string;
  timestamp: number;
  rlusdReleased: string;
  radiationReading: number;
  oracleIds: string[];
}

export interface AuditEvent {
  timestamp: number;
  eventType: string;
  detail: string;
  txHash: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function facilityIdBytes(id: string): Uint8Array {
  const enc = new TextEncoder().encode(id);
  const out = new Uint8Array(16);
  out.set(enc);
  return out;
}

// ─── Mock values ─────────────────────────────────────────────────────────────

const now = Date.now();

export const MOCK_SITE_STATE: SiteState = {
  current_milestone: 1,
  oracle_pubkeys: Array.from({ length: 5 }, () => new Uint8Array(32)),
  thresholds: [100, 10, 1, 0.5, 0.1, 0.1, 0.01],
  domain_id: new Uint8Array(32),
  facility_id: facilityIdBytes('PLANT-FR-001'),
  milestone_timestamps: [
    Math.floor((now - 3_600_000) / 1000),
    Math.floor((now - 1_800_000) / 1000),
    0, 0, 0, 0, 0,
  ],
};

export const MOCK_ORACLES: OracleNode[] = [
  { index: 0, address: 'rENmdoPHymtg6cQd7aY5QF6fwCn2vaBkc1', status: 'online', lastAttestationMinutesAgo: 2,  contributedToLastQuorum: true  },
  { index: 1, address: 'rnb1oRpyA9K7rrdcQEBqMHSr7WezMmd23y', status: 'online', lastAttestationMinutesAgo: 2,  contributedToLastQuorum: true  },
  { index: 2, address: 'rnwbNAGRzizrPhvAzCaEi9b9Qzr4gN22Ni', status: 'online', lastAttestationMinutesAgo: 2,  contributedToLastQuorum: true  },
  { index: 3, address: 'rDvi2A2r4zW17TMmV4k931PsFxmfJ5DgCU', status: 'online', lastAttestationMinutesAgo: 3,  contributedToLastQuorum: false },
  { index: 4, address: 'rEyMbQyf3gXWvsmYoqeJ6nBwxN2bsX4eqY', status: 'online', lastAttestationMinutesAgo: 4,  contributedToLastQuorum: false },
];

export const MOCK_MILESTONE_HISTORY: MilestoneEvent[] = [
  {
    index: 0,
    txHash: '5A2213B10C09329FCA3368BA0C407EFF8F4898F2D7A646477DCE900A2E43EA32',
    timestamp: now - 3_600_000,
    rlusdReleased: '0',
    radiationReading: 95.2,
    oracleIds: ['rENmdoPHymtg6cQd7aY5QF6fwCn2vaBkc1', 'rnb1oRpyA9K7rrdcQEBqMHSr7WezMmd23y', 'rnwbNAGRzizrPhvAzCaEi9b9Qzr4gN22Ni'],
  },
  {
    index: 1,
    txHash: '33F953293CC6894348E9C8AB7F652B14A8E49AF55762AC0ECF74247E7D0E3DA3',
    timestamp: now - 1_800_000,
    rlusdReleased: '127125000',
    radiationReading: 8.4,
    oracleIds: ['rENmdoPHymtg6cQd7aY5QF6fwCn2vaBkc1', 'rnb1oRpyA9K7rrdcQEBqMHSr7WezMmd23y', 'rnwbNAGRzizrPhvAzCaEi9b9Qzr4gN22Ni'],
  },
];

export const MOCK_ESCROW_BALANCE = '847500000';
export const MOCK_YIELD_EARNED = '14250';

export const MOCK_AUDIT_EVENTS: AuditEvent[] = [
  {
    timestamp: now - 3_600_000,
    eventType: 'EscrowCreate',
    detail: 'Escrow created: 847,500,000 RLUSD locked',
    txHash: '5A2213B10C09329FCA3368BA0C407EFF8F4898F2D7A646477DCE900A2E43EA32',
  },
  {
    timestamp: now - 3_500_000,
    eventType: 'CredentialCreate',
    detail: 'Credential issued to raZyqRFkgURePRFL8hJwtEhoYQNPQe6j4H',
    txHash: 'B4E2D36C6E6C30F2D496AF8796183287807FF970138E6736AFD211C2E7E0D371',
  },
  {
    timestamp: now - 3_400_000,
    eventType: 'CredentialCreate',
    detail: 'Credential issued to r9qXWsomR7SohBTGua9ntt7n4SCrE8NYFn',
    txHash: 'E5EC46085BAD41C0E2052BCFC0C89DA1EF2B2C39F1E859712EA984208762B330',
  },
  {
    timestamp: now - 1_800_000,
    eventType: 'EscrowFinish',
    detail: 'Milestone 1 COMPLETE — 127,125,000 RLUSD released',
    txHash: '33F953293CC6894348E9C8AB7F652B14A8E49AF55762AC0ECF74247E7D0E3DA3',
  },
];
