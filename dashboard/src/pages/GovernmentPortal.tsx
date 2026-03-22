import { useState } from 'react';
import type { ContractTemplate } from '../../../shared/src/contract-template.js';

// ─── GovernmentPortal ────────────────────────────────────────────────────────
// Government regulators use this page to:
//   1. Describe a contract type in plain language
//   2. Claude AI generates a structured template
//   3. Government reviews / edits fields
//   4. Publishes the template for enterprises to use

export function GovernmentPortal() {
  const [step, setStep] = useState<'describe' | 'review' | 'published'>('describe');
  const [description, setDescription] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamOutput, setStreamOutput] = useState('');
  const [template, setTemplate] = useState<ContractTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Step 1: Stream Claude's response, then extract JSON ──────────────────

  const handleGenerate = async () => {
    if (!description.trim()) return;
    setStreaming(true);
    setStreamOutput('');
    setError('');

    try {
      const resp = await fetch('/ai/draft-template/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      if (!resp.body) throw new Error('No response body');

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let raw = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        setStreamOutput(raw);
      }

      // Extract JSON from code block or raw text
      const jsonMatch = raw.match(/```json\n?([\s\S]*?)```/) ??
                        raw.match(/```\n?([\s\S]*?)```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : raw.trim();

      try {
        const parsed: ContractTemplate = JSON.parse(jsonStr);
        setTemplate(parsed);
        setStep('review');
      } catch {
        setError('Claude returned unexpected output. Try rephrasing your description.');
      }
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setStreaming(false);
    }
  };

  // ── Step 2: Publish the template ──────────────────────────────────────────

  const handlePublish = async () => {
    if (!template) return;
    setSaving(true);
    setError('');
    try {
      const resp = await fetch('/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(template),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setStep('published');
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateField = <K extends keyof ContractTemplate>(key: K, value: ContractTemplate[K]) => {
    setTemplate(prev => prev ? { ...prev, [key]: value } : prev);
  };

  // ────────────────────────────────────────────────────────────────────────────
  return (
    <div className="portal-page">
      <div className="portal-header">
        <h1>Government Regulatory Portal</h1>
        <p className="portal-subtitle">Create compliance escrow contract templates for enterprises</p>
      </div>

      {/* Step indicator */}
      <div className="steps-bar">
        <div className={`step ${step === 'describe' ? 'step--active' : 'step--done'}`}>
          1 · Describe
        </div>
        <div className="step-arrow">→</div>
        <div className={`step ${step === 'review' ? 'step--active' : step === 'published' ? 'step--done' : ''}`}>
          2 · Review
        </div>
        <div className="step-arrow">→</div>
        <div className={`step ${step === 'published' ? 'step--active' : ''}`}>
          3 · Publish
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}

      {/* ── Step 1: Describe ─────────────────────────────────────────────── */}
      {step === 'describe' && (
        <div className="portal-card">
          <h2>Describe the contract type</h2>
          <p className="field-hint">
            Explain what the enterprise must comply with, how compliance is measured,
            what happens if they violate, and how the funds should be split.
            Claude AI will generate the structured template.
          </p>
          <textarea
            className="portal-textarea"
            rows={7}
            placeholder={
              'Example: "Monthly CO2 emissions compliance for manufacturing companies in France. ' +
              'Enterprises must stay below their allocated quota of CO2 tons per month. ' +
              'Independent environmental auditors verify monthly readings. ' +
              '60% of the locked funds can be returned to the enterprise over 12 months if they comply. ' +
              '40% goes to the national reforestation fund if they exceed their quota. ' +
              'If they exceed by more than 20%, the full penalty pool is released immediately."'
            }
            value={description}
            onChange={e => setDescription(e.target.value)}
            disabled={streaming}
          />

          {streaming && (
            <div className="stream-output">
              <div className="stream-output__label">Claude is drafting your template…</div>
              <pre className="stream-output__content">{streamOutput}</pre>
            </div>
          )}

          <button
            className="portal-btn portal-btn--primary"
            onClick={handleGenerate}
            disabled={streaming || !description.trim()}
          >
            {streaming ? 'Generating…' : 'Generate Template with Claude AI'}
          </button>
        </div>
      )}

      {/* ── Step 2: Review & Edit ─────────────────────────────────────────── */}
      {step === 'review' && template && (
        <div className="portal-card">
          <div className="portal-card__header">
            <h2>Review & Edit Template</h2>
            <button className="portal-btn portal-btn--ghost" onClick={() => setStep('describe')}>
              ← Back
            </button>
          </div>
          <p className="field-hint">
            Review the generated template. Edit any fields before publishing.
          </p>

          <div className="template-form">
            <FormRow label="Template ID" hint="Short machine-readable slug">
              <input
                className="portal-input"
                value={template.id}
                onChange={e => updateField('id', e.target.value)}
              />
            </FormRow>

            <FormRow label="Name" hint="Human-readable contract name">
              <input
                className="portal-input"
                value={template.name}
                onChange={e => updateField('name', e.target.value)}
              />
            </FormRow>

            <FormRow label="Description" hint="Plain-language overview">
              <textarea
                className="portal-input portal-input--textarea"
                rows={3}
                value={template.description}
                onChange={e => updateField('description', e.target.value)}
              />
            </FormRow>

            <div className="form-row-group">
              <FormRow label="Industry" hint="">
                <select
                  className="portal-input"
                  value={template.industry}
                  onChange={e => updateField('industry', e.target.value)}
                >
                  {['energy','manufacturing','mining','chemicals','nuclear','agriculture','water','other'].map(i => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              </FormRow>
              <FormRow label="Metric Type" hint="Machine key (e.g. co2_tons)">
                <input
                  className="portal-input"
                  value={template.metricType}
                  onChange={e => updateField('metricType', e.target.value)}
                />
              </FormRow>
              <FormRow label="Metric Unit" hint="Display unit (e.g. tons CO₂/month)">
                <input
                  className="portal-input"
                  value={template.metricUnit}
                  onChange={e => updateField('metricUnit', e.target.value)}
                />
              </FormRow>
            </div>

            <FormRow label="Metric Description" hint="Plain-language description of what is measured">
              <input
                className="portal-input"
                value={template.metricDescription}
                onChange={e => updateField('metricDescription', e.target.value)}
              />
            </FormRow>

            <div className="form-row-group">
              <FormRow label="Periods" hint="Total compliance periods">
                <input
                  className="portal-input"
                  type="number"
                  min={1}
                  max={60}
                  value={template.periods}
                  onChange={e => updateField('periods', Number(e.target.value))}
                />
              </FormRow>
              <FormRow label="Period Length (days)" hint="e.g. 30 = monthly">
                <input
                  className="portal-input"
                  type="number"
                  min={1}
                  value={template.periodLengthDays}
                  onChange={e => updateField('periodLengthDays', Number(e.target.value))}
                />
              </FormRow>
              <FormRow label="Oracle Count" hint="Total independent oracles">
                <input
                  className="portal-input"
                  type="number"
                  min={1}
                  max={10}
                  value={template.oracleCount}
                  onChange={e => updateField('oracleCount', Number(e.target.value))}
                />
              </FormRow>
              <FormRow label="Quorum Required" hint="Min oracles to agree">
                <input
                  className="portal-input"
                  type="number"
                  min={1}
                  max={template.oracleCount}
                  value={template.quorumRequired}
                  onChange={e => updateField('quorumRequired', Number(e.target.value))}
                />
              </FormRow>
            </div>

            <div className="form-row-group">
              <FormRow label="Compliance Pool %" hint="% returned to enterprise if compliant">
                <input
                  className="portal-input"
                  type="number"
                  min={0}
                  max={100}
                  value={template.compliancePoolPct}
                  onChange={e => updateField('compliancePoolPct', Number(e.target.value))}
                />
              </FormRow>
              <FormRow label="Penalty Pool %" hint="% to contractor on violation">
                <input
                  className="portal-input"
                  type="number"
                  min={0}
                  max={100}
                  value={template.penaltyPoolPct}
                  onChange={e => updateField('penaltyPoolPct', Number(e.target.value))}
                />
              </FormRow>
            </div>

            <div className="form-row-group">
              <FormRow label="Compliance Direction" hint="When is the enterprise compliant?">
                <select
                  className="portal-input"
                  value={template.complianceIsBelow ? 'below' : 'above'}
                  onChange={e => updateField('complianceIsBelow', e.target.value === 'below')}
                >
                  <option value="below">Reading BELOW threshold (pollution, radiation)</option>
                  <option value="above">Reading ABOVE threshold (efficiency, output)</option>
                </select>
              </FormRow>
              <FormRow label="Violation Behavior" hint="What happens when a violation occurs">
                <select
                  className="portal-input"
                  value={template.violationBehavior}
                  onChange={e => updateField('violationBehavior', e.target.value as ContractTemplate['violationBehavior'])}
                >
                  <option value="period_slice">Period slice only (this period's allocation)</option>
                  <option value="full_pool">Full pool (entire penalty pool released)</option>
                  <option value="configurable">Configurable per contract</option>
                </select>
              </FormRow>
            </div>

            <FormRow label="Oracle Credential Type" hint="XRPL credential type oracles must hold">
              <input
                className="portal-input"
                value={template.oracleCredentialType}
                onChange={e => updateField('oracleCredentialType', e.target.value)}
              />
            </FormRow>
          </div>

          {/* Fund split preview */}
          <div className="fund-split-preview">
            <div className="fund-split-preview__title">Fund Split Preview</div>
            <div className="fund-split-preview__bar">
              <div
                className="fund-split-preview__compliance"
                style={{ width: `${template.compliancePoolPct}%` }}
              >
                {template.compliancePoolPct}% Compliance (→ Enterprise)
              </div>
              <div
                className="fund-split-preview__penalty"
                style={{ width: `${template.penaltyPoolPct}%` }}
              >
                {template.penaltyPoolPct}% Penalty (→ Contractor)
              </div>
            </div>
          </div>

          <div className="portal-actions">
            <button
              className="portal-btn portal-btn--primary"
              onClick={handlePublish}
              disabled={saving}
            >
              {saving ? 'Publishing…' : 'Publish Template'}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 3: Published ─────────────────────────────────────────────── */}
      {step === 'published' && template && (
        <div className="portal-card portal-card--success">
          <div className="success-icon">✓</div>
          <h2>Template Published</h2>
          <p>
            <strong>{template.name}</strong> is now available for enterprises to use.
          </p>
          <div className="template-summary">
            <div className="template-summary__row">
              <span>Template ID</span><code>{template.id}</code>
            </div>
            <div className="template-summary__row">
              <span>Industry</span><span>{template.industry}</span>
            </div>
            <div className="template-summary__row">
              <span>Metric</span><span>{template.metricDescription}</span>
            </div>
            <div className="template-summary__row">
              <span>Periods</span><span>{template.periods} × {template.periodLengthDays} days</span>
            </div>
            <div className="template-summary__row">
              <span>Compliance Pool</span><span>{template.compliancePoolPct}% → Enterprise</span>
            </div>
            <div className="template-summary__row">
              <span>Penalty Pool</span><span>{template.penaltyPoolPct}% → Contractor</span>
            </div>
          </div>
          <button
            className="portal-btn portal-btn--ghost"
            onClick={() => { setStep('describe'); setDescription(''); setTemplate(null); setStreamOutput(''); }}
          >
            Create Another Template
          </button>
        </div>
      )}
    </div>
  );
}

// ─── FormRow helper ───────────────────────────────────────────────────────────

function FormRow({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
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
