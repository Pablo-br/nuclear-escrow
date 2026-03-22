import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { ContractTemplate, ContractInstance } from '../../../shared/src/contract-template.js';

// ─── EnterprisePortal ────────────────────────────────────────────────────────
// Enterprises use this page to:
//   1. Browse available contract templates published by the government
//   2. Select a template and fill in their specific details
//   3. Chat with Claude to understand the terms
//   4. Deploy the contract (creates two escrows on XRPL)

type Step = 'browse' | 'configure' | 'chat' | 'deploy';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function EnterprisePortal() {
  const [step, setStep] = useState<Step>('browse');
  const [templates, setTemplates] = useState<ContractTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<ContractTemplate | null>(null);
  const [error, setError] = useState('');

  // Configure step form state
  const [form, setForm] = useState({
    enterpriseName: '',
    enterpriseAddress: '',
    contractorAddress: '',
    regulatorAddress: '',
    totalLocked: '',
    thresholds: [] as number[],
  });

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Deploy state
  const [deploying, setDeploying] = useState(false);
  const [deployedInstance, setDeployedInstance] = useState<ContractInstance | null>(null);
  const [enterpriseSeed, setEnterpriseSeed] = useState('');
  const [locking, setLocking] = useState(false);
  const [escrowResult, setEscrowResult] = useState<{ txHash: string; sequence: number; periodicCount: number } | null>(null);

  // ── Fetch templates on mount ──────────────────────────────────────────────

  useEffect(() => {
    fetch('/templates')
      .then(r => r.json())
      .then((t: ContractTemplate[]) => { setTemplates(t); setLoadingTemplates(false); })
      .catch(() => { setLoadingTemplates(false); setError('Could not load templates.'); });
  }, []);

  // ── Auto-scroll chat ──────────────────────────────────────────────────────

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // ── Select template & pre-fill thresholds ─────────────────────────────────

  const handleSelectTemplate = (t: ContractTemplate) => {
    setSelectedTemplate(t);
    setForm(prev => ({
      ...prev,
      thresholds: Array.from({ length: t.periods }, () => 0),
      contractorAddress: t.contractorAddress ?? '',
      regulatorAddress: t.governmentAddress ?? '',
    }));
    setChatMessages([{
      role: 'assistant',
      content: `I've loaded the **${t.name}** template. This contract tracks **${t.metricDescription}** over ${t.periods} periods of ${t.periodLengthDays} days each.\n\nThe compliance pool (${t.compliancePoolPct}% of your locked funds) returns to your organization if you meet the ${t.metricUnit} targets. The penalty pool (${t.penaltyPoolPct}%) goes to the regulatory contractor if you exceed your limits.\n\nAsk me anything about the terms, or click "Configure Contract" to fill in your details.`,
    }]);
    setStep('configure');
  };

  // ── Chat with Claude about the template ───────────────────────────────────

  const handleChat = async () => {
    if (!chatInput.trim() || !selectedTemplate) return;
    const userMsg: ChatMessage = { role: 'user', content: chatInput };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);

    try {
      const resp = await fetch('/ai/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: selectedTemplate, question: chatInput }),
      });
      const { explanation } = await resp.json() as { explanation: string };
      setChatMessages(prev => [...prev, { role: 'assistant', content: explanation }]);
    } catch {
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I could not process your question. Please try again.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  // ── Deploy contract ───────────────────────────────────────────────────────

  const handleDeploy = async () => {
    if (!selectedTemplate) return;
    setDeploying(true);
    setError('');

    const totalNum = Number(form.totalLocked);
    const compliancePool = String(Math.floor(totalNum * selectedTemplate.compliancePoolPct / 100));
    const penaltyPool = String(Math.floor(totalNum * selectedTemplate.penaltyPoolPct / 100));

    const instance: ContractInstance = {
      id: `${selectedTemplate.id}-${Date.now()}`,
      templateId: selectedTemplate.id,
      template: selectedTemplate,
      enterpriseName: form.enterpriseName,
      enterpriseAddress: form.enterpriseAddress,
      contractorAddress: form.contractorAddress,
      regulatorAddress: form.regulatorAddress,
      totalLocked: form.totalLocked,
      compliancePool,
      penaltyPool,
      thresholdPerPeriod: form.thresholds,
      oraclePubkeys: [],               // populated by on-chain init (future)
      currentPeriod: 0,
      periodResults: [],
      status: 'negotiating',
      createdAt: new Date().toISOString(),
    };

    try {
      const resp = await fetch('/contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(instance),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setDeployedInstance(instance);
      setStep('deploy');
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setDeploying(false);
    }
  };

  const handleLockFunds = async () => {
    if (!deployedInstance || !enterpriseSeed.trim()) return;
    setLocking(true);
    setError('');
    try {
      const resp = await fetch(`/contracts/${deployedInstance.id}/lock-escrow`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enterpriseSeed }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const result = await resp.json() as { paymentTxHash: string; periodicTxHashes: string[]; periodicSequences: number[]; bonusTxHash: string; bonusSequence: number };
      setEscrowResult({ txHash: result.paymentTxHash, sequence: result.bonusSequence, periodicCount: result.periodicSequences.length });
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLocking(false);
    }
  };

  const updateThreshold = (i: number, val: number) => {
    setForm(prev => {
      const t = [...prev.thresholds];
      t[i] = val;
      return { ...prev, thresholds: t };
    });
  };

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="portal-page">
      <div className="portal-header">
        <h1>Enterprise Compliance Portal</h1>
        <p className="portal-subtitle">Select a regulatory template and create your compliance escrow</p>
      </div>

      {/* Step indicator */}
      <div className="steps-bar">
        {(['browse','configure','deploy'] as const).map((s, idx) => (
          <>
            <div key={s} className={`step ${step === s ? 'step--active' : idx < ['browse','configure','deploy'].indexOf(step) ? 'step--done' : ''}`}>
              {idx + 1} · {s.charAt(0).toUpperCase() + s.slice(1)}
            </div>
            {idx < 2 && <div key={`arrow-${s}`} className="step-arrow">→</div>}
          </>
        ))}
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {/* ── Browse ────────────────────────────────────────────────────────── */}
      {step === 'browse' && (
        <div className="portal-card">
          <h2>Available Contract Templates</h2>
          {loadingTemplates && <div className="loading-msg">Loading templates…</div>}
          {!loadingTemplates && templates.length === 0 && (
            <div className="empty-state">
              No templates published yet. Ask your regulator to create one in the Government Portal.
            </div>
          )}
          <div className="template-grid">
            {templates.map(t => (
              <div key={t.id} className="template-card" onClick={() => handleSelectTemplate(t)}>
                <div className="template-card__industry">{t.industry}</div>
                <div className="template-card__name">{t.name}</div>
                <div className="template-card__desc">{t.description}</div>
                <div className="template-card__meta">
                  <span>{t.periods} × {t.periodLengthDays}d periods</span>
                  <span>{t.compliancePoolPct}% rebate · {t.penaltyPoolPct}% penalty</span>
                  <span>{t.quorumRequired}/{t.oracleCount} oracle quorum</span>
                </div>
                <button className="portal-btn portal-btn--primary" style={{ marginTop: '12px', width: '100%' }}>
                  Select Template →
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Configure ─────────────────────────────────────────────────────── */}
      {(step === 'configure' || step === 'chat') && selectedTemplate && (
        <div className="enterprise-layout">
          {/* Left: form */}
          <div className="portal-card enterprise-form-card">
            <div className="portal-card__header">
              <h2>Configure Your Contract</h2>
              <button className="portal-btn portal-btn--ghost" onClick={() => setStep('browse')}>← Back</button>
            </div>
            <div className="template-badge">
              Using: <strong>{selectedTemplate.name}</strong>
            </div>

            <div className="template-form">
              <div className="form-section-title">Organization Details</div>
              <div className="form-row">
                <label className="form-row__label">Enterprise Name</label>
                <input className="portal-input" placeholder="Acme Industries SA" value={form.enterpriseName} onChange={e => setForm(p => ({ ...p, enterpriseName: e.target.value }))} />
              </div>
              <div className="form-row">
                <label className="form-row__label">Enterprise XRPL Address <span className="form-row__hint">Funds locked from this wallet</span></label>
                <input className="portal-input" placeholder="rEnterprise..." value={form.enterpriseAddress} onChange={e => setForm(p => ({ ...p, enterpriseAddress: e.target.value }))} />
              </div>
              <div className="form-row">
                <label className="form-row__label">
                  Contractor XRPL Address
                  {selectedTemplate.contractorAddress
                    ? <span className="form-row__hint">🔒 from template</span>
                    : <span className="form-row__hint">Penalty pool recipient</span>}
                </label>
                <input
                  className="portal-input"
                  placeholder="rContractor..."
                  value={form.contractorAddress}
                  readOnly={!!selectedTemplate.contractorAddress}
                  onChange={e => setForm(p => ({ ...p, contractorAddress: e.target.value }))}
                  style={selectedTemplate.contractorAddress ? { opacity: 0.7, cursor: 'not-allowed' } : undefined}
                />
              </div>
              <div className="form-row">
                <label className="form-row__label">
                  Government XRPL Address
                  {selectedTemplate.governmentAddress
                    ? <span className="form-row__hint">🔒 from template</span>
                    : <span className="form-row__hint">Issues credentials</span>}
                </label>
                <input
                  className="portal-input"
                  placeholder="rGovernment..."
                  value={form.regulatorAddress}
                  readOnly={!!selectedTemplate.governmentAddress}
                  onChange={e => setForm(p => ({ ...p, regulatorAddress: e.target.value }))}
                  style={selectedTemplate.governmentAddress ? { opacity: 0.7, cursor: 'not-allowed' } : undefined}
                />
              </div>

              <div className="form-section-title">Financial Terms</div>
              <div className="form-row">
                <label className="form-row__label">
                  Total Locked (XRP)
                  <span className="form-row__hint">
                    {form.totalLocked
                      ? `≈ ${Math.floor(Number(form.totalLocked) * selectedTemplate.compliancePoolPct / 100).toLocaleString()} XRP periodic rebate · ${Math.floor(Number(form.totalLocked) * selectedTemplate.penaltyPoolPct / 100).toLocaleString()} XRP final bonus`
                      : 'e.g. 10'}
                  </span>
                </label>
                <input className="portal-input" type="number" placeholder="1000000" value={form.totalLocked} onChange={e => setForm(p => ({ ...p, totalLocked: e.target.value }))} />
              </div>

              <div className="form-section-title">
                {selectedTemplate.metricDescription} — Thresholds per Period
                <span className="form-row__hint" style={{ display: 'block', fontWeight: 400 }}>
                  Compliance when reading is {selectedTemplate.complianceIsBelow ? 'below' : 'above'} threshold ({selectedTemplate.metricUnit})
                </span>
              </div>
              <div className="thresholds-grid">
                {form.thresholds.map((val, i) => (
                  <div key={i} className="threshold-item">
                    <label className="threshold-item__label">Period {i + 1}</label>
                    <input
                      className="portal-input threshold-item__input"
                      type="number"
                      min={0}
                      step="any"
                      value={val}
                      onChange={e => updateThreshold(i, Number(e.target.value))}
                    />
                    <span className="threshold-item__unit">{selectedTemplate.metricUnit}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="portal-actions">
              <button
                className="portal-btn portal-btn--primary"
                onClick={handleDeploy}
                disabled={deploying || !form.enterpriseAddress || !form.contractorAddress || !form.totalLocked}
              >
                {deploying ? 'Saving Contract…' : 'Create Contract →'}
              </button>
            </div>
          </div>

          {/* Right: Claude chat */}
          <div className="portal-card chat-card">
            <h2>Ask Claude</h2>
            <p className="field-hint">Ask anything about this contract before signing.</p>

            <div className="chat-messages">
              {chatMessages.map((msg, i) => (
                <div key={i} className={`chat-msg chat-msg--${msg.role}`}>
                  <div className="chat-msg__sender">{msg.role === 'user' ? 'You' : 'Claude AI'}</div>
                  <div className="chat-msg__text">{msg.content}</div>
                </div>
              ))}
              {chatLoading && (
                <div className="chat-msg chat-msg--assistant">
                  <div className="chat-msg__sender">Claude AI</div>
                  <div className="chat-msg__text chat-msg__text--typing">Thinking…</div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="chat-input-row">
              <input
                className="portal-input"
                placeholder="e.g. What happens if I miss one period?"
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChat(); } }}
                disabled={chatLoading}
              />
              <button
                className="portal-btn portal-btn--primary"
                onClick={handleChat}
                disabled={chatLoading || !chatInput.trim()}
              >
                Ask
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Deploy ────────────────────────────────────────────────────────── */}
      {step === 'deploy' && deployedInstance && (
        <div className="portal-card">
          <h2>Lock Funds on XRPL</h2>
          <p className="field-hint">Contract saved. Enter your XRPL seed to create the on-chain escrow and lock your funds.</p>

          <div className="template-summary" style={{ marginBottom: '20px' }}>
            <div className="template-summary__row">
              <span>Contract ID</span><code>{deployedInstance.id}</code>
            </div>
            <div className="template-summary__row">
              <span>Enterprise</span><span>{deployedInstance.enterpriseName}</span>
            </div>
            <div className="template-summary__row">
              <span>Total Locked</span><span>{Number(deployedInstance.totalLocked).toLocaleString()} RLUSD</span>
            </div>
            <div className="template-summary__row">
              <span>Per-period rebate</span>
              <span className="badge badge--green">{Number(deployedInstance.compliancePool).toLocaleString()} XRP → Enterprise (per period)</span>
            </div>
            <div className="template-summary__row">
              <span>Final bonus</span>
              <span className="badge badge--amber">{Number(deployedInstance.penaltyPool).toLocaleString()} XRP → Enterprise if 100% compliant</span>
            </div>
            <div className="template-summary__row">
              <span>Escrow Destination</span><code>{deployedInstance.regulatorAddress}</code>
            </div>
          </div>

          {!escrowResult ? (
            <>
              <div className="form-row">
                <label className="form-row__label">
                  Enterprise XRPL Seed
                  <span className="form-row__hint">Demo only — seed is used server-side to sign the EscrowCreate tx</span>
                </label>
                <input
                  className="portal-input"
                  type="password"
                  placeholder="sEd... or s..."
                  value={enterpriseSeed}
                  onChange={e => setEnterpriseSeed(e.target.value)}
                  disabled={locking}
                />
              </div>
              <div className="portal-actions">
                <button
                  className="portal-btn portal-btn--primary"
                  onClick={handleLockFunds}
                  disabled={locking || !enterpriseSeed.trim()}
                >
                  {locking ? 'Submitting to XRPL…' : 'Lock Funds on XRPL →'}
                </button>
              </div>
            </>
          ) : (
            <div className="escrow-success">
              <div className="success-icon" style={{ fontSize: '32px', marginBottom: '8px' }}>✓</div>
              <p><strong>Escrow created on XRPL testnet</strong></p>
              <div className="template-summary">
                <div className="template-summary__row">
                  <span>Escrows created</span><code>{escrowResult.periodicCount} periodic + 1 bonus</code>
                </div>
                <div className="template-summary__row">
                  <span>Payment tx</span>
                  <a
                    href={`https://testnet.xrpl.org/transactions/${escrowResult.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tx-link"
                  >
                    {escrowResult.txHash ? `${escrowResult.txHash.slice(0, 16)}… ↗` : 'view ↗'}
                  </a>
                </div>
              </div>
              <Link className="portal-btn portal-btn--primary" to={`/contract/${deployedInstance.id}`} style={{ marginTop: '16px', display: 'inline-block' }}>
                View Compliance Dashboard →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
