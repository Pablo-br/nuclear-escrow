import { useState, useEffect } from 'react';
import type { ContractInstance, PeriodResult, SimulatePeriodResult, OracleConfig } from '../../../shared/src/contract-template.js';

// ─── XRPL Hook permit helpers ─────────────────────────────────────────────────

// Build the 32-byte Hook state key: "PERMIT" (6) + u32be(periodIndex) (4) + zeros (22)
function buildPermitKey(periodIndex: number): string {
  const buf = new Uint8Array(32);
  [0x50, 0x45, 0x52, 0x4d, 0x49, 0x54].forEach((b, i) => { buf[i] = b; }); // "PERMIT"
  new DataView(buf.buffer).setUint32(6, periodIndex, false); // big-endian at offset 6
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Decode 20-byte hex AccountID → XRPL classic address using xrpl's encodeAccountID
async function decodePermit(hexData: string): Promise<string | null> {
  if (!hexData || hexData.replace(/0/g, '') === '') return null; // all zeros = no permit
  const { encodeAccountID } = await import('xrpl');
  return encodeAccountID(Buffer.from(hexData, 'hex') as unknown as Uint8Array);
}

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

  // ── Oracle simulation state ────────────────────────────────────────────────
  const [activeScenario, setActiveScenario] = useState<'all-compliant' | 'all-violation' | 'mixed'>('all-compliant');
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState<SimulatePeriodResult | null>(null);

  // ── Oracle worker status ───────────────────────────────────────────────────
  const [oracleStatus, setOracleStatus] = useState<{ running: boolean; nextFireAt: number; status: string } | null>(null);

  // ── Oracle run state (button-triggered) ───────────────────────────────────
  const [oracleRunning, setOracleRunning] = useState(false);
  const [oracleRunResult, setOracleRunResult] = useState<(SimulatePeriodResult & { periodResult: unknown }) | null>(null);

  // ── Regulator seed for on-chain escrow resolution ─────────────────────────
  const [regulatorSeed, setRegulatorSeed] = useState('');

  // ── On-chain permit state (read from XRPL Hook namespace) ────────────────
  const [onChainPermit, setOnChainPermit] = useState<Record<number, string | null>>({});

  // ── Hook permit / claim state ─────────────────────────────────────────────
  const [companySeed, setCompanySeed] = useState('');
  const [contractorSeed, setContractorSeed] = useState('');
  const [claimResults, setClaimResults] = useState<Record<number, {
    company?: { txHash?: string; error?: string; success: boolean };
    contractor?: { txHash?: string; error?: string; success: boolean };
  }>>({});
  const [claiming, setClaiming] = useState<Record<number, { company?: boolean; contractor?: boolean }>>({});

  // ── Poll contract state every 5s ──────────────────────────────────────────

  useEffect(() => {
    let active = true;

    const load = () => {
      fetch(`/contracts/${contractId}`)
        .then(r => { if (!r.ok) throw new Error('not found'); return r.json(); })
        .then((data: ContractInstance) => {
          if (active) {
            setInstance(data);
            setLoading(false);
            if (data.activeScenario) setActiveScenario(data.activeScenario);
          }
        })
        .catch(e => { if (active) { setError(String(e)); setLoading(false); } });

      fetch(`/contracts/${contractId}/oracle-status`)
        .then(r => r.ok ? r.json() : null)
        .then(s => { if (active && s) setOracleStatus(s); })
        .catch(() => {});
    };

    load();
    const id = setInterval(load, 5000);
    return () => { active = false; clearInterval(id); };
  }, [contractId]);

  // ── Poll XRPL Hook state for permit after oracle run ──────────────────────
  useEffect(() => {
    if (!instance?.hookDeployed || !oracleRunResult) return;
    const pi = (oracleRunResult as SimulatePeriodResult).periodIndex;
    const companyAddress = instance.enterpriseAddress;
    let active = true;

    const poll = async () => {
      try {
        const key = buildPermitKey(pi);
        const resp = await fetch('/xrpl-rpc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            method: 'ledger_entry',
            params: [{ hook_state: { account: companyAddress, key, namespace_id: '0'.repeat(64) }, ledger_index: 'current' }],
          }),
        });
        const json = await resp.json() as { result: { node?: { HookStateData?: string } } };
        const hexData = json.result.node?.HookStateData ?? null;
        const address = hexData ? await decodePermit(hexData) : null;
        if (active) setOnChainPermit(prev => ({ ...prev, [pi]: address }));
      } catch { /* non-fatal */ }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => { active = false; clearInterval(id); };
  }, [instance?.hookDeployed, instance?.enterpriseAddress, oracleRunResult]);

  if (loading) return <div className="loading-msg">Loading contract…</div>;
  if (error || !instance) return <div className="alert alert--error">{error || 'Contract not found'}</div>;

  const { template } = instance;
  const totalNum = Number(instance.totalLocked);
  const complianceNum = Number(instance.compliancePool);
  const penaltyNum = Number(instance.penaltyPool);

  // Every settled period (compliant or violation) consumes one slice from the compliance pool
  const complianceReleased = instance.periodResults
    .reduce((s, r) => s + Number(r.amountReleased), 0);
  const complianceRemaining = Math.max(0, complianceNum - complianceReleased);

  // Bonus pool settles as a single escrow when the contract completes
  const bonusSettled = instance.status === 'complete';
  const allCompliant = bonusSettled && instance.periodResults.every(r => r.verdict === 'compliant');
  const penaltyRemaining = bonusSettled ? 0 : penaltyNum;

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

  // ── Persist scenario to server ────────────────────────────────────────────

  const handleScenarioChange = async (scenario: 'all-compliant' | 'all-violation' | 'mixed') => {
    setActiveScenario(scenario);
    fetch(`/contracts/${contractId}/scenario`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario }),
    }).catch(() => {});
  };

  // ── Oracle simulation ─────────────────────────────────────────────────────

  const handleSimulate = async () => {
    setSimulating(true);
    setSimResult(null);
    try {
      const periodIndex = instance?.currentPeriod ?? 0;
      const resp = await fetch(`/contracts/${contractId}/simulate-period/${periodIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: activeScenario }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const result = await resp.json() as SimulatePeriodResult;
      setSimResult(result);
      // Pre-fill the metric value with the true reading
      setSubmitForm(prev => ({ ...prev, metricValue: String(result.trueReading.toFixed(2)) }));
    } catch {
      // non-fatal
    } finally {
      setSimulating(false);
    }
  };

  // ── Oracle run (simulate + submit in one click) ───────────────────────────

  const handleOracleRun = async () => {
    if (!instance) return;
    setOracleRunning(true);
    setOracleRunResult(null);
    try {
      const periodIndex = instance.currentPeriod;
      const resp = await fetch(`/contracts/${contractId}/oracle-run/${periodIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed: regulatorSeed || undefined }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const result = await resp.json();
      setOracleRunResult(result);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOracleRunning(false);
    }
  };

  // ── Claim funds for a period (permitted party sends CLAM) ─────────────────

  const handleClaim = async (periodIndex: number, seed: string, role: 'company' | 'contractor') => {
    setClaiming(prev => ({ ...prev, [periodIndex]: { ...prev[periodIndex], [role]: true } }));
    try {
      const resp = await fetch(`/contracts/${contractId}/claim/${periodIndex}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
      });
      const data = await resp.json() as { txHash?: string; error?: string; success: boolean };
      setClaimResults(prev => ({
        ...prev,
        [periodIndex]: { ...prev[periodIndex], [role]: data },
      }));
    } catch (e: unknown) {
      setClaimResults(prev => ({
        ...prev,
        [periodIndex]: { ...prev[periodIndex], [role]: { success: false, error: String(e) } },
      }));
    } finally {
      setClaiming(prev => ({ ...prev, [periodIndex]: { ...prev[periodIndex], [role]: false } }));
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
          seed: regulatorSeed || undefined,
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

      {/* Oracle worker status + scenario selector */}
      {/* Regulator seed input for on-chain escrow resolution */}
      <div className="oracle-status-banner" style={{ marginBottom: oracleStatus ? 8 : 16 }}>
        <label style={{ fontSize: 12, color: 'var(--c-muted)', whiteSpace: 'nowrap' }}>Regulator seed</label>
        <input
          className="portal-input"
          type="password"
          placeholder="sEd… (signs EscrowFinish/Cancel)"
          value={regulatorSeed}
          onChange={e => setRegulatorSeed(e.target.value)}
          style={{ flex: 1, minWidth: 200 }}
          autoComplete="off"
        />
        {regulatorSeed && <span className="badge badge--green" style={{ fontSize: 11 }}>ready</span>}
        {!regulatorSeed && <span className="badge badge--amber" style={{ fontSize: 11 }}>off-chain only</span>}
      </div>

      {oracleStatus && (
        <div className="oracle-status-banner">
          <span className={`badge badge--${oracleStatus.running ? 'green' : 'amber'}`}>
            {oracleStatus.running ? '⚡ Oracle workers running' : '⏸ Oracles idle'}
          </span>
          {oracleStatus.running && oracleStatus.nextFireAt && (
            <span className="oracle-status-banner__next">
              Next check: {new Date(oracleStatus.nextFireAt).toLocaleTimeString()}
            </span>
          )}
          {instance.mockScenarios && (
            <div className="oracle-status-banner__scenario">
              <label>Scenario</label>
              <select
                className="portal-input"
                style={{ padding: '2px 8px', fontSize: 12 }}
                value={activeScenario}
                onChange={e => handleScenarioChange(e.target.value as typeof activeScenario)}
              >
                <option value="all-compliant">All Compliant</option>
                <option value="all-violation">All Violation</option>
                <option value="mixed">Mixed (even=OK, odd=breach)</option>
              </select>
            </div>
          )}
        </div>
      )}

      {instance.hookDeployed && (
        <div className="oracle-status-banner" style={{ marginBottom: 16 }}>
          <span className="badge badge--green" style={{ fontSize: 11 }}>Hook deployed</span>
          <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>Permit-gated fund release active — only regulator can grant claims</span>
        </div>
      )}

      {/* Oracle run result */}
      {oracleRunResult && (
        <div className="portal-card" style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <h3 style={{ margin: 0 }}>Oracle Result — Period {(oracleRunResult as SimulatePeriodResult).periodIndex + 1}</h3>
            <span className={`badge badge--${(oracleRunResult as SimulatePeriodResult).consensus === 'compliant' ? 'green' : (oracleRunResult as SimulatePeriodResult).consensus === 'violation' ? 'red' : 'amber'}`}>
              {(oracleRunResult as SimulatePeriodResult).consensus}
            </span>
            <span style={{ fontSize: 12, color: 'var(--c-muted)', marginLeft: 'auto' }}>
              True reading: <strong>{(oracleRunResult as SimulatePeriodResult).trueReading.toFixed(2)} {instance.template.metricUnit}</strong>
            </span>
            <button className="portal-btn portal-btn--ghost" style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => setOracleRunResult(null)}>✕</button>
          </div>
          <table className="oracle-vote-table">
            <thead>
              <tr><th>Oracle</th><th>Reported</th><th>Vote</th><th>Byzantine?</th><th>Fault Prob.</th></tr>
            </thead>
            <tbody>
              {(oracleRunResult as SimulatePeriodResult).oracleVotes.map(v => (
                <tr key={v.oracleIndex} style={{ background: v.byzantine ? 'var(--c-amber-dim)' : undefined }}>
                  <td>Oracle {v.oracleIndex}</td>
                  <td>{v.reportedReading.toFixed(2)} {instance.template.metricUnit}</td>
                  <td><span className={`badge badge--${v.vote === 'compliant' ? 'green' : 'red'}`}>{v.vote}</span></td>
                  <td>{v.byzantine ? '⚠ fabricated' : '—'}</td>
                  <td>{((instance.oraclePool?.[v.oracleIndex] as OracleConfig | undefined)?.byzantineProbability ?? 0) * 100}%</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={2}><strong>Consensus</strong></td>
                <td colSpan={3}>
                  <span className={`badge badge--${(oracleRunResult as SimulatePeriodResult).consensus === 'compliant' ? 'green' : (oracleRunResult as SimulatePeriodResult).consensus === 'violation' ? 'red' : 'amber'}`}>
                    {(oracleRunResult as SimulatePeriodResult).consensus} ({(oracleRunResult as SimulatePeriodResult).compliantVotes}✓ / {(oracleRunResult as SimulatePeriodResult).violationVotes}✗ of {(oracleRunResult as SimulatePeriodResult).quorumRequired} required)
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>

          {/* Claim section — shown after oracle run when Hook is deployed and permit exists */}
          {/* Permit is read directly from XRPL Hook state (ledger_entry), not from server JSON */}
          {instance.hookDeployed && oracleRunResult && (() => {
            const pi = (oracleRunResult as SimulatePeriodResult).periodIndex;
            const permit = onChainPermit[pi];
            return permit ? (
              <div className="claim-section">
                <div className="claim-section__permit">
                  Permit granted to:{' '}
                  <code style={{ fontSize: 11 }}>{permit}</code>{' '}
                  <span className={`badge badge--${permit === instance.enterpriseAddress ? 'green' : 'red'}`}>
                    {permit === instance.enterpriseAddress ? 'Company (compliant)' : 'Contractor (violation)'}
                  </span>
                </div>

                <div className="claim-section__buttons">
                  {/* Company claim attempt */}
                  <div className="claim-attempt">
                    <div className="claim-attempt__label">Company</div>
                    <input
                      className="portal-input"
                      type="password"
                      placeholder="Company seed (sEd…)"
                      value={companySeed}
                      onChange={e => setCompanySeed(e.target.value)}
                      autoComplete="off"
                    />
                    <button
                      className="portal-btn portal-btn--primary"
                      onClick={() => handleClaim(pi, companySeed, 'company')}
                      disabled={!companySeed || claiming[pi]?.company}
                    >
                      {claiming[pi]?.company ? 'Claiming…' : 'Claim as Company'}
                    </button>
                    {claimResults[pi]?.company && (
                      <div className={`claim-result claim-result--${claimResults[pi].company!.success ? 'success' : 'rejected'}`}>
                        {claimResults[pi].company!.success
                          ? <span>✓ Claimed — <code style={{ fontSize: 10 }}>{claimResults[pi].company!.txHash}</code></span>
                          : <span>✗ {claimResults[pi].company!.error}</span>
                        }
                      </div>
                    )}
                  </div>

                  {/* Contractor claim attempt */}
                  <div className="claim-attempt">
                    <div className="claim-attempt__label">Contractor</div>
                    <input
                      className="portal-input"
                      type="password"
                      placeholder="Contractor seed (sEd…)"
                      value={contractorSeed}
                      onChange={e => setContractorSeed(e.target.value)}
                      autoComplete="off"
                    />
                    <button
                      className="portal-btn portal-btn--primary"
                      onClick={() => handleClaim(pi, contractorSeed, 'contractor')}
                      disabled={!contractorSeed || claiming[pi]?.contractor}
                    >
                      {claiming[pi]?.contractor ? 'Claiming…' : 'Claim as Contractor'}
                    </button>
                    {claimResults[pi]?.contractor && (
                      <div className={`claim-result claim-result--${claimResults[pi].contractor!.success ? 'success' : 'rejected'}`}>
                        {claimResults[pi].contractor!.success
                          ? <span>✓ Claimed — <code style={{ fontSize: 10 }}>{claimResults[pi].contractor!.txHash}</code></span>
                          : <span>✗ {claimResults[pi].contractor!.error}</span>
                        }
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="oracle-status-banner" style={{ marginTop: 12 }}>
                <span className="badge badge--amber">Polling XRPL…</span>
                <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>
                  Waiting for GRNT transaction to confirm on-chain (checking every 3s)
                </span>
              </div>
            );
          })()}
        </div>
      )}

      {/* Two-pool summary */}
      <div className="pool-summary">
        {/* Compliance pool */}
        <div className="pool-card pool-card--compliance">
          <div className="pool-card__title">Per-Period Rebate Pool</div>
          <div className="pool-card__subtitle">Each period settles one slice (compliant → company, violation → contractor)</div>
          <div className="pool-card__amount">{complianceRemaining.toLocaleString()}</div>
          <div className="pool-card__currency">drops remaining</div>
          <div className="pool-card__bar">
            <div
              className="pool-card__bar-fill pool-card__bar-fill--released"
              style={{ width: `${complianceNum > 0 ? (complianceReleased / complianceNum) * 100 : 0}%` }}
            />
          </div>
          <div className="pool-card__released">
            {complianceReleased.toLocaleString()} drops settled
            {' · '}{instance.periodResults.filter(r => r.verdict === 'compliant').length} compliant
            {' · '}{instance.periodResults.filter(r => r.verdict === 'violation').length} violations
          </div>
        </div>

        {/* Penalty pool = final bonus */}
        <div className="pool-card pool-card--penalty">
          <div className="pool-card__title">Final Bonus Pool</div>
          <div className="pool-card__subtitle">
            {bonusSettled
              ? (allCompliant ? 'Returned to company — all periods compliant' : 'Paid to contractor — violations detected')
              : 'Returned at end only if 100% compliant'}
          </div>
          <div className="pool-card__amount">{penaltyRemaining.toLocaleString()}</div>
          <div className="pool-card__currency">{bonusSettled ? 'drops settled' : 'drops locked'}</div>
          <div className="pool-card__bar">
            <div
              className={`pool-card__bar-fill ${bonusSettled ? (allCompliant ? 'pool-card__bar-fill--released' : 'pool-card__bar-fill--penalty') : ''}`}
              style={{ width: bonusSettled ? '100%' : '0%' }}
            />
          </div>
          <div className="pool-card__released">
            {bonusSettled
              ? `${penaltyNum.toLocaleString()} drops → ${allCompliant ? 'company' : 'contractor'}`
              : 'Pending contract completion'}
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
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {/* Oracle run button — visible when contract has mock scenario data */}
              {instance.mockScenarios && (
                <button
                  className="portal-btn portal-btn--primary"
                  style={{ width: '100%' }}
                  onClick={handleOracleRun}
                  disabled={oracleRunning}
                >
                  {oracleRunning ? 'Running Oracles…' : `Run Oracle — Period ${instance.currentPeriod + 1}`}
                </button>
              )}
              {/* Manual submit fallback */}
              <button
                className="portal-btn portal-btn--ghost"
                style={{ width: '100%' }}
                onClick={() => setSubmitOpen(true)}
              >
                Submit Manually →
              </button>
            </div>
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

              {/* Scenario selector + oracle simulation */}
              {instance.mockScenarios && (
                <div className="scenario-selector">
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <label style={{ fontSize: 13, color: 'var(--c-muted)', whiteSpace: 'nowrap' }}>Mock Scenario</label>
                    <select
                      className="portal-input"
                      style={{ flex: 1, minWidth: 160 }}
                      value={activeScenario}
                      onChange={e => handleScenarioChange(e.target.value as typeof activeScenario)}
                    >
                      <option value="all-compliant">All Compliant</option>
                      <option value="all-violation">All Violation</option>
                      <option value="mixed">Mixed (even=OK, odd=breach)</option>
                    </select>
                    <button
                      className="portal-btn portal-btn--ghost"
                      onClick={handleSimulate}
                      disabled={simulating}
                      style={{ padding: '4px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
                    >
                      {simulating ? 'Simulating…' : 'Run Oracle Simulation'}
                    </button>
                  </div>
                </div>
              )}

              {/* Oracle vote table */}
              {simResult && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 6 }}>
                    True reading: <strong>{simResult.trueReading.toFixed(2)} {instance.template.metricUnit}</strong>
                    {' '}— actual compliance: <span className={`badge badge--${simResult.truelyCompliant ? 'green' : 'red'}`} style={{ fontSize: 11 }}>{simResult.truelyCompliant ? 'COMPLIANT' : 'VIOLATION'}</span>
                  </div>
                  <table className="oracle-vote-table">
                    <thead>
                      <tr>
                        <th>Oracle</th>
                        <th>Reported</th>
                        <th>Vote</th>
                        <th>Byzantine?</th>
                        <th>Fault Prob.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {simResult.oracleVotes.map(v => (
                        <tr key={v.oracleIndex} style={{ background: v.byzantine ? 'var(--c-amber-dim)' : undefined }}>
                          <td>Oracle {v.oracleIndex}</td>
                          <td>{v.reportedReading.toFixed(2)} {instance.template.metricUnit}</td>
                          <td>
                            <span className={`badge badge--${v.vote === 'compliant' ? 'green' : 'red'}`}>
                              {v.vote}
                            </span>
                          </td>
                          <td>{v.byzantine ? '⚠ fabricated' : '—'}</td>
                          <td>
                            {((instance.oraclePool?.[v.oracleIndex] as OracleConfig | undefined)?.byzantineProbability ?? 0) * 100}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}><strong>Consensus</strong></td>
                        <td colSpan={3}>
                          <span className={`badge badge--${simResult.consensus === 'compliant' ? 'green' : simResult.consensus === 'violation' ? 'red' : 'amber'}`}>
                            {simResult.consensus} ({simResult.compliantVotes}✓ / {simResult.violationVotes}✗ of {simResult.quorumRequired} required)
                          </span>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

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
