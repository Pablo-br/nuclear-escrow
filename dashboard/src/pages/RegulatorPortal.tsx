import { useState, useEffect } from 'react';
import type { ContractTemplate, WalletSession } from '../../../shared/src/contract-template.js';
import { WalletConnect } from '../components/WalletConnect.tsx';
import { ActiveHooksPanel } from '../components/ActiveHooksPanel.tsx';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PeriodRow {
  threshold: number;
  proportion: number;
  direction: 'below' | 'above';
}

type Step = 'connect' | 'create' | 'templates' | 'contracts';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDistribution(periods: number): number[] {
  const even = Math.floor(100 / periods);
  const rem = 100 - even * periods;
  return Array.from({ length: periods }, (_, i) => (i < rem ? even + 1 : even));
}

function autoDistribute(count: number): PeriodRow[] {
  const even = Math.floor(100 / Math.max(count, 1));
  const rem = 100 - even * count;
  return Array.from({ length: count }, (_, i) => ({
    threshold: 100,
    proportion: i < rem ? even + 1 : even,
    direction: 'below' as const,
  }));
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

// ─── RegulatorPortal ─────────────────────────────────────────────────────────

export function RegulatorPortal() {
  const [step, setStep] = useState<Step>('connect');
  const [session, setSession] = useState<WalletSession | null>(null);
  const [seed, setSeed] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [publishResult, setPublishResult] = useState<{ txHash: string | null; id: string } | null>(null);

  // Create template state
  const [tplName, setTplName] = useState('');
  const [tplDescription, setTplDescription] = useState('');
  const [tplIndustry, setTplIndustry] = useState('energy');
  const [tplMetricType, setTplMetricType] = useState('co2_tons');
  const [tplMetricUnit, setTplMetricUnit] = useState('tons CO2/month');
  const [tplMetricDesc, setTplMetricDesc] = useState('');
  const [tplPeriodLengthDays, setTplPeriodLengthDays] = useState(30);
  const [tplOracleCount, setTplOracleCount] = useState(5);
  const [tplQuorum, setTplQuorum] = useState(3);
  const [tplCompliancePoolPct, setTplCompliancePoolPct] = useState(70);
  const [tplPenaltyPoolPct, setTplPenaltyPoolPct] = useState(30);
  const [tplContractorAddress, setTplContractorAddress] = useState('');
  const [tplViolationBehavior, setTplViolationBehavior] = useState<ContractTemplate['violationBehavior']>('period_slice');
  const [periods, setPeriods] = useState<PeriodRow[]>(autoDistribute(3));

  // My templates state
  const [myTemplates, setMyTemplates] = useState<ContractTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const proportionSum = periods.reduce((s, p) => s + p.proportion, 0);

  // ── Period row helpers ─────────────────────────────────────────────────────

  const addPeriod = () => {
    const newCount = periods.length + 1;
    setPeriods(autoDistribute(newCount));
  };

  const removePeriod = (i: number) => {
    const next = periods.filter((_, idx) => idx !== i);
    if (next.length === 0) return;
    const total = next.reduce((s, p) => s + p.proportion, 0);
    const diff = 100 - total;
    const adjusted = [...next];
    adjusted[adjusted.length - 1] = {
      ...adjusted[adjusted.length - 1],
      proportion: adjusted[adjusted.length - 1].proportion + diff,
    };
    setPeriods(adjusted);
  };

  const updatePeriodField = <K extends keyof PeriodRow>(idx: number, key: K, value: PeriodRow[K]) => {
    setPeriods(prev => prev.map((row, i) => i === idx ? { ...row, [key]: value } : row));
  };

  // ── Fetch my templates ─────────────────────────────────────────────────────

  const fetchMyTemplates = () => {
    if (!session) return;
    setLoadingTemplates(true);
    fetch(`/regulator/${session.address}/templates`)
      .then(r => r.json() as Promise<{ local: ContractTemplate[] }>)
      .then(data => { setMyTemplates(data.local ?? []); })
      .catch(() => {})
      .finally(() => setLoadingTemplates(false));
  };

  useEffect(() => {
    if (step === 'templates') fetchMyTemplates();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, session]);

  // ── Publish template ───────────────────────────────────────────────────────

  const handlePublish = async () => {
    if (!session || !seed) return;
    if (proportionSum !== 100) { setError('Period proportions must sum to 100%'); return; }
    setSaving(true);
    setError('');
    setPublishResult(null);
    try {
      const now = new Date().toISOString();
      const id = `${tplMetricType.replace(/_/g, '-')}-${Date.now()}`;
      const template: ContractTemplate = {
        id,
        name: tplName,
        description: tplDescription,
        industry: tplIndustry,
        metricType: tplMetricType,
        metricUnit: tplMetricUnit,
        metricDescription: tplMetricDesc,
        complianceIsBelow: periods[0]?.direction === 'below',
        periods: periods.length,
        periodLengthDays: tplPeriodLengthDays,
        oracleCount: tplOracleCount,
        quorumRequired: tplQuorum,
        oracleCredentialType: tplMetricType,
        compliancePoolPct: tplCompliancePoolPct,
        penaltyPoolPct: tplPenaltyPoolPct,
        periodDistribution: makeDistribution(periods.length),
        violationBehavior: tplViolationBehavior,
        createdAt: now,
        createdBy: session.address,
        governmentAddress: session.address,
        contractorAddress: tplContractorAddress || undefined,
      };

      const resp = await fetch('/regulator/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed, template }),
      });
      if (!resp.ok) {
        const err = await resp.json() as { error: string };
        throw new Error(err.error ?? 'Publish failed');
      }
      const result = await resp.json() as { txHash: string | null; id: string };
      setPublishResult(result);
      setStep('templates');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Cancel template ────────────────────────────────────────────────────────

  const handleCancel = async (template: ContractTemplate) => {
    if (!session || !seed) return;
    setCancellingId(template.id);
    try {
      const numericId = parseInt(template.id.replace(/\D/g, '').slice(-8), 10) % 2147483647;
      const resp = await fetch(`/regulator/templates/${numericId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
      });
      if (!resp.ok) {
        const err = await resp.json() as { error: string };
        throw new Error(err.error ?? 'Cancel failed');
      }
      fetchMyTemplates();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCancellingId(null);
    }
  };

  // ── Step nav ───────────────────────────────────────────────────────────────

  const stepDone = (s: Step): boolean => {
    const order: Step[] = ['connect', 'create', 'templates', 'contracts'];
    return order.indexOf(s) < order.indexOf(step);
  };

  const goTo = (s: Step) => {
    if (s === 'connect') { setStep(s); return; }
    if (!session) return;
    setStep(s);
  };

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="portal-page">
      <div className="portal-header">
        <h1>Regulator Portal</h1>
        <p className="portal-subtitle">Publish compliance contract templates on XRPL</p>
      </div>

      {/* Step indicator */}
      <div className="steps-bar">
        {(['connect', 'create', 'templates', 'contracts'] as Step[]).map((s, i, arr) => (
          <>
            <button
              key={s}
              className={`step ${step === s ? 'step--active' : stepDone(s) ? 'step--done' : ''}`}
              style={{ cursor: session || s === 'connect' ? 'pointer' : 'default', border: 'none' }}
              onClick={() => goTo(s)}
            >
              {i + 1} · {s === 'connect' ? 'Connect' : s === 'create' ? 'Create Template' : s === 'templates' ? 'My Templates' : 'Active Hooks'}
            </button>
            {i < arr.length - 1 && <span className="step-arrow">→</span>}
          </>
        ))}
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {/* ── Step 1: Connect ─────────────────────────────────────────────────── */}
      {step === 'connect' && (
        <div className="portal-card">
          <h2>Connect Regulator Wallet</h2>
          <p className="field-hint">Enter your XRPL seed to derive your regulator address and sign templates.</p>
          <WalletConnect
            label="Regulator Wallet"
            onConnect={(s, k) => { setSession(s); setSeed(k); setStep('create'); }}
            connected={session}
          />
        </div>
      )}

      {/* ── Step 2: Create Template ─────────────────────────────────────────── */}
      {step === 'create' && session && (
        <div className="portal-card">
          <div className="portal-card__header">
            <h2>Create Contract Template</h2>
            <WalletConnect label="Regulator Wallet" onConnect={() => {}} connected={session} />
          </div>

          <div className="template-form">
            <FormRow label="Name" hint="Human-readable contract name">
              <input className="portal-input" value={tplName} onChange={e => setTplName(e.target.value)} placeholder="CO2 Emissions Compliance" />
            </FormRow>
            <FormRow label="Description" hint="Plain-language overview for companies">
              <textarea className="portal-input portal-input--textarea" rows={2} value={tplDescription} onChange={e => setTplDescription(e.target.value)} />
            </FormRow>

            <div className="form-row-group">
              <FormRow label="Industry">
                <select className="portal-input" value={tplIndustry} onChange={e => setTplIndustry(e.target.value)}>
                  {['energy','manufacturing','mining','chemicals','nuclear','agriculture','water','other'].map(v => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </FormRow>
              <FormRow label="Metric Type" hint="Machine key">
                <input className="portal-input" value={tplMetricType} onChange={e => setTplMetricType(e.target.value)} placeholder="co2_tons" />
              </FormRow>
              <FormRow label="Metric Unit" hint="Display unit">
                <input className="portal-input" value={tplMetricUnit} onChange={e => setTplMetricUnit(e.target.value)} placeholder="tons CO2/month" />
              </FormRow>
            </div>

            <FormRow label="Metric Description" hint="Plain-language description of what is measured">
              <input className="portal-input" value={tplMetricDesc} onChange={e => setTplMetricDesc(e.target.value)} />
            </FormRow>

            <div className="form-row-group">
              <FormRow label="Period Length (days)">
                <input className="portal-input" type="number" min={1} value={tplPeriodLengthDays} onChange={e => setTplPeriodLengthDays(Number(e.target.value))} />
              </FormRow>
              <FormRow label="Oracle Count">
                <input className="portal-input" type="number" min={1} max={10} value={tplOracleCount} onChange={e => setTplOracleCount(Number(e.target.value))} />
              </FormRow>
              <FormRow label="Quorum Required">
                <input className="portal-input" type="number" min={1} max={tplOracleCount} value={tplQuorum} onChange={e => setTplQuorum(Number(e.target.value))} />
              </FormRow>
            </div>

            <div className="form-row-group">
              <FormRow label="Per-period Pool %" hint="% returned to company per period if compliant">
                <input className="portal-input" type="number" min={0} max={100} value={tplCompliancePoolPct} onChange={e => { setTplCompliancePoolPct(Number(e.target.value)); setTplPenaltyPoolPct(100 - Number(e.target.value)); }} />
              </FormRow>
              <FormRow label="Bonus Pool %" hint="% only if ALL periods compliant">
                <input className="portal-input" type="number" min={0} max={100} value={tplPenaltyPoolPct} onChange={e => { setTplPenaltyPoolPct(Number(e.target.value)); setTplCompliancePoolPct(100 - Number(e.target.value)); }} />
              </FormRow>
              <FormRow label="Violation Behavior">
                <select className="portal-input" value={tplViolationBehavior} onChange={e => setTplViolationBehavior(e.target.value as ContractTemplate['violationBehavior'])}>
                  <option value="period_slice">Period slice only</option>
                  <option value="full_pool">Full pool released</option>
                  <option value="configurable">Configurable per contract</option>
                </select>
              </FormRow>
            </div>

            <FormRow label="Contractor XRPL Address" hint="Receives bonus pool on violation">
              <input className="portal-input" value={tplContractorAddress} onChange={e => setTplContractorAddress(e.target.value)} placeholder="rContractor…" />
            </FormRow>
          </div>

          {/* Fund split preview */}
          <div className="fund-split-preview">
            <div className="fund-split-preview__title">Fund Split Preview</div>
            <div className="fund-split-preview__bar">
              <div className="fund-split-preview__compliance" style={{ width: `${tplCompliancePoolPct}%` }}>
                {tplCompliancePoolPct}% periodic
              </div>
              <div className="fund-split-preview__penalty" style={{ width: `${tplPenaltyPoolPct}%` }}>
                {tplPenaltyPoolPct}% bonus
              </div>
            </div>
          </div>

          {/* ── Dynamic period rows ─────────────────────────────────────────── */}
          <div className="form-section-title" style={{ marginTop: 24 }}>
            Compliance Periods
            {proportionSum !== 100 && (
              <span style={{ color: 'var(--c-red)', marginLeft: 12, fontSize: 12, fontWeight: 400 }}>
                Proportions sum to {proportionSum}% (must be 100%)
              </span>
            )}
          </div>

          <table className="period-breakdown-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Threshold</th>
                <th>Direction</th>
                <th>Weight %</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {periods.map((row, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600, color: 'var(--c-navy)' }}>Period {i + 1}</td>
                  <td>
                    <input
                      className="portal-input"
                      type="number"
                      style={{ width: 100 }}
                      value={row.threshold}
                      onChange={e => updatePeriodField(i, 'threshold', Number(e.target.value))}
                    />
                    <span style={{ fontSize: 11, color: 'var(--c-muted)', marginLeft: 4 }}>{tplMetricUnit}</span>
                  </td>
                  <td>
                    <select
                      className="portal-input"
                      style={{ width: 160 }}
                      value={row.direction}
                      onChange={e => updatePeriodField(i, 'direction', e.target.value as 'below' | 'above')}
                    >
                      <option value="below">below threshold</option>
                      <option value="above">above threshold</option>
                    </select>
                  </td>
                  <td>
                    <input
                      className="portal-input"
                      type="number"
                      style={{ width: 70 }}
                      min={0}
                      max={100}
                      value={row.proportion}
                      onChange={e => updatePeriodField(i, 'proportion', Number(e.target.value))}
                    />
                  </td>
                  <td>
                    <button
                      className="portal-btn portal-btn--ghost"
                      style={{ padding: '2px 8px', fontSize: 12 }}
                      onClick={() => removePeriod(i)}
                      disabled={periods.length <= 1}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button className="portal-btn portal-btn--ghost" style={{ marginTop: 8 }} onClick={addPeriod}>
            + Add Period
          </button>

          <div className="portal-actions">
            <button
              className="portal-btn portal-btn--primary"
              onClick={handlePublish}
              disabled={saving || !tplName || proportionSum !== 100}
            >
              {saving ? 'Publishing…' : 'Publish Template'}
            </button>
          </div>

          {publishResult && (
            <div className="alert alert--success" style={{ marginTop: 12 }}>
              Template <strong>{publishResult.id}</strong> published.
              {publishResult.txHash
                ? <> TX: <code>{publishResult.txHash.slice(0, 16)}…</code></>
                : <> Saved locally (on-chain publishing requires xahaud testnet).</>
              }
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: My Templates ─────────────────────────────────────────────── */}
      {step === 'templates' && session && (
        <div className="portal-card">
          <div className="portal-card__header">
            <h2>My Published Templates</h2>
            <button className="portal-btn portal-btn--ghost" onClick={() => { setStep('create'); setError(''); }}>
              + New Template
            </button>
          </div>

          {loadingTemplates && <div className="field-hint">Loading templates…</div>}
          {!loadingTemplates && myTemplates.length === 0 && (
            <div className="empty-state">No templates published yet. Create your first template.</div>
          )}

          {myTemplates.length > 0 && (
            <div className="template-grid">
              {myTemplates.map(t => (
                <div key={t.id} className="template-card" style={{ cursor: 'default' }}>
                  <div className="template-card__industry">{t.industry}</div>
                  <div className="template-card__name">{t.name}</div>
                  <div className="template-card__desc">{t.description}</div>
                  <div className="template-card__meta">
                    <span>{t.periods} periods</span>
                    <span>{t.periodLengthDays}d each</span>
                    <span>{t.oracleCount} oracles</span>
                    <span>M={t.quorumRequired}</span>
                  </div>
                  <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                    <button
                      className="portal-btn portal-btn--ghost"
                      style={{ fontSize: 12, padding: '4px 12px', color: 'var(--c-red)', borderColor: 'var(--c-red)' }}
                      onClick={() => handleCancel(t)}
                      disabled={cancellingId === t.id}
                    >
                      {cancellingId === t.id ? 'Cancelling…' : 'Cancel Template'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Step 4: Active Hooks ─────────────────────────────────────────────── */}
      {step === 'contracts' && session && (
        <div className="portal-card">
          <h2>Active On-Chain Hooks</h2>
          <p className="field-hint">Unresolved escrow objects on your regulator account.</p>
          <ActiveHooksPanel address={session.address} />
        </div>
      )}
    </div>
  );
}
