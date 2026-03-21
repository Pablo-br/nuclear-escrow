import { useState } from 'react';

const TRADITIONAL = [
  'Funds held in operator treasury',
  'Creditors can seize funds in bankruptcy',
  'Cleanup stops — legal battles for years',
  'Taxpayer inherits liability',
  'No audit trail',
];

const NUCLEAR_ESCROW = [
  'Funds locked in WASM escrow on-chain',
  'Structurally inaccessible to creditors',
  'Cleanup continues with new contractor',
  'Funds wait for next verified milestone',
  'Every action permanently on-chain',
];

type SimState = 'idle' | 'shaking' | 'resolved';

export function BankruptcyGuard() {
  const [simState, setSimState] = useState<SimState>('idle');

  const handleSimulate = () => {
    if (simState !== 'idle') return;
    setSimState('shaking');

    // After 1.5s: fade overlay, show result
    setTimeout(() => {
      setSimState('resolved');
    }, 1500);
  };

  return (
    <div className="card bankruptcy-guard">
      <div className="card-header">
        <h2>Bankruptcy Protection</h2>
        <span className="badge badge--red">Structural Guarantee</span>
      </div>
      <div className="card-body">
        <div className="bankruptcy-guard__compare">
          <div className="compare-col compare-col--bad">
            <div className="compare-col__title">Traditional system</div>
            <ul className="compare-col__list">
              {TRADITIONAL.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="compare-col compare-col--good">
            <div className="compare-col__title">NuclearEscrow</div>
            <ul className="compare-col__list">
              {NUCLEAR_ESCROW.map(item => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        {simState === 'idle' && (
          <button className="bankruptcy-guard__btn" onClick={handleSimulate}>
            Simulate operator bankruptcy
          </button>
        )}

        {simState === 'shaking' && (
          <div className="bankruptcy-guard__overlay">
            <div className="bankruptcy-guard__overlay-text">
              BANKRUPTCY FILED
            </div>
          </div>
        )}

        {simState === 'resolved' && (
          <>
            <button
              className="bankruptcy-guard__btn"
              onClick={() => setSimState('idle')}
              style={{ marginBottom: '12px', opacity: 0.7 }}
            >
              Reset simulation
            </button>
            <div className="bankruptcy-guard__result">
              <div className="bankruptcy-guard__result-title">
                Escrow balance: UNCHANGED — 847,500,000 RLUSD protected by WASM
              </div>
              <div className="bankruptcy-guard__result-body">
                Cleanup proceeds. New contractor can be certified within 24h.
                Funds remain locked until the next verified milestone — no court order
                can touch them.
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
