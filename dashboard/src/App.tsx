import { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Link, useParams } from 'react-router-dom';
import { useEscrowState } from './hooks/useEscrowState.ts';
import { useMilestoneHistory } from './hooks/useMilestoneHistory.ts';
import { SiteStatus } from './components/SiteStatus.tsx';
import { EscrowBalance } from './components/EscrowBalance.tsx';
import { MilestoneTimeline } from './components/MilestoneTimeline.tsx';
import { OracleHealth } from './components/OracleHealth.tsx';
import { AuditFeed } from './components/AuditFeed.tsx';
import { BankruptcyGuard } from './components/BankruptcyGuard.tsx';
import { TerminalModal } from './components/TerminalModal.tsx';
import { ComplianceDashboard } from './components/ComplianceDashboard.tsx';
import { GovernmentPortal } from './pages/GovernmentPortal.tsx';
import { EnterprisePortal } from './pages/EnterprisePortal.tsx';
import {
  MOCK_ORACLES,
  MOCK_YIELD_EARNED,
} from './mock-data.ts';

interface NuclearState {
  escrowOwner: string;
  escrowSequence: number;
  current_milestone: number;
  facilityId: string;
  childEscrows: number[];
}

const SERVER = '';
const isDemoMode = new URLSearchParams(window.location.search).get('demo') === '1';

const MILESTONE_NAMES = [
  'Reactor Shutdown',
  'Defueling',
  'Site Decontamination',
  'Waste Processing',
  'Infrastructure Removal',
  'Environmental Monitoring',
  'Site Release',
];

const FALLBACK_STATE: NuclearState = {
  escrowOwner: 'mock',
  escrowSequence: 0,
  current_milestone: 0,
  facilityId: 'PLANT-FR-001',
  childEscrows: [],
};

// ─── Nuclear Demo Dashboard ──────────────────────────────────────────────────

function NuclearDashboard() {
  const [nucState, setNucState] = useState<NuclearState | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);
  const [modalConfig, setModalConfig] = useState<{ url: string; title: string } | null>(null);
  const [milestoneRunning, setMilestoneRunning] = useState(false);
  const isRunning = modalConfig !== null || milestoneRunning;

  useEffect(() => {
    let active = true;
    let initialized = false;

    const loadState = () => {
      fetch(`${SERVER}/state`)
        .then(r => {
          if (!r.ok) throw new Error('not found');
          return r.json() as Promise<NuclearState>;
        })
        .then(data => {
          if (!active) return;
          setNucState(data);
          if (!initialized) { initialized = true; setStateLoaded(true); }
        })
        .catch(() => {
          if (!active) return;
          if (!initialized) {
            initialized = true;
            setNucState(FALLBACK_STATE);
            setStateLoaded(true);
          }
        });
    };

    loadState();
    const id = setInterval(loadState, 4000);
    return () => { active = false; clearInterval(id); };
  }, []);

  const escrowOwner    = nucState?.escrowOwner    ?? 'mock';
  const escrowSequence = nucState?.escrowSequence ?? 0;
  const childEscrows   = nucState?.childEscrows   ?? [];

  const { siteState, escrowBalance, loading } = useEscrowState(escrowOwner, escrowSequence, childEscrows);
  const { milestones } = useMilestoneHistory(escrowOwner);

  const currentMilestone = siteState?.current_milestone ?? nucState?.current_milestone ?? 0;

  const handleStartDemo = () =>
    setModalConfig({ url: `${SERVER}/deploy`, title: 'Full Reset — Funding wallets & deploying escrow…' });

  const handleNextStep = () => {
    setMilestoneRunning(true);
    fetch(`${SERVER}/milestone/${currentMilestone}`, { method: 'POST' })
      .finally(() => setMilestoneRunning(false));
  };

  const handleModalClose = () => setModalConfig(null);

  if (!stateLoaded) {
    return (
      <div className="loading-msg" style={{ paddingTop: '80px' }}>
        Connecting…
      </div>
    );
  }

  return (
    <>
      {isDemoMode && (
        <div className="demo-bar">
          <span className="demo-bar__label">Demo controls</span>
          <button className="demo-btn" onClick={handleStartDemo} disabled={isRunning}>
            Start Demo
          </button>
          {currentMilestone <= 6 ? (
            <button
              className="demo-btn demo-btn--primary"
              onClick={handleNextStep}
              disabled={isRunning}
            >
              Next Step: M{currentMilestone} — {MILESTONE_NAMES[currentMilestone]}
            </button>
          ) : (
            <span className="demo-bar__done">Demo Complete ✓</span>
          )}
        </div>
      )}

      <div className="app-grid">
        <SiteStatus siteState={siteState} />

        <div className="app-row app-row--2col">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <EscrowBalance
              balance={loading ? '0' : escrowBalance}
              yieldEarned={MOCK_YIELD_EARNED}
            />
            <OracleHealth oracles={MOCK_ORACLES} />
          </div>
          <MilestoneTimeline
            currentMilestone={currentMilestone}
            milestoneHistory={milestones}
          />
        </div>

        <AuditFeed escrowOwner={escrowOwner} />
        <BankruptcyGuard />
      </div>

      {modalConfig && (
        <TerminalModal
          url={modalConfig.url}
          title={modalConfig.title}
          onClose={handleModalClose}
        />
      )}
    </>
  );
}

// ─── Contract page wrapper ────────────────────────────────────────────────────

function ContractPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <div className="alert alert--error">No contract ID provided</div>;
  return <ComplianceDashboard contractId={id} />;
}

// ─── App shell ────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <BrowserRouter>
      <header className="app-header">
        <Link to="/" className="app-header__logo">☢ NuclearEscrow</Link>
        <span className="app-header__badge">XRPL Testnet</span>
        <nav className="app-header__nav">
          <Link to="/">Nuclear Demo</Link>
          <Link to="/government">Government</Link>
          <Link to="/enterprise">Enterprise</Link>
        </nav>
        <div className="app-header__spacer" />
      </header>

      <Routes>
        <Route path="/" element={<NuclearDashboard />} />
        <Route path="/government" element={<GovernmentPortal />} />
        <Route path="/enterprise" element={<EnterprisePortal />} />
        <Route path="/contract/:id" element={<ContractPage />} />
      </Routes>
    </BrowserRouter>
  );
}
