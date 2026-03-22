import { useState } from 'react';
import type { ContractTemplate } from '../../../shared/src/contract-template.js';

// ─── Preset templates ─────────────────────────────────────────────────────────

function makeDistribution(periods: number): number[] {
  const even = Math.floor(100 / periods);
  const remainder = 100 - even * periods;
  return Array.from({ length: periods }, (_, i) => (i < remainder ? even + 1 : even));
}

const BASE = {
  complianceIsBelow: true,
  periods: 12,
  periodLengthDays: 30,
  oracleCount: 5,
  quorumRequired: 3,
  compliancePoolPct: 60,
  penaltyPoolPct: 40,
  violationBehavior: 'period_slice' as const,
  createdBy: 'government-portal',
};

const PRESETS: Array<{ icon: string; label: string; hint: string; template: Omit<ContractTemplate, 'id' | 'createdAt'> }> = [
  {
    icon: '☢',
    label: 'Nuclear Radiation',
    hint: 'µSv/h readings below safe threshold',
    template: {
      ...BASE,
      name: 'Nuclear Facility Radiation Monitoring',
      description: 'Monthly radiation level compliance for nuclear facilities. Readings must stay below the permitted µSv/h threshold.',
      industry: 'nuclear',
      metricType: 'radiation_usv',
      metricUnit: 'µSv/h',
      metricDescription: 'Ambient radiation level measured in microsieverts per hour',
      oracleCredentialType: 'RadiationInspector',
      periodDistribution: makeDistribution(12),
    },
  },
  {
    icon: '🏭',
    label: 'CO2 Emissions',
    hint: 'Tons CO2/month below quota',
    template: {
      ...BASE,
      name: 'CO2 Emissions Compliance',
      description: 'Monthly CO2 emissions compliance for manufacturing. Enterprises must stay below their allocated quota of CO2 tons per month.',
      industry: 'manufacturing',
      metricType: 'co2_tons',
      metricUnit: 'tons CO2/month',
      metricDescription: 'Total CO2 emissions measured in metric tons per month',
      oracleCredentialType: 'EnvironmentalAuditor',
      periodDistribution: makeDistribution(12),
    },
  },
  {
    icon: '💧',
    label: 'Wastewater Quality',
    hint: 'Contaminant mg/L below permitted limit',
    template: {
      ...BASE,
      name: 'Wastewater Quality Compliance',
      description: 'Monthly wastewater quality compliance for industrial facilities. Contaminant levels must remain below the permitted mg/L limit.',
      industry: 'water',
      metricType: 'wastewater_ppm',
      metricUnit: 'mg/L',
      metricDescription: 'Contaminant concentration in wastewater measured in milligrams per litre',
      oracleCredentialType: 'WaterQualityInspector',
      periodDistribution: makeDistribution(12),
    },
  },
  {
    icon: '🔊',
    label: 'Noise Pollution',
    hint: 'dB levels below permitted maximum',
    template: {
      ...BASE,
      name: 'Noise Pollution Compliance',
      description: 'Monthly noise level compliance for industrial sites. Ambient noise must stay below the permitted decibel threshold.',
      industry: 'manufacturing',
      metricType: 'noise_db',
      metricUnit: 'dB',
      metricDescription: 'Ambient noise level measured in decibels',
      oracleCredentialType: 'AcousticEngineer',
      periodDistribution: makeDistribution(12),
    },
  },
];

// ─── GovernmentPortal ────────────────────────────────────────────────────────
// Government regulators use this page to:
//   1. Pick a preset contract type
//   2. Review / edit fields
//   3. Publish the template for enterprises to use

export function GovernmentPortal() {
  const [step, setStep] = useState<'pick' | 'review' | 'published'>('pick');
  const [template, setTemplate] = useState<ContractTemplate | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ── Step 1: Select a preset ───────────────────────────────────────────────

  const selectPreset = (preset: typeof PRESETS[number]) => {
    const now = new Date().toISOString();
    const slug = preset.template.metricType.replace(/_/g, '-');
    setTemplate({
      ...preset.template,
      id: `${slug}-${Date.now()}`,
      createdAt: now,
    });
    setStep('review');
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
        <div className={`step ${step === 'pick' ? 'step--active' : 'step--done'}`}>
          1 · Pick Type
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

      {/* ── Step 1: Pick preset ───────────────────────────────────────────── */}
      {step === 'pick' && (
        <div className="portal-card">
          <h2>Choose a contract type</h2>
          <p className="field-hint">
            Select the compliance category. All fields will be pre-filled — you can edit them in the next step.
          </p>
          <div className="preset-grid">
            {PRESETS.map(preset => (
              <button
                key={preset.label}
                className="preset-card"
                onClick={() => selectPreset(preset)}
              >
                <span className="preset-card__icon">{preset.icon}</span>
                <span className="preset-card__label">{preset.label}</span>
                <span className="preset-card__hint">{preset.hint}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 2: Review & Edit ─────────────────────────────────────────── */}
      {step === 'review' && template && (
        <div className="portal-card">
          <div className="portal-card__header">
            <h2>Review & Edit Template</h2>
            <button className="portal-btn portal-btn--ghost" onClick={() => setStep('pick')}>
              ← Back
            </button>
          </div>
          <p className="field-hint">
            Review the pre-filled template. Edit any fields before publishing.
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

            <div className="form-section-title">Parties</div>
            <FormRow label="Government XRPL Address" hint="Your institution's XRPL address (auto-fills for enterprises)">
              <input
                className="portal-input"
                placeholder="rGovAddress..."
                value={template.governmentAddress ?? ''}
                onChange={e => updateField('governmentAddress', e.target.value)}
              />
            </FormRow>
            <FormRow label="Contractor XRPL Address" hint="Contractor who receives the penalty pool on violations">
              <input
                className="portal-input"
                placeholder="rContractorAddress..."
                value={template.contractorAddress ?? ''}
                onChange={e => updateField('contractorAddress', e.target.value)}
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
            onClick={() => { setStep('pick'); setTemplate(null); }}
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
