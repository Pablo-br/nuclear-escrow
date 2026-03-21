import { useState, useEffect } from 'react';
import { useEscrowState } from './hooks/useEscrowState.ts';
import { useMilestoneHistory } from './hooks/useMilestoneHistory.ts';
import { SiteStatus } from './components/SiteStatus.tsx';
import { EscrowBalance } from './components/EscrowBalance.tsx';
import { MilestoneTimeline } from './components/MilestoneTimeline.tsx';
import { OracleHealth } from './components/OracleHealth.tsx';
import { AuditFeed } from './components/AuditFeed.tsx';
import { BankruptcyGuard } from './components/BankruptcyGuard.tsx';
import { TerminalModal } from './components/TerminalModal.tsx';
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

// Use relative paths — Vite proxies /state, /milestone, /deploy to localhost:3001
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

export default function App() {
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

  // Prefer on-chain siteState; fall back to server file state when master escrow is gone
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
      <header className="app-header">
        <span className="app-header__logo">☢ NuclearEscrow</span>
        <span className="app-header__badge">XRPL Testnet</span>
        <div className="app-header__spacer" />
        <a
          href={`https://testnet.xrpl.org/accounts/${escrowOwner}`}
          target="_blank"
          rel="noreferrer"
        >
          Explorer ↗
        </a>
      </header>

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
