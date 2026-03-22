/**
 * Claude AI integration for the generalized escrow platform.
 *
 * Three responsibilities:
 *   1. draftTemplate      — Government describes a contract in plain text; Claude returns structured JSON
 *   2. explainTemplate    — Enterprise asks questions; Claude explains terms in context
 *   3. evaluateCompliance — Each period: Claude analyzes oracle data and produces a compliance verdict
 */

import Anthropic from '@anthropic-ai/sdk';
import type { ContractTemplate, ComplianceVerdict, OraclePeriodData } from '../shared/src/contract-template.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-4-6';

// ─── draftTemplate ────────────────────────────────────────────────────────────
// Government describes what they want in plain language → Claude fills in a
// ContractTemplate JSON. The government can then edit individual fields.

export async function draftTemplate(description: string): Promise<ContractTemplate> {
  const systemPrompt = `You are an expert regulatory contract designer working for a government agency.
Your job is to convert a natural-language contract description into a structured JSON template
for a blockchain-based compliance escrow system.

The escrow system works as follows:
- An enterprise locks funds on-chain in two pools: a compliance pool (returned to enterprise if they comply)
  and a penalty pool (sent to a contractor/regulator if they violate)
- Each "period" (e.g. monthly), independent oracles attest a numeric metric reading
- If the reading meets the compliance criterion, the compliance pool slice is returned to the enterprise
- If the reading violates the criterion, the penalty pool slice goes to the contractor

You must return ONLY valid JSON matching this exact TypeScript interface (no markdown, no explanation):

interface ContractTemplate {
  id: string;                    // generate a short slug like "co2-manufacturing-monthly"
  name: string;                  // short human-readable name
  description: string;           // 1-2 sentence plain-language description
  industry: string;              // one of: energy, manufacturing, mining, chemicals, nuclear, agriculture, water, other
  metricType: string;            // machine key like "co2_tons", "radiation_usv", "wastewater_ppm", "noise_db"
  metricUnit: string;            // display unit like "tons CO2/month", "µSv/h", "mg/L"
  metricDescription: string;     // 1 sentence explaining what is being measured
  complianceIsBelow: boolean;    // true if compliant when reading < threshold (pollution, radiation)
                                 // false if compliant when reading > threshold (efficiency, output)
  periods: number;               // total compliance periods (e.g. 12 for 1 year monthly)
  periodLengthDays: number;      // length of each period in days (30 = monthly, 90 = quarterly)
  oracleCount: number;           // total independent oracles (default 5)
  quorumRequired: number;        // oracles needed to agree (default 3, min 2)
  oracleCredentialType: string;  // e.g. "EnvironmentalAuditor", "RadiationInspector"
  compliancePoolPct: number;     // % of total that can return to enterprise (0-100)
  penaltyPoolPct: number;        // % of total for contractor on violation (should sum to 100)
  periodDistribution: number[];  // per-period % of each pool (length=periods, sums to 100)
                                 // e.g. equal distribution: [8,8,8,8,8,8,8,8,9,9,9,9] for 12 periods
  violationBehavior: "period_slice" | "full_pool" | "configurable";
  createdAt: string;             // ISO timestamp (use current time)
  createdBy: string;             // use "government-portal"
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: description,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  // Strip any accidental markdown code fences
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let parsed: ContractTemplate;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  // Ensure periodDistribution is correct length; Claude sometimes gets it slightly wrong
  if (!parsed.periodDistribution || parsed.periodDistribution.length !== parsed.periods) {
    const even = Math.floor(100 / parsed.periods);
    const remainder = 100 - even * parsed.periods;
    parsed.periodDistribution = Array.from({ length: parsed.periods }, (_, i) =>
      i < remainder ? even + 1 : even
    );
  }

  return parsed;
}

// ─── explainTemplate ──────────────────────────────────────────────────────────
// Enterprise asks a plain-language question about a template (or a specific field).
// Returns a clear, jargon-free explanation.

export async function explainTemplate(
  template: ContractTemplate,
  question: string,
  field?: string
): Promise<string> {
  const systemPrompt = `You are a friendly compliance contract advisor helping a business
understand the terms of a regulatory escrow contract they are considering signing.

Explain things in plain language. Avoid jargon. Be concise (2-4 sentences max per answer).
If asked about a specific field, focus your answer on that field in the context of this specific contract.

CONTRACT DETAILS:
${JSON.stringify(template, null, 2)}`;

  const userContent = field
    ? `I have a question about the "${field}" field: ${question}`
    : question;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}

// ─── evaluateCompliance ───────────────────────────────────────────────────────
// Called each period after oracle data is collected.
// Claude analyzes the readings and returns a structured verdict.

export async function evaluateCompliance(
  template: ContractTemplate,
  oracleData: OraclePeriodData[],
  periodIndex: number,
  threshold: number
): Promise<ComplianceVerdict> {
  const values = oracleData.map(o => o.metricValue);
  const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const direction = template.complianceIsBelow ? 'below' : 'above';
  const criterion = template.complianceIsBelow
    ? `${median} <= ${threshold} ${template.metricUnit}`
    : `${median} >= ${threshold} ${template.metricUnit}`;
  const met = template.complianceIsBelow ? median <= threshold : median >= threshold;

  const systemPrompt = `You are a compliance evaluation engine for a regulatory escrow system.
You receive oracle readings for a compliance period and must determine if the enterprise met their obligations.

CONTRACT: ${template.name}
METRIC: ${template.metricDescription}
UNIT: ${template.metricUnit}
COMPLIANCE CRITERION: reading must be ${direction} ${threshold} ${template.metricUnit}

You must return ONLY valid JSON matching this structure (no markdown, no explanation):
{
  "verdict": "compliant" | "violation",
  "confidence": 0.0-1.0,
  "explanation": "2-3 sentence plain-language explanation of the verdict",
  "recommendedAction": "one sentence describing what should happen next",
  "details": {
    "metricValue": <median reading>,
    "threshold": <threshold>,
    "metricUnit": "<unit>",
    "complianceIsBelow": <bool>,
    "periodIndex": <period number>
  }
}`;

  const userContent = `Period ${periodIndex + 1} oracle readings:
${oracleData.map(o => `  Oracle ${o.oracleIndex} (${o.oracleAddress.slice(0, 10)}…): ${o.metricValue} ${o.metricUnit}`).join('\n')}

Median reading: ${median} ${template.metricUnit}
Threshold: ${threshold} ${template.metricUnit}
Compliance criterion (${direction} threshold) met: ${met}
Number of oracles: ${oracleData.length} (quorum required: ${template.quorumRequired})`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();

  let parsed: ComplianceVerdict;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback: compute verdict ourselves if Claude's JSON is malformed
    parsed = {
      verdict: met ? 'compliant' : 'violation',
      confidence: 0.95,
      explanation: met
        ? `The median oracle reading of ${median} ${template.metricUnit} is ${direction} the threshold of ${threshold} ${template.metricUnit}. The enterprise is compliant for period ${periodIndex + 1}.`
        : `The median oracle reading of ${median} ${template.metricUnit} exceeds the threshold of ${threshold} ${template.metricUnit}. The enterprise is in violation for period ${periodIndex + 1}.`,
      recommendedAction: met
        ? 'Release the compliance pool slice back to the enterprise.'
        : 'Release the penalty pool slice to the contractor.',
      details: {
        metricValue: median,
        threshold,
        metricUnit: template.metricUnit,
        complianceIsBelow: template.complianceIsBelow,
        periodIndex,
      },
    };
  }

  return parsed;
}

// ─── streamDraftTemplate ──────────────────────────────────────────────────────
// Streaming version of draftTemplate for use with SSE endpoints.
// Yields text chunks as they arrive from Claude.

export async function* streamDraftTemplate(description: string): AsyncGenerator<string> {
  const systemPrompt = `You are an expert regulatory contract designer working for a government agency.
Convert the following natural-language description into a filled-in contract template form.
First, briefly acknowledge what you understood (1-2 sentences), then output the JSON.
Wrap the JSON in a \`\`\`json code block so the UI can parse it.

The JSON must match this structure:
{
  "id": "short-slug",
  "name": "Human Readable Name",
  "description": "1-2 sentence overview",
  "industry": "energy|manufacturing|mining|chemicals|nuclear|agriculture|water|other",
  "metricType": "machine_key",
  "metricUnit": "display unit",
  "metricDescription": "what is being measured",
  "complianceIsBelow": true,
  "periods": 12,
  "periodLengthDays": 30,
  "oracleCount": 5,
  "quorumRequired": 3,
  "oracleCredentialType": "CredentialTypeName",
  "compliancePoolPct": 60,
  "penaltyPoolPct": 40,
  "periodDistribution": [8,8,8,8,8,8,8,8,9,9,9,9],
  "violationBehavior": "period_slice",
  "createdAt": "${new Date().toISOString()}",
  "createdBy": "government-portal"
}`;

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: description }],
  });

  for await (const chunk of stream) {
    if (
      chunk.type === 'content_block_delta' &&
      chunk.delta.type === 'text_delta'
    ) {
      yield chunk.delta.text;
    }
  }
}
