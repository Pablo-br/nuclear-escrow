import { useState, useEffect } from 'react';
import type { ContractInstance, PeriodResult } from '../../../shared/src/contract-template.js';

// ─── ComplianceDashboard ──────────────────────────────────────────────────────
// Shows the live state of a generic compliance contract:
//   - Two-pool breakdown (compliance pool vs penalty pool)
//   - Period-by-period history with Claude's explanations
//   - Submit new period attestation (demo mode)

interface Props {
  contractId: string;
}

export function ComplianceDashboard({ contractId }: Props) {
  const [instance, setInstance] = useState<ContractInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitForm, setSubmitForm] = useState({ metricValue: '' });
  const [evaluating, setEvaluating] = useState(false);
  const [claudeVerdict, setClaudeVerdict] = useState<{ verdict: string; explanation: string; recommendedAction: string } | null>(null);

  // ── Poll contract state every 5s ──────────────────────────────────────────

  useEffect(() => {
    let active = true;

    const load = () => {
      fetch(`/contracts/${contractId}`)
        .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
        .then((data: ContractInstance) => { if (active) { setInstance(data); setLoading(false); } })
        .catch(e => { if (active) { setError(String(e)); setLoading(false); } });
    };

    load();
    const id = setInterval(load, 5000);
    return () => { active = false; clearInterval(id); };
  }, [contractId]);

  if (loading) return <div className="loading-msg">Loading contract…</div>;
  if (error || !instance) return <div className="alert alert--error">{error || 'Contract not found'}</div>;

  const { template } = instance;
  const totalNum = Number(instance.totalLocked);
  const complianceNum = Number(instance.compliancePool);
  const penaltyNum = Number(instance.penaltyPool);

  // Compute how much has been released so far
  const complianceReleased = instance.periodResults
    .filter(r => r.verdict === 'compliant')
    .reduce((s, r) => s + Number(r.amountReleased), 0);
  const penaltyReleased = instance.periodResults
    .filter(r => r.verdict === 'violation')
    .reduce((s, r) => s + Number(r.amountReleased), 0);
  const complianceRemaining = complianceNum - complianceReleased;
  const penaltyRemaining = penaltyNum - penaltyReleased;

  // ── Evaluate with Claude before submitting ────────────────────────────────

  const handleEvaluate = async () => {
    if (!submitForm.metricValue) return;
    setEvaluating(true);
    setClaudeVerdict(null);
    try {
      const periodIndex = instance.currentPeriod;
      const threshold = instance.thresholdPerPeriod[periodIndex] ?? 0;

      const oracleData = [{
        oracleIndex: 0,
        oracleAddress: 'rSimulatedOracle1',
        metricValue: Number(submitForm.metricValue),
        metricUnit: template.metricUnit,
        timestamp: Date.now(),
      }];

      const resp = await fetch('/ai/evaluate-compliance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template, oracleData, periodIndex, threshold }),
      });
      const verdict = await resp.json();
      setClaudeVerdict(verdict);
      // verdict is now auto-computed server-side; no client state needed
    } catch {
      setClaudeVerdict({ verdict: 'error', explanation: 'Could not evaluate with Claude.', recommendedAction: '' });
    } finally {
      setEvaluating(false);
    }
  };

  // ── Submit period result ──────────────────────────────────────────────────

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const periodIndex = instance.currentPeriod;
      await fetch(`/contracts/${contractId}/period/${periodIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metricValue: Number(submitForm.metricValue),
        }),
      });
      setSubmitOpen(false);
      setSubmitForm({ metricValue: '' });
      setClaudeVerdict(null);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="compliance-dashboard">
      {/* Header */}
      <div className="portal-header">
        <h1>{instance.enterpriseName}</h1>
        <p className="portal-subtitle">{template.name} · {template.industry}</p>
        <div className={`badge badge--${instance.status === 'active' ? 'green' : instance.status === 'complete' ? 'navy' : 'amber'}`}>
          {instance.status.toUpperCase()}
        </div>
      </div>

      {/* Two-pool summary */}
      <div className="pool-summary">
        {/* Compliance pool */}
        <div className="pool-card pool-card--compliance">
          <div className="pool-card__title">Per-Period Rebate Pool</div>
          <div className="pool-card__subtitle">Released each compliant period → Enterprise</div>
          <div className="pool-card__amount">{complianceRemaining.toLocaleString()}</div>
          <div className="pool-card__currency">drops remaining</div>
          <div className="pool-card__bar">
            <div
              className="pool-card__bar-fill pool-card__bar-fill--released"
              style={{ width: `${complianceNum > 0 ? (complianceReleased / complianceNum) * 100 : 0}%` }}
            />
          </div>
          <div className="pool-card__released">
            {complianceReleased.toLocaleString()} drops released → Enterprise
          </div>
        </div>

        {/* Penalty pool = final bonus */}
        <div className="pool-card pool-card--penalty">
          <div className="pool-card__title">Final Bonus Pool</div>
          <div className="pool-card__subtitle">Returned at end only if 100% compliant</div>
          <div className="pool-card__amount">{penaltyRemaining.toLocaleString()}</div>
          <div className="pool-card__currency">drops remaining</div>
          <div className="pool-card__bar">
            <div
              className="pool-card__bar-fill pool-card__bar-fill--penalty"
              style={{ width: `${penaltyNum > 0 ? (penaltyReleased / penaltyNum) * 100 : 0}%` }}
            />
          </div>
          <div className="pool-card__released">
            {penaltyReleased.toLocaleString()} drops paid → Contractor
          </div>
        </div>

        {/* Progress card */}
        <div className="pool-card pool-card--progress">
          <div className="pool-card__title">Period Progress</div>
          <div className="pool-card__amount">{instance.currentPeriod}</div>
          <div className="pool-card__currency">of {template.periods} periods</div>
          <div className="pool-card__bar">
            <div
              className="pool-card__bar-fill pool-card__bar-fill--progress"
              style={{ width: `${(instance.currentPeriod / template.periods) * 100}%` }}
            />
          </div>
          <div className="pool-card__meta">
            {template.metricUnit} · {template.complianceIsBelow ? 'below' : 'above'} threshold = compliant
          </div>
          {instance.currentPeriod < template.periods && (
            <button
              className="portal-btn portal-btn--primary"
              style={{ marginTop: '12px', width: '100%' }}
              onClick={() => setSubmitOpen(true)}
            >
              Submit Period {instance.currentPeriod + 1} →
            </button>
          )}
          {instance.currentPeriod >= template.periods && (
            <div className="badge badge--green" style={{ marginTop: '12px' }}>Contract Complete ✓</div>
          )}
        </div>
      </div>

      {/* Contract details */}
      <div className="portal-card">
        <h2>Contract Details</h2>
        <div className="template-summary">
          <div className="template-summary__row"><span>Contract ID</span><code>{instance.id}</code></div>
          <div className="template-summary__row"><span>Template</span><span>{template.name}</span></div>
          <div className="template-summary__row"><span>Enterprise</span><code>{instance.enterpriseAddress}</code></div>
          <div className="template-summary__row"><span>Contractor</span><code>{instance.contractorAddress}</code></div>
          <div className="template-summary__row"><span>Total Locked</span><span>{totalNum.toLocaleString()} XRP</span></div>
          <div className="template-summary__row"><span>Period Length</span><span>{template.periodLengthDays} days</span></div>
          <div className="template-summary__row"><span>Oracle Quorum</span><span>{template.quorumRequired} of {template.oracleCount}</span></div>
          <div className="template-summary__row"><span>Violation Behavior</span><span>{template.violationBehavior.replace('_', ' ')}</span></div>
        </div>
      </div>

      {/* Period history */}
      <div className="portal-card">
        <h2>Period History</h2>
        {instance.periodResults.length === 0 && (
          <div className="empty-state">No periods completed yet.</div>
        )}
        <div className="period-history">
          {instance.periodResults.map((r, idx) => (
            <PeriodRow key={idx} result={r} template={template} />
          ))}
        </div>
      </div>

      {/* Submit period modal */}
      {submitOpen && (
        <div className="terminal-modal__backdrop" onClick={() => setSubmitOpen(false)}>
          <div className="terminal-modal__panel" onClick={e => e.stopPropagation()} style={{ maxWidth: '560px' }}>
            <div className="terminal-modal__header">
              <span className="terminal-modal__title">Submit Period {instance.currentPeriod + 1}</span>
              <button className="terminal-modal__close" onClick={() => setSubmitOpen(false)}>Close</button>
            </div>
            <div style={{ padding: '20px' }}>
              {/* Live verdict preview */}
              {(() => {
                const periodIdx = instance.currentPeriod;
                const thresh = instance.thresholdPerPeriod[periodIdx] ?? 0;
                const val = Number(submitForm.metricValue);
                const hasValue = submitForm.metricValue !== '';
                const liveCompliant = hasValue
                  ? (template.complianceIsBelow ? val <= thresh : val >= thresh)
                  : null;
                return (
                  <div className="form-row">
                    <label className="form-row__label">
                      {template.metricDescription}
                      <span className="form-row__hint">
                        oracle reading in {template.metricUnit} · threshold: {thresh} · compliant when {template.complianceIsBelow ? 'below' : 'above'}
                      </span>
                    </label>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <input
                        className="portal-input"
                        type="number"
                        step="any"
                        placeholder={`e.g. ${thresh}`}
                        value={submitForm.metricValue}
                        onChange={e => { setSubmitForm(prev => ({ ...prev, metricValue: e.target.value })); setClaudeVerdict(null); }}
                        style={{ flex: 1 }}
                      />
                      {liveCompliant !== null && (
                        <span className={`badge ${liveCompliant ? 'badge--green' : 'badge--red'}`} style={{ whiteSpace: 'nowrap' }}>
                          {liveCompliant ? '✓ Compliant' : '✗ Violation'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })()}

              {claudeVerdict && (
                <div className={`alert ${claudeVerdict.verdict === 'compliant' ? 'alert--success' : claudeVerdict.verdict === 'violation' ? 'alert--error' : 'alert--warn'}`}>
                  <strong>Claude analysis: {claudeVerdict.verdict.toUpperCase()}</strong>
                  <p style={{ margin: '6px 0 0' }}>{claudeVerdict.explanation}</p>
                  {claudeVerdict.recommendedAction && (
                    <p style={{ margin: '4px 0 0', opacity: 0.85 }}>→ {claudeVerdict.recommendedAction}</p>
                  )}
                </div>
              )}

              <button
                className="portal-btn portal-btn--primary"
                style={{ width: '100%', marginTop: '16px' }}
                onClick={handleSubmit}
                disabled={submitting || !submitForm.metricValue}
              >
                {submitting ? 'Submitting…' : `Confirm Period ${instance.currentPeriod + 1} Result`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PeriodRow ────────────────────────────────────────────────────────────────

function PeriodRow({ result, template }: { result: PeriodResult; template: import('../../../shared/src/contract-template.js').ContractTemplate }) {
  const [expanded, setExpanded] = useState(false);
  const isCompliant = result.verdict === 'compliant';

  return (
    <div className={`period-row period-row--${result.verdict}`} onClick={() => setExpanded(e => !e)}>
      <div className="period-row__header">
        <span className="period-row__index">Period {result.periodIndex + 1}</span>
        <span className={`badge ${isCompliant ? 'badge--green' : 'badge--red'}`}>
          {isCompliant ? 'COMPLIANT' : 'VIOLATION'}
        </span>
        <span className="period-row__reading">
          {result.metricValue} {template.metricUnit}
          <span className="period-row__threshold"> / threshold {result.threshold}</span>
        </span>
        <span className={`period-row__release ${isCompliant ? 'period-row__release--compliance' : 'period-row__release--penalty'}`}>
          {Number(result.amountReleased).toLocaleString()} drops → {result.releasedTo}
        </span>
        <span className="period-row__time">{new Date(result.timestamp).toLocaleDateString()}</span>
        <span className="period-row__expand">{expanded ? '▲' : '▼'}</span>
      </div>
      {expanded && result.claudeExplanation && (
        <div className="period-row__detail">
          <div className="period-row__claude-label">Claude AI Analysis</div>
          <p className="period-row__claude-text">{result.claudeExplanation}</p>
          {result.txHash && (
            <a
              href={`https://testnet.xrpl.org/transactions/${result.txHash}`}
              target="_blank"
              rel="noreferrer"
              onClick={e => e.stopPropagation()}
              className="period-row__tx-link"
            >
              View transaction ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}
