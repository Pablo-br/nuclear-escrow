import { useState, useEffect } from 'react';
import { useEscrowState } from './hooks/useEscrowState.ts';
import { useMilestoneHistory } from './hooks/useMilestoneHistory.ts';
import { SiteStatus } from './components/SiteStatus.tsx';
import { EscrowBalance } from './components/EscrowBalance.tsx';
import { MilestoneTimeline } from './components/MilestoneTimeline.tsx';
import { OracleHealth } from './components/OracleHealth.tsx';
import { AuditFeed } from './components/AuditFeed.tsx';
import { BankruptcyGuard } from './components/BankruptcyGuard.tsx';
import {
  MOCK_ORACLES,
  MOCK_YIELD_EARNED,
} from './mock-data.ts';

interface NuclearState {
  escrowOwner: string;
  escrowSequence: number;
}

// Use relative paths — Vite proxies /state and /milestone to localhost:3001
const SERVER = '';
const isDemoMode = new URLSearchParams(window.location.search).get('demo') === '1';

export default function App() {
  const [nucState, setNucState] = useState<NuclearState | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);

  useEffect(() => {
    fetch(`${SERVER}/state`)
      .then(r => {
        if (!r.ok) throw new Error('not found');
        return r.json() as Promise<NuclearState>;
      })
      .then(data => {
        setNucState(data);
        setStateLoaded(true);
      })
      .catch(() => {
        setNucState({ escrowOwner: 'mock', escrowSequence: 0 });
        setStateLoaded(true);
      });
  }, []);

  const escrowOwner    = nucState?.escrowOwner    ?? 'mock';
  const escrowSequence = nucState?.escrowSequence ?? 0;

  const { siteState, escrowBalance, loading } = useEscrowState(escrowOwner, escrowSequence);
  const { milestones } = useMilestoneHistory(escrowOwner);

  const currentMilestone = siteState?.current_milestone ?? 1;

  const runMilestone = async (phase: number) => {
    const resp = await fetch(`${SERVER}/milestone/${phase}`, { method: 'POST' });
    const text = await resp.text();
    console.log(`[demo] milestone ${phase}:`, text);
  };

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
          <button className="demo-btn" onClick={() => void runMilestone(0)}>Run M0</button>
          <button className="demo-btn" onClick={() => void runMilestone(1)}>Run M1</button>
          <button className="demo-btn" onClick={() => void runMilestone(2)}>Run M2</button>
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
    </>
  );
}
