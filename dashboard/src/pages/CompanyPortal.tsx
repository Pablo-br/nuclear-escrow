import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { ContractTemplate, WalletSession } from '../../../shared/src/contract-template.js';
import { WalletConnect } from '../components/WalletConnect.tsx';
import { ActiveHooksPanel } from '../components/ActiveHooksPanel.tsx';

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 'connect' | 'find' | 'configure' | 'hooks';

interface SignResult {
  contractId: string;
  periodicTxHashes: string[];
  bonusTxHash: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RIPPLE_EPOCH = 946684800;

function dropsToXrp(drops: number): string {
  return (drops / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function deadlineDate(i: number, periodLengthDays: number): string {
  const now = Date.now() / 1000;
  const rippleTs = now - RIPPLE_EPOCH + (i + 1) * periodLengthDays * 86400;
  return new Date((rippleTs + RIPPLE_EPOCH) * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function FormRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="form-row">
      <label className="form-row__label">
        {label}
        {hint && <span className="form-row__hint">{hint}</span>}
      </label>
      {children}
    </div>
  );
}

// ─── CompanyPortal ───────────────────────────────────────────────────────────

export function CompanyPortal() {
  const [step, setStep] = useState<Step>('connect');
  const [session, setSession] = useState<WalletSession | null>(null);
  const [seed, setSeed] = useState('');

  // Find regulator
  const [regulatorPubkey, setRegulatorPubkey] = useState('');
  const [regulatorAddress, setRegulatorAddress] = useState('');
  const [regulatorTemplates, setRegulatorTemplates] = useState<ContractTemplate[]>([]);
  const [findingRegulator, setFindingRegulator] = useState(false);

  // Configure contract
  const [selectedTemplate, setSelectedTemplate] = useState<ContractTemplate | null>(null);
  const [totalDrops, setTotalDrops] = useState('');
  const [thresholds, setThresholds] = useState<number[]>([]);
  const [signing, setSigning] = useState(false);
  const [signResult, setSignResult] = useState<SignResult | null>(null);

  const [error, setError] = useState('');

  // ── Derived ────────────────────────────────────────────────────────────────

  const drops = Number(totalDrops) || 0;
  const periodicDrops = selectedTemplate ? Math.floor(drops * selectedTemplate.compliancePoolPct / 100) : 0;
  const bonusDrops = drops - periodicDrops;
  const sliceDrops = selectedTemplate ? Math.floor(periodicDrops / selectedTemplate.periods) : 0;

  // ── Find regulator ─────────────────────────────────────────────────────────

  const handleFindRegulator = async () => {
    if (!regulatorPubkey.trim()) return;
    setFindingRegulator(true);
    setError('');
    setRegulatorTemplates([]);
    try {
      const addrResp = await fetch(`/xrpl/address-from-pubkey/${regulatorPubkey.trim()}`);
      if (!addrResp.ok) {
        const err = await addrResp.json() as { error: string };
        throw new Error(err.error ?? 'Invalid public key');
      }
      const { address } = await addrResp.json() as { address: string };
      setRegulatorAddress(address);

      const tplResp = await fetch(`/regulator/${address}/templates`);
      if (!tplResp.ok) throw new Error('Could not fetch templates');
      const data = await tplResp.json() as { local: ContractTemplate[] };
      if (!data.local?.length) {
        setError('No templates found for this regulator. Make sure the regulator has published templates.');
      }
      setRegulatorTemplates(data.local ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFindingRegulator(false);
    }
  };

  const selectTemplate = (t: ContractTemplate) => {
    setSelectedTemplate(t);
    setThresholds(Array(t.periods).fill(100));
    setStep('configure');
  };

  // ── Sign contract ──────────────────────────────────────────────────────────

  const handleSign = async () => {
    if (!session || !seed || !selectedTemplate || !drops) return;
    setSigning(true);
    setError('');
    try {
      const resp = await fetch('/contracts/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seed,
          templateId: selectedTemplate.id,
          regulatorAddress,
          totalDrops: drops,
          thresholds,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json() as { error: string };
        throw new Error(err.error ?? 'Sign failed');
      }
      const result = await resp.json() as SignResult;
      setSignResult(result);
      setStep('hooks');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };

  // ── Step nav ───────────────────────────────────────────────────────────────

  const stepDone = (s: Step): boolean => {
    const order: Step[] = ['connect', 'find', 'configure', 'hooks'];
    return order.indexOf(s) < order.indexOf(step);
  };

  const goTo = (s: Step) => {
    if (s === 'connect') { setStep(s); return; }
    if (!session) return;
    if (s === 'find' || s === 'configure') setStep(s);
    if (s === 'hooks') setStep(s);
  };

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="portal-page">
      <div className="portal-header">
        <h1>Company Portal</h1>
        <p className="portal-subtitle">Find a regulator, sign a compliance contract, and lock escrow on XRPL</p>
      </div>

      {/* Step indicator */}
      <div className="steps-bar">
        {(['connect', 'find', 'configure', 'hooks'] as Step[]).map((s, i, arr) => (
          <>
            <button
              key={s}
              className={`step ${step === s ? 'step--active' : stepDone(s) ? 'step--done' : ''}`}
              style={{ cursor: session || s === 'connect' ? 'pointer' : 'default', border: 'none' }}
              onClick={() => goTo(s)}
            >
              {i + 1} · {s === 'connect' ? 'Connect' : s === 'find' ? 'Find Regulator' : s === 'configure' ? 'Configure' : 'My Hooks'}
            </button>
            {i < arr.length - 1 && <span className="step-arrow">→</span>}
          </>
        ))}
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {/* ── Step 1: Connect ─────────────────────────────────────────────────── */}
      {step === 'connect' && (
        <div className="portal-card">
          <h2>Connect Company Wallet</h2>
          <p className="field-hint">Enter your XRPL seed to derive your company address and sign contracts.</p>
          <WalletConnect
            label="Company Wallet"
            onConnect={(s, k) => { setSession(s); setSeed(k); setStep('find'); }}
            connected={session}
          />
        </div>
      )}

      {/* ── Step 2: Find Regulator ───────────────────────────────────────────── */}
      {step === 'find' && session && (
        <div className="portal-card">
          <div className="portal-card__header">
            <h2>Find Regulator</h2>
            <WalletConnect label="Company Wallet" onConnect={() => {}} connected={session} />
          </div>

          <FormRow label="Regulator Public Key" hint="The regulator's XRPL public key (ED… hex)">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="portal-input"
                value={regulatorPubkey}
                onChange={e => setRegulatorPubkey(e.target.value)}
                placeholder="ED…"
                onKeyDown={e => { if (e.key === 'Enter') handleFindRegulator(); }}
              />
              <button
                className="portal-btn portal-btn--primary"
                onClick={handleFindRegulator}
                disabled={findingRegulator || !regulatorPubkey.trim()}
                style={{ flexShrink: 0 }}
              >
                {findingRegulator ? 'Searching…' : 'Search'}
              </button>
            </div>
          </FormRow>

          {regulatorAddress && (
            <div className="alert alert--success" style={{ marginBottom: 12 }}>
              Regulator address: <code>{regulatorAddress}</code>
            </div>
          )}

          {regulatorTemplates.length > 0 && (
            <>
              <div className="form-section-title">Available Templates</div>
              <div className="template-grid">
                {regulatorTemplates.map(t => (
                  <div key={t.id} className="template-card" onClick={() => selectTemplate(t)}>
                    <div className="template-card__industry">{t.industry}</div>
                    <div className="template-card__name">{t.name}</div>
                    <div className="template-card__desc">{t.description}</div>
                    <div className="template-card__meta">
                      <span>{t.periods} periods</span>
                      <span>{t.periodLengthDays}d each</span>
                      <span>{t.oracleCount} oracles</span>
                      <span>M={t.quorumRequired}</span>
                      <span>{t.compliancePoolPct}% periodic</span>
                      <span>{t.penaltyPoolPct}% bonus</span>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <button className="portal-btn portal-btn--primary" style={{ fontSize: 13 }}>
                        Select Template
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Step 3: Configure Contract ──────────────────────────────────────── */}
      {step === 'configure' && session && selectedTemplate && (
        <div className="portal-card">
          <div className="portal-card__header">
            <h2>Configure Contract</h2>
            <button className="portal-btn portal-btn--ghost" onClick={() => setStep('find')}>← Back</button>
          </div>

          {/* Template summary */}
          <div className="template-badge">
            {selectedTemplate.industry} · {selectedTemplate.name}
          </div>
          <div className="template-summary">
            <div className="template-summary__row"><span>Metric</span><span>{selectedTemplate.metricUnit}</span></div>
            <div className="template-summary__row"><span>Periods</span><span>{selectedTemplate.periods} × {selectedTemplate.periodLengthDays} days</span></div>
            <div className="template-summary__row"><span>Oracles</span><span>{selectedTemplate.oracleCount} oracles (quorum M={selectedTemplate.quorumRequired})</span></div>
            <div className="template-summary__row"><span>Per-period pool</span><span>{selectedTemplate.compliancePoolPct}% → returned to you each period</span></div>
            <div className="template-summary__row"><span>Bonus pool</span><span>{selectedTemplate.penaltyPoolPct}% → returned only if all periods compliant</span></div>
            <div className="template-summary__row"><span>Regulator</span><code style={{ fontSize: 11 }}>{regulatorAddress}</code></div>
          </div>

          {/* Deposit amount */}
          <FormRow label="Deposit Amount (XRP drops)" hint="Total escrow amount in drops (1 XRP = 1,000,000 drops)">
            <input
              className="portal-input"
              type="number"
              min={0}
              value={totalDrops}
              onChange={e => setTotalDrops(e.target.value)}
              placeholder="e.g. 10000000 (= 10 XRP)"
            />
            {drops > 0 && (
              <div style={{ fontSize: 12, color: 'var(--c-muted)', marginTop: 4 }}>
                = {dropsToXrp(drops)} XRP total · {dropsToXrp(sliceDrops)} XRP/period · {dropsToXrp(bonusDrops)} XRP bonus
              </div>
            )}
          </FormRow>

          {/* Fund split preview */}
          {drops > 0 && (
            <div className="fund-split-preview">
              <div className="fund-split-preview__title">Fund Split</div>
              <div className="fund-split-preview__bar">
                <div className="fund-split-preview__compliance" style={{ width: `${selectedTemplate.compliancePoolPct}%` }}>
                  {selectedTemplate.compliancePoolPct}% periodic ({dropsToXrp(periodicDrops)} XRP)
                </div>
                <div className="fund-split-preview__penalty" style={{ width: `${selectedTemplate.penaltyPoolPct}%` }}>
                  {selectedTemplate.penaltyPoolPct}% bonus ({dropsToXrp(bonusDrops)} XRP)
                </div>
              </div>
            </div>
          )}

          {/* Period breakdown table */}
          <div className="form-section-title">Period Breakdown & Thresholds</div>
          <table className="period-breakdown-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Weight</th>
                <th>Drops</th>
                <th>Deadline</th>
                <th>Threshold ({selectedTemplate.metricUnit})</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: selectedTemplate.periods }, (_, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>Period {i + 1}</td>
                  <td>{selectedTemplate.periodDistribution[i] ?? Math.floor(100 / selectedTemplate.periods)}%</td>
                  <td className="hooks-panel__amount">{drops > 0 ? sliceDrops.toLocaleString() : '—'}</td>
                  <td className="hooks-panel__deadline">{deadlineDate(i, selectedTemplate.periodLengthDays)}</td>
                  <td>
                    <input
                      className="portal-input"
                      type="number"
                      style={{ width: 100 }}
                      value={thresholds[i] ?? 100}
                      onChange={e => {
                        const next = [...thresholds];
                        next[i] = Number(e.target.value);
                        setThresholds(next);
                      }}
                    />
                  </td>
                </tr>
              ))}
              <tr style={{ background: 'var(--c-amber-dim)' }}>
                <td colSpan={2} style={{ fontWeight: 600 }}>Bonus Escrow</td>
                <td className="hooks-panel__amount">{drops > 0 ? bonusDrops.toLocaleString() : '—'}</td>
                <td className="hooks-panel__deadline">{deadlineDate(selectedTemplate.periods, selectedTemplate.periodLengthDays)}</td>
                <td style={{ fontSize: 12, color: 'var(--c-muted)' }}>All periods compliant</td>
              </tr>
            </tbody>
          </table>

          <div
            className="banner banner--warn"
            style={{ marginTop: 12 }}
          >
            Signing creates {selectedTemplate.periods + 1} EscrowCreate transactions on XRPL. Each period escrow will be resolvable by oracle consensus after its deadline. The bonus escrow resolves only if all periods were compliant.
          </div>

          <div className="portal-actions">
            <button
              className="portal-btn portal-btn--primary"
              onClick={handleSign}
              disabled={signing || !drops || drops <= 0}
            >
              {signing ? 'Signing & Creating Escrows…' : `Sign Contract (${selectedTemplate.periods + 1} escrows)`}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: My Hooks ────────────────────────────────────────────────── */}
      {step === 'hooks' && session && (
        <div className="portal-card">
          <h2>My Active Hooks</h2>

          {signResult && (
            <div className="alert alert--success" style={{ marginBottom: 16 }}>
              Contract signed! <strong>{signResult.periodicTxHashes.length} period escrows</strong> + 1 bonus escrow created.
              {' '}<Link to={`/contract/${signResult.contractId}`} style={{ color: 'var(--c-teal)', fontWeight: 600 }}>
                View Compliance Dashboard →
              </Link>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--c-muted)' }}>
                Contract ID: <code>{signResult.contractId}</code>
              </div>
            </div>
          )}

          <p className="field-hint">All unresolved escrow objects on your company account.</p>
          <ActiveHooksPanel address={session.address} />
        </div>
      )}
    </div>
  );
}
