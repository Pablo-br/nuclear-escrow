import 'dotenv/config';
import express from 'express';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { Client, Wallet, decodeAccountID } from 'xrpl';
import { draftTemplate, explainTemplate, evaluateCompliance, streamDraftTemplate } from '../api/claude-assistant.js';
import { deriveAddress } from 'xrpl';
import type { ContractTemplate, ContractInstance, MockScenario, OracleConfig } from '../shared/src/contract-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Allow browser fetch from Vite dev server
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  next();
});

app.options('/{*path}', (_req, res) => { res.sendStatus(204); });

// ─── GET /state ───────────────────────────────────────────────────────────────

app.get('/state', async (req, res) => {
  console.log(`[${new Date().toISOString()}] GET /state from ${req.headers.origin ?? req.headers.host ?? 'unknown'}`);
  try {
    const statePath = join(__dirname, '..', '.nuclear-state.json');
    const raw = await readFile(statePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'state file not found' });
  }
});

// ─── POST /xrpl-rpc — proxy to XRPL testnet (avoids browser CORS) ────────────

app.post('/xrpl-rpc', (req, res) => {
  console.log(`[${new Date().toISOString()}] POST /xrpl-rpc method=${req.body?.method}`);
  const body = JSON.stringify(req.body ?? {});
  const options = {
    hostname: 's.altnet.rippletest.net',
    port: 51234,
    path: '/',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const proxy = https.request(options, (upstream) => {
    res.setHeader('Content-Type', 'application/json');
    upstream.pipe(res);
  });

  proxy.on('error', (err) => {
    res.status(502).json({ error: err.message });
  });

  proxy.write(body);
  proxy.end();
});

// ─── GET /audit — recent on-chain events for operator + regulator ─────────────

function xrplAccountTx(account: string): Promise<unknown[]> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      method: 'account_tx',
      params: [{ account, limit: 50, ledger_index_min: -1, ledger_index_max: -1 }],
    });
    const opts = {
      hostname: 's.altnet.rippletest.net',
      port: 51234,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (upstream) => {
      let data = '';
      upstream.on('data', (chunk: Buffer) => { data += chunk; });
      upstream.on('end', () => {
        try { resolve((JSON.parse(data).result?.transactions as unknown[]) ?? []); }
        catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.write(body);
    req.end();
  });
}

app.get('/audit', async (_req, res) => {
  try {
    const statePath = join(__dirname, '..', '.nuclear-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    const accounts: string[] = [
      state.escrowOwner,
      state.wallets?.regulator?.address,
    ].filter(Boolean) as string[];

    const all = (await Promise.all(accounts.map(xrplAccountTx))).flat() as Array<Record<string, unknown>>;

    // deduplicate by hash, sort newest first
    const seen = new Set<string>();
    const deduped = all.filter(e => {
      const tx = (e.tx ?? e.transaction ?? {}) as Record<string, unknown>;
      const hash = tx.hash as string | undefined;
      if (!hash || seen.has(hash)) return false;
      seen.add(hash);
      return true;
    });
    deduped.sort((a, b) => {
      const txA = (a.tx ?? a.transaction ?? {}) as Record<string, unknown>;
      const txB = (b.tx ?? b.transaction ?? {}) as Record<string, unknown>;
      return (Number(txB.date ?? 0)) - (Number(txA.date ?? 0));
    });

    res.json(deduped.slice(0, 100));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /deploy — full reset + facility init ────────────────────────────────

app.post('/deploy', (_req, res) => {
  const projectRoot = join(__dirname, '..');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const child = spawn('bash', ['scripts/full-reset.sh'], {
    cwd: projectRoot,
    env: { ...process.env },
  });

  child.stdout.on('data', (chunk: Buffer) => {
    res.write(chunk.toString());
  });

  child.stderr.on('data', (chunk: Buffer) => {
    res.write('[stderr] ' + chunk.toString());
  });

  child.on('close', (code) => {
    res.end(`\n[exit ${code}]`);
  });

  child.on('error', (err) => {
    res.end(`\n[spawn error] ${err.message}`);
  });
});

// ─── POST /milestone/:phase ───────────────────────────────────────────────────

app.post('/milestone/:phase', (req, res) => {
  const phase = parseInt(req.params.phase, 10);
  if (isNaN(phase) || phase < 0 || phase > 6) {
    res.status(400).send('Invalid phase');
    return;
  }

  const cliPath = join(__dirname, '..', 'cli', 'submit-milestone.ts');

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  const child = spawn('npx', ['tsx', cliPath, `--phase=${phase}`], {
    cwd: join(__dirname, '..'),
    env: { ...process.env },
  });

  child.stdout.on('data', (chunk: Buffer) => {
    res.write(chunk.toString());
  });

  child.stderr.on('data', (chunk: Buffer) => {
    res.write('[stderr] ' + chunk.toString());
  });

  child.on('close', (code) => {
    res.end(`\n[exit ${code}]`);
  });

  child.on('error', (err) => {
    res.end(`\n[spawn error] ${err.message}`);
  });
});

// ─── Template & Contract storage helpers ─────────────────────────────────────

const TEMPLATES_DIR = join(__dirname, '..', 'data', 'templates');
const CONTRACTS_DIR = join(__dirname, '..', 'data', 'contracts');

async function ensureDirs() {
  await mkdir(TEMPLATES_DIR, { recursive: true });
  await mkdir(CONTRACTS_DIR, { recursive: true });
}

async function readJsonDir<T>(dir: string): Promise<T[]> {
  await mkdir(dir, { recursive: true });
  const files = await readdir(dir);
  const items: T[] = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try {
      const raw = await readFile(join(dir, f), 'utf-8');
      items.push(JSON.parse(raw) as T);
    } catch {}
  }
  return items;
}

// ─── GET /templates ───────────────────────────────────────────────────────────

app.get('/templates', async (_req, res) => {
  try {
    const templates = await readJsonDir<ContractTemplate>(TEMPLATES_DIR);
    res.json(templates);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /templates — save a template ───────────────────────────────────────

app.post('/templates', async (req, res) => {
  try {
    await ensureDirs();
    const template = req.body as ContractTemplate;
    if (!template.id) { res.status(400).json({ error: 'template.id required' }); return; }
    await writeFile(join(TEMPLATES_DIR, `${template.id}.json`), JSON.stringify(template, null, 2));
    res.json({ ok: true, id: template.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /contracts ───────────────────────────────────────────────────────────

app.get('/contracts', async (_req, res) => {
  try {
    const contracts = await readJsonDir<ContractInstance>(CONTRACTS_DIR);
    res.json(contracts);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /contracts/:id ───────────────────────────────────────────────────────

app.get('/contracts/:id', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'not found' }); return; }
    const raw = await readFile(filePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /contracts — create a contract instance ─────────────────────────────

app.post('/contracts', async (req, res) => {
  try {
    await ensureDirs();
    const instance = req.body as ContractInstance;
    if (!instance.id) { res.status(400).json({ error: 'instance.id required' }); return; }
    await writeFile(join(CONTRACTS_DIR, `${instance.id}.json`), JSON.stringify(instance, null, 2));
    res.json({ ok: true, id: instance.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── PATCH /contracts/:id — update contract (e.g. add escrow sequences) ───────

app.patch('/contracts/:id', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'not found' }); return; }
    const existing = JSON.parse(await readFile(filePath, 'utf-8'));
    const updated = { ...existing, ...req.body };
    await writeFile(filePath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /ai/draft-template — Claude drafts a template from plain text ───────

app.post('/ai/draft-template', async (req, res) => {
  const { description } = req.body as { description: string };
  if (!description) { res.status(400).json({ error: 'description required' }); return; }

  try {
    const template = await draftTemplate(description);
    res.json(template);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /ai/draft-template/stream — streaming version ──────────────────────

app.post('/ai/draft-template/stream', async (req, res) => {
  const { description } = req.body as { description: string };
  if (!description) { res.status(400).send('description required'); return; }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    for await (const chunk of streamDraftTemplate(description)) {
      res.write(chunk);
    }
    res.end();
  } catch (e) {
    res.end(`\n[error] ${String(e)}`);
  }
});

// ─── POST /ai/explain — Claude explains a template field ─────────────────────

app.post('/ai/explain', async (req, res) => {
  const { template, question, field } = req.body as {
    template: ContractTemplate;
    question: string;
    field?: string;
  };
  if (!template || !question) {
    res.status(400).json({ error: 'template and question required' }); return;
  }

  try {
    const explanation = await explainTemplate(template, question, field);
    res.json({ explanation });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /ai/evaluate-compliance — Claude evaluates oracle data ──────────────

app.post('/ai/evaluate-compliance', async (req, res) => {
  const { template, oracleData, periodIndex, threshold } = req.body;
  if (!template || !oracleData || periodIndex === undefined || threshold === undefined) {
    res.status(400).json({ error: 'template, oracleData, periodIndex, threshold required' }); return;
  }

  try {
    const verdict = await evaluateCompliance(template, oracleData, periodIndex, threshold);
    res.json(verdict);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── XRPL helpers ─────────────────────────────────────────────────────────────

const RIPPLE_EPOCH = 946684800;
const XRPL_WSS = 'wss://s.altnet.rippletest.net:51233';
const toMemo = (s: string) => Buffer.from(s, 'utf-8').toString('hex').toUpperCase();

async function xrplSubmit(
  wallet: InstanceType<typeof Wallet>,
  tx: Record<string, unknown>,
  client: InstanceType<typeof Client>
): Promise<{ hash: string; sequence: number }> {
  const prepared = await client.autofill(tx as Parameters<typeof client.autofill>[0]);
  const signed = wallet.sign(prepared as Parameters<typeof wallet.sign>[0]);
  const result = await client.submitAndWait(signed.tx_blob);
  const r = result.result as Record<string, unknown>;
  const txJson = r.tx_json as Record<string, unknown> | undefined;
  const hash = String(r.hash ?? txJson?.hash ?? '');
  const sequence = Number(r.Sequence ?? txJson?.Sequence ?? 0);
  return { hash, sequence };
}

// ─── POST /contracts/:id/lock-escrow — Payment + batch EscrowCreate ───────────
// Enterprise sends XRP to gov wallet; gov creates N periodic + 1 bonus escrow.
// Both pool escrows have Destination=enterprise so only gov can redirect on violation.

app.post('/contracts/:id/lock-escrow', async (req, res) => {
  const { enterpriseSeed } = req.body as { enterpriseSeed: string };
  const govSeed = process.env.GOVERNMENT_SEED;
  if (!enterpriseSeed) { res.status(400).json({ error: 'enterpriseSeed required' }); return; }
  if (!govSeed) { res.status(500).json({ error: 'GOVERNMENT_SEED not set in .env' }); return; }

  const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
  if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

  const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
  if (!instance.regulatorAddress) { res.status(400).json({ error: 'contract has no regulatorAddress' }); return; }

  const client = new Client(XRPL_WSS);
  try {
    await client.connect();
    const enterpriseWallet = Wallet.fromSeed(enterpriseSeed);
    const govWallet = Wallet.fromSeed(govSeed);

    const { template } = instance;
    const periods = template.periods;
    const totalDrops = Number(instance.totalLocked);  // already stored in drops
    const periodicDrops = Math.floor(totalDrops * template.compliancePoolPct / 100);
    const bonusDrops = totalDrops - periodicDrops;
    const sliceDrops = Math.floor(periodicDrops / periods);
    const rippleNow = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

    // Step 1 — Payment: enterprise → government (full amount)
    const { hash: paymentTxHash } = await xrplSubmit(enterpriseWallet, {
      TransactionType: 'Payment',
      Account: enterpriseWallet.address,
      Destination: govWallet.address,
      Amount: String(totalDrops),
    }, client);

    // Step 2 — N periodic escrows from gov → enterprise
    // FinishAfter staggered at 30s per period (demo-friendly)
    // CancelAfter = FinishAfter + 60s so gov can cancel on violation after the window
    const periodicSequences: number[] = [];
    const periodicTxHashes: string[] = [];
    for (let i = 0; i < periods; i++) {
      const finishAfter = rippleNow + (i + 1) * 30;
      const { hash, sequence } = await xrplSubmit(govWallet, {
        TransactionType: 'EscrowCreate',
        Account: govWallet.address,
        Destination: instance.enterpriseAddress,
        Amount: String(sliceDrops),
        FinishAfter: finishAfter,
        CancelAfter: finishAfter + 60,
        Memos: [
          { Memo: { MemoType: toMemo('ContractId'), MemoData: toMemo(instance.id) } },
          { Memo: { MemoType: toMemo('Period'),     MemoData: toMemo(String(i)) } },
          { Memo: { MemoType: toMemo('Pool'),       MemoData: toMemo('periodic') } },
        ],
      }, client);
      periodicSequences.push(sequence);
      periodicTxHashes.push(hash);
    }

    // Step 3 — 1 final bonus escrow from gov → enterprise
    const bonusFinishAfter = rippleNow + (periods + 1) * 30;
    const { hash: bonusTxHash, sequence: bonusSequence } = await xrplSubmit(govWallet, {
      TransactionType: 'EscrowCreate',
      Account: govWallet.address,
      Destination: instance.enterpriseAddress,
      Amount: String(bonusDrops),
      FinishAfter: bonusFinishAfter,
      CancelAfter: bonusFinishAfter + 60,
      Memos: [
        { Memo: { MemoType: toMemo('ContractId'), MemoData: toMemo(instance.id) } },
        { Memo: { MemoType: toMemo('Pool'),       MemoData: toMemo('final-bonus') } },
      ],
    }, client);

    const updated: ContractInstance = {
      ...instance,
      complianceChildEscrows: periodicSequences,
      complianceEscrowSequence: bonusSequence,
      activatedAt: new Date().toISOString(),
      status: 'active',
    };
    await writeFile(filePath, JSON.stringify(updated, null, 2));

    res.json({ paymentTxHash, periodicTxHashes, periodicSequences, bonusTxHash, bonusSequence });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    await client.disconnect();
  }
});

// ─── submitPeriodCore — shared logic for period submission ────────────────────

async function submitPeriodCore(contractId: string, periodIndex: number, metricValue: number, govSeedOverride?: string) {
    const filePath = join(CONTRACTS_DIR, `${contractId}.json`);
    if (!existsSync(filePath)) throw new Error('contract not found');

    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));

    const { template } = instance;
    const threshold = instance.thresholdPerPeriod[periodIndex] ?? 0;
    const compliant = template.complianceIsBelow
      ? Number(metricValue) <= threshold
      : Number(metricValue) >= threshold;
    const verdict = compliant ? 'compliant' : 'violation';

    const totalDrops = Number(instance.totalLocked);  // already stored in drops
    const periodicDrops = Math.floor(totalDrops * template.compliancePoolPct / 100);
    const sliceDrops = Math.floor(periodicDrops / template.periods);
    const bonusDrops = totalDrops - periodicDrops;

    let txHash = '';

    // On-chain escrow release — uses provided seed or GOVERNMENT_SEED env var
    const govSeed = govSeedOverride || process.env.GOVERNMENT_SEED;
    const escrowSeq = instance.complianceChildEscrows?.[periodIndex];

    if (govSeed) {
      const client = new Client(XRPL_WSS);
      try {
        await client.connect();
        const govWallet = Wallet.fromSeed(govSeed);

        if (instance.hookDeployed) {
          // ── Hook-gated permit system: send GRNT to company's Hook ──────────
          // Regulator grants a claim permit; the winning party then sends CLAM.
          const recipient = compliant ? instance.enterpriseAddress : (instance.contractorAddress || instance.enterpriseAddress);
          const recipientBytes = Buffer.from(decodeAccountID(recipient));
          const memoData = Buffer.alloc(24);
          memoData.writeUInt32BE(periodIndex, 0);
          recipientBytes.copy(memoData, 4);

          const { hash } = await xrplSubmit(govWallet, {
            TransactionType: 'Payment',
            Account: govWallet.address,
            Destination: instance.enterpriseAddress,
            Amount: '1',  // 1 drop to trigger the Hook
            Memos: [{ Memo: {
              MemoType: toMemo('GRNT'),
              MemoData: memoData.toString('hex').toUpperCase(),
            }}],
          }, client);
          txHash = hash;

          // Permit is now stored on-chain in Hook state — no server-side bookkeeping needed
          console.log(`[oracle-run] GRNT sent: period=${periodIndex} permit=${recipient} txHash=${hash}`);

        } else if (escrowSeq !== undefined) {
          // ── Legacy escrow path (no Hook deployed) ─────────────────────────
          if (compliant) {
            // Compliance: EscrowCancel — funds return to company (owner)
            const { hash } = await xrplSubmit(govWallet, {
              TransactionType: 'EscrowCancel',
              Account: govWallet.address,
              Owner: instance.enterpriseAddress,
              OfferSequence: escrowSeq,
            }, client);
            txHash = hash;
          } else {
            // Violation: EscrowFinish — funds go to contractor (Destination set at creation)
            const { hash } = await xrplSubmit(govWallet, {
              TransactionType: 'EscrowFinish',
              Account: govWallet.address,
              Owner: instance.enterpriseAddress,
              OfferSequence: escrowSeq,
            }, client);
            txHash = hash;
          }

          // After last period — settle the bonus escrow
          const isLastPeriod = periodIndex === template.periods - 1;
          if (isLastPeriod) {
            const allResults = [...(instance.periodResults ?? []), { verdict }];
            const allCompliant = allResults.every(r => r.verdict === 'compliant');
            const bonusSeq = instance.complianceEscrowSequence;
            if (bonusSeq !== undefined) {
              if (allCompliant) {
                await xrplSubmit(govWallet, {
                  TransactionType: 'EscrowCancel',
                  Account: govWallet.address,
                  Owner: instance.enterpriseAddress,
                  OfferSequence: bonusSeq,
                }, client);
              } else {
                await xrplSubmit(govWallet, {
                  TransactionType: 'EscrowFinish',
                  Account: govWallet.address,
                  Owner: instance.enterpriseAddress,
                  OfferSequence: bonusSeq,
                }, client);
              }
            }
          }
        }
      } catch (onChainErr) {
        // Non-fatal: record the off-chain result even if on-chain tx fails
        console.error('[period/:n] on-chain error:', String(onChainErr));
      } finally {
        await client.disconnect();
      }
    }

    const result = {
      periodIndex,
      verdict,
      metricValue: Number(metricValue),
      threshold,
      oracleCount: instance.oraclePubkeys?.length ?? 0,
      txHash,
      amountReleased: String(compliant ? sliceDrops : sliceDrops),
      releasedTo: (verdict === 'compliant' ? 'enterprise' : 'contractor') as 'enterprise' | 'contractor',
      claudeExplanation: '',
      timestamp: new Date().toISOString(),
    };

    instance.periodResults = instance.periodResults ?? [];
    instance.periodResults.push(result);
    instance.currentPeriod = periodIndex + 1;
    if (periodIndex === template.periods - 1) instance.status = 'complete';

    await writeFile(filePath, JSON.stringify(instance, null, 2));
    return result;
}

// ─── POST /contracts/:id/period/:n — submit period attestation ───────────────
// Body: { metricValue: number }

app.post('/contracts/:id/period/:n', async (req, res) => {
  try {
    const periodIndex = parseInt(req.params.n, 10);
    const { metricValue, seed } = req.body as { metricValue: number; seed?: string };
    const result = await submitPeriodCore(req.params.id, periodIndex, Number(metricValue), seed);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Mock oracle simulation helpers ──────────────────────────────────────────

function generateMockReadings(
  thresholds: number[],
  scenario: 'all-compliant' | 'all-violation' | 'mixed',
  complianceIsBelow: boolean
): number[] {
  return thresholds.map((threshold, i) => {
    const isCompliantPeriod =
      scenario === 'all-compliant' ? true :
      scenario === 'all-violation' ? false :
      i % 2 === 0;
    if (isCompliantPeriod) {
      return complianceIsBelow ? threshold * 0.85 : threshold * 1.15;
    } else {
      return complianceIsBelow ? threshold * 1.15 : threshold * 0.85;
    }
  });
}

function buildOraclePool(oracleCount: number): OracleConfig[] {
  const count = Math.max(oracleCount, 1);
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    byzantineProbability: count === 1 ? 0 : (i / (count - 1)) * 0.4,
  }));
}

const MOCK_SCENARIO_DEFS: Array<{ name: MockScenario['name']; label: string }> = [
  { name: 'all-compliant', label: 'All Compliant' },
  { name: 'all-violation', label: 'All Violation' },
  { name: 'mixed',         label: 'Mixed (even=OK, odd=breach)' },
];

// ─── simulateOracleConsensus — shared oracle simulation logic ─────────────────

function simulateOracleConsensus(
  instance: ContractInstance,
  periodIndex: number,
  trueReading: number
): { consensus: 'compliant' | 'violation' | 'no-consensus'; truelyCompliant: boolean; oracleVotes: Array<{ oracleIndex: number; reportedReading: number; vote: string; byzantine: boolean }>; compliantVotes: number; violationVotes: number } {
  const threshold = instance.thresholdPerPeriod[periodIndex] ?? 0;
  const truelyCompliant = instance.template.complianceIsBelow
    ? trueReading <= threshold
    : trueReading >= threshold;

  const oraclePool = instance.oraclePool ?? buildOraclePool(instance.template.oracleCount);
  const oracleVotes = oraclePool.map((oracle: OracleConfig) => {
    const lieRoll = Math.random() < oracle.byzantineProbability;
    const reportedCompliant = lieRoll ? !truelyCompliant : truelyCompliant;
    const fabricatedReading = truelyCompliant
      ? trueReading * (instance.template.complianceIsBelow ? 1.3 : 0.7)
      : trueReading * (instance.template.complianceIsBelow ? 0.7 : 1.3);
    return {
      oracleIndex: oracle.index,
      reportedReading: lieRoll ? fabricatedReading : trueReading,
      vote: reportedCompliant ? 'compliant' : 'violation',
      byzantine: lieRoll,
    };
  });

  const M = instance.template.quorumRequired;
  const compliantVotes = oracleVotes.filter(v => v.vote === 'compliant').length;
  const violationVotes = oracleVotes.filter(v => v.vote === 'violation').length;
  const consensus: 'compliant' | 'violation' | 'no-consensus' =
    compliantVotes >= M ? 'compliant' :
    violationVotes >= M ? 'violation' :
    'no-consensus';

  return { consensus, truelyCompliant, oracleVotes, compliantVotes, violationVotes };
}

// ─── Oracle worker infrastructure ────────────────────────────────────────────

const contractWorkers = new Map<string, NodeJS.Timeout>();

function getPeriodSecs(template: ContractTemplate): number {
  const envSecs = parseInt(process.env.DEMO_PERIOD_SECONDS ?? '', 10);
  if (!isNaN(envSecs) && envSecs > 0) return envSecs;
  return template.periodLengthDays * 86400;
}

function getPeriodMs(template: ContractTemplate): number {
  return getPeriodSecs(template) * 1000;
}

async function runOraclePeriod(contractId: string): Promise<void> {
  const filePath = join(CONTRACTS_DIR, `${contractId}.json`);
  if (!existsSync(filePath)) { contractWorkers.delete(contractId); return; }

  const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
  if (instance.status !== 'active') { contractWorkers.delete(contractId); return; }

  const periodIndex = instance.currentPeriod;
  const scenario = (instance.activeScenario ?? 'all-compliant') as 'all-compliant' | 'all-violation' | 'mixed';
  const mockScenario = instance.mockScenarios?.find(s => s.name === scenario);
  const trueReading = mockScenario?.periodReadings[periodIndex] ?? instance.thresholdPerPeriod[periodIndex];

  // Simulate oracle consensus
  const { consensus } = simulateOracleConsensus(instance, periodIndex, trueReading);

  // For no-consensus: use the true reading anyway (oracle logic resolves it)
  const metricToSubmit = trueReading;
  console.log(`[oracle] contract=${contractId} period=${periodIndex} scenario=${scenario} consensus=${consensus} metric=${metricToSubmit.toFixed(2)}`);

  try {
    await submitPeriodCore(contractId, periodIndex, metricToSubmit);
  } catch (e) {
    console.error(`[oracle] submitPeriodCore failed for ${contractId} period ${periodIndex}:`, String(e));
  }

  // Re-load to check status, then schedule next
  if (existsSync(filePath)) {
    const updated: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    if (updated.status === 'active') {
      const t = setTimeout(() => runOraclePeriod(contractId), getPeriodMs(instance.template));
      contractWorkers.set(contractId, t);
    } else {
      contractWorkers.delete(contractId);
      console.log(`[oracle] contract=${contractId} complete, worker stopped`);
    }
  }
}

function startOracleWorker(contractId: string, delayMs: number): void {
  if (contractWorkers.has(contractId)) clearTimeout(contractWorkers.get(contractId)!);
  const t = setTimeout(() => runOraclePeriod(contractId), delayMs);
  contractWorkers.set(contractId, t);
  console.log(`[oracle] worker scheduled for ${contractId} in ${Math.round(delayMs / 1000)}s`);
}

async function rehydrateWorkers(): Promise<void> {
  try {
    const contracts = await readJsonDir<ContractInstance>(CONTRACTS_DIR);
    const now = Date.now();
    for (const instance of contracts) {
      if (instance.status !== 'active') continue;
      const periodMs = getPeriodMs(instance.template);
      const origin = new Date(instance.activatedAt ?? instance.createdAt).getTime();
      const nextDue = origin + (instance.currentPeriod + 1) * periodMs;
      const delay = Math.max(0, nextDue - now);
      startOracleWorker(instance.id, delay);
    }
  } catch (e) {
    console.error('[oracle] rehydrateWorkers error:', String(e));
  }
}

// ─── POST /auth/wallet — derive address+pubkey from seed (no network call) ────

app.post('/auth/wallet', (req, res) => {
  const { seed } = req.body as { seed: string };
  if (!seed) { res.status(400).json({ error: 'seed required' }); return; }
  try {
    const w = Wallet.fromSeed(seed);
    res.json({ address: w.address, classicAddress: w.classicAddress, publicKey: w.publicKey });
  } catch (e) {
    res.status(400).json({ error: 'invalid seed: ' + String(e) });
  }
});

// ─── GET /xrpl/address-from-pubkey/:pubkey ────────────────────────────────────

app.get('/xrpl/address-from-pubkey/:pubkey', (req, res) => {
  try {
    const address = deriveAddress(req.params.pubkey);
    res.json({ address });
  } catch (e) {
    res.status(400).json({ error: 'invalid public key: ' + String(e) });
  }
});

// ─── GET /xrpl/hooks/:address — unresolved EscrowObjects ──────────────────────

app.get('/xrpl/hooks/:address', async (req, res) => {
  const client = new Client(XRPL_WSS);
  try {
    await client.connect();
    const r = await client.request({
      command: 'account_objects',
      account: req.params.address,
      type: 'escrow',
      ledger_index: 'validated',
    });
    res.json(r.result.account_objects ?? []);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    await client.disconnect();
  }
});

// ─── GET /regulator/:address/templates ────────────────────────────────────────

app.get('/regulator/:address/templates', async (req, res) => {
  try {
    const local = await readJsonDir<ContractTemplate>(TEMPLATES_DIR);
    const addr = req.params.address;
    const filtered = local.filter(
      t => t.governmentAddress === addr || t.createdBy === addr
    );
    // Attempt on-chain namespace read; fall back gracefully on non-Hooks testnet
    let onChain: unknown[] = [];
    try {
      const client = new Client(XRPL_WSS);
      await client.connect();
      const r = await (client as unknown as { request: (x: unknown) => Promise<{ result: { namespace_entries?: unknown[] } }> })
        .request({ command: 'account_namespace', account: addr });
      await client.disconnect();
      onChain = r.result?.namespace_entries ?? [];
    } catch { /* ignore: Hooks not available on this testnet */ }
    res.json({ local: filtered, onChain });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /regulator/templates — publish on-chain + save JSON ─────────────────

app.post('/regulator/templates', async (req, res) => {
  const { seed, template } = req.body as { seed: string; template: ContractTemplate };
  if (!seed || !template) { res.status(400).json({ error: 'seed and template required' }); return; }
  try {
    const wallet = Wallet.fromSeed(seed);
    await ensureDirs();
    let txHash: string | null = null;
    // Attempt on-chain publish; non-fatal if Hooks not enabled
    try {
      const client = new Client(XRPL_WSS);
      await client.connect();
      // Encode template name+id as hex memo and send self-payment to install into namespace
      const { hash } = await xrplSubmit(wallet, {
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: wallet.address,
        Amount: '1',
        Memos: [
          { Memo: { MemoType: toMemo('PublishTemplate'), MemoData: toMemo(template.id) } },
          { Memo: { MemoType: toMemo('TemplateName'),    MemoData: toMemo(template.name) } },
        ],
      }, client);
      await client.disconnect();
      txHash = hash;
    } catch { /* non-fatal */ }
    const enriched: ContractTemplate = {
      ...template,
      governmentAddress: wallet.address,
      createdBy: wallet.address,
    };
    await writeFile(join(TEMPLATES_DIR, `${template.id}.json`), JSON.stringify(enriched, null, 2));
    res.json({ ok: true, txHash, savedLocally: true, id: template.id, address: wallet.address });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /regulator/templates/:id/cancel ────────────────────────────────────

app.post('/regulator/templates/:id/cancel', async (req, res) => {
  const { seed } = req.body as { seed: string };
  const templateNumericId = parseInt(req.params.id, 10);
  if (!seed) { res.status(400).json({ error: 'seed required' }); return; }
  try {
    const wallet = Wallet.fromSeed(seed);
    const client = new Client(XRPL_WSS);
    await client.connect();
    const memoData = Buffer.alloc(4);
    // Use hash of templateId string as numeric id if NaN
    const numId = isNaN(templateNumericId) ? 0 : templateNumericId;
    memoData.writeUInt32BE(numId, 0);
    const { hash } = await xrplSubmit(wallet, {
      TransactionType: 'Payment',
      Account: wallet.address,
      Destination: wallet.address,
      Amount: '1',
      Memos: [
        {
          Memo: {
            MemoType: Buffer.from('CANCEL_TEMPLATE', 'ascii').toString('hex').toUpperCase(),
            MemoData: memoData.toString('hex').toUpperCase(),
          },
        },
      ],
    }, client);
    await client.disconnect();
    res.json({ ok: true, txHash: hash });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /contracts/sign — company signs contract, creates period + bonus escrows ─

app.post('/contracts/sign', async (req, res) => {
  const { seed, templateId, regulatorAddress, totalDrops, thresholds } = req.body as {
    seed: string;
    templateId: string;
    regulatorAddress: string;
    totalDrops: number;
    thresholds: number[];
  };
  if (!seed || !templateId || !regulatorAddress || !totalDrops) {
    res.status(400).json({ error: 'seed, templateId, regulatorAddress, totalDrops required' }); return;
  }

  const templatePath = join(TEMPLATES_DIR, `${templateId}.json`);
  if (!existsSync(templatePath)) { res.status(404).json({ error: 'template not found' }); return; }

  try {
    const template: ContractTemplate = JSON.parse(await readFile(templatePath, 'utf-8'));
    const wallet = Wallet.fromSeed(seed);
    const client = new Client(XRPL_WSS);
    await client.connect();

    const periods = template.periods;
    const periodicDrops = Math.floor(totalDrops * template.compliancePoolPct / 100);
    const bonusDrops = totalDrops - periodicDrops;
    const sliceDrops = Math.floor(periodicDrops / periods);
    const rippleNow = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH;

    const periodicSequences: number[] = [];
    const periodicTxHashes: string[] = [];

    const periodSecs = getPeriodSecs(template);
    for (let i = 0; i < periods; i++) {
      const finishAfter = rippleNow + (i + 1) * periodSecs;
      const { hash, sequence } = await xrplSubmit(wallet, {
        TransactionType: 'EscrowCreate',
        Account: wallet.address,
        Destination: template.contractorAddress || regulatorAddress,  // violation: EscrowFinish pays contractor; compliance: EscrowCancel returns to company
        Amount: String(sliceDrops),
        FinishAfter: finishAfter,
        CancelAfter: finishAfter + Math.max(periodSecs, 60),
        Memos: [
          { Memo: { MemoType: toMemo('TemplateId'), MemoData: toMemo(templateId) } },
          { Memo: { MemoType: toMemo('Period'),     MemoData: toMemo(String(i)) } },
        ],
      }, client);
      periodicSequences.push(sequence);
      periodicTxHashes.push(hash);
    }

    const bonusFinish = rippleNow + (periods + 1) * periodSecs;
    const { hash: bonusTxHash, sequence: bonusSeq } = await xrplSubmit(wallet, {
      TransactionType: 'EscrowCreate',
      Account: wallet.address,
      Destination: regulatorAddress,
      Amount: String(bonusDrops),
      FinishAfter: bonusFinish,
      CancelAfter: bonusFinish + Math.max(periodSecs, 60),
      Memos: [
        { Memo: { MemoType: toMemo('TemplateId'), MemoData: toMemo(templateId) } },
        { Memo: { MemoType: toMemo('Pool'),       MemoData: toMemo('final-bonus') } },
      ],
    }, client);

    await ensureDirs();

    // Generate mock scenarios and oracle pool
    const effectiveThresholds = thresholds?.length === periods
      ? thresholds
      : Array(periods).fill(100);

    const mockScenarios: MockScenario[] = MOCK_SCENARIO_DEFS.map(s => ({
      name: s.name,
      label: s.label,
      periodReadings: generateMockReadings(effectiveThresholds, s.name, template.complianceIsBelow),
    }));

    const oraclePool: OracleConfig[] = buildOraclePool(template.oracleCount);

    const contractId = `${templateId}-${wallet.address.slice(-8)}-${Date.now()}`;
    const instance: ContractInstance = {
      id: contractId,
      templateId,
      template,
      enterpriseName: wallet.address,
      enterpriseAddress: wallet.address,
      contractorAddress: template.contractorAddress ?? '',
      regulatorAddress,
      totalLocked: String(totalDrops),
      compliancePool: String(periodicDrops),
      penaltyPool: String(bonusDrops),
      thresholdPerPeriod: effectiveThresholds,
      oraclePubkeys: [],
      currentPeriod: 0,
      periodResults: [],
      status: 'active',
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      complianceChildEscrows: periodicSequences,
      complianceEscrowSequence: bonusSeq,
      mockScenarios,
      oraclePool,
      activeScenario: 'all-compliant',
    };
    await writeFile(join(CONTRACTS_DIR, `${contractId}.json`), JSON.stringify(instance, null, 2));

    // Oracle workers no longer auto-start — use the Run Oracle button in the dashboard instead

    // Deploy compliance Hook on company account (same wallet/client, already connected)
    let hookTxHash: string | undefined;
    let hookError: string | undefined;
    try {
      hookTxHash = await deployHook(instance, wallet, client);
      instance.hookDeployed = true;
      await writeFile(join(CONTRACTS_DIR, `${contractId}.json`), JSON.stringify(instance, null, 2));
      console.log(`[sign] Hook deployed: ${hookTxHash}`);
    } catch (hookErr) {
      // WASM may not be compiled yet — contract is still usable without the hook
      hookError = String(hookErr);
      console.warn(`[sign] Hook deploy skipped: ${hookError}`);
    }

    await client.disconnect();
    res.json({ contractId, periodicTxHashes, periodicSequences, bonusTxHash, bonusSequence: bonusSeq, hookTxHash, hookError });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /contracts/:id/simulate-period/:n — oracle simulation ───────────────

app.post('/contracts/:id/simulate-period/:n', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    const periodIndex = parseInt(req.params.n, 10);
    const { scenario } = req.body as { scenario: 'all-compliant' | 'all-violation' | 'mixed' };

    if (!instance.mockScenarios || !instance.oraclePool) {
      res.status(400).json({ error: 'contract has no mock simulation data' }); return;
    }

    const mockScenario = instance.mockScenarios.find(s => s.name === scenario);
    if (!mockScenario) { res.status(400).json({ error: 'unknown scenario' }); return; }

    const trueReading = mockScenario.periodReadings[periodIndex] ?? 0;
    const { consensus, truelyCompliant, oracleVotes, compliantVotes, violationVotes } =
      simulateOracleConsensus(instance, periodIndex, trueReading);

    res.json({
      periodIndex,
      trueReading,
      truelyCompliant,
      oracleVotes,
      compliantVotes,
      violationVotes,
      consensus,
      quorumRequired: instance.template.quorumRequired,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /contracts/:id/oracle-run/:n — simulate oracles + submit period ─────

app.post('/contracts/:id/oracle-run/:n', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    const periodIndex = parseInt(req.params.n, 10);

    if (!instance.mockScenarios) {
      res.status(400).json({ error: 'contract has no mock scenario data' }); return;
    }

    const scenario = (instance.activeScenario ?? 'all-compliant') as 'all-compliant' | 'all-violation' | 'mixed';
    const mockScenario = instance.mockScenarios.find(s => s.name === scenario);
    if (!mockScenario) { res.status(400).json({ error: 'unknown scenario' }); return; }

    const trueReading = mockScenario.periodReadings[periodIndex] ?? instance.thresholdPerPeriod[periodIndex];
    const { consensus, truelyCompliant, oracleVotes, compliantVotes, violationVotes } =
      simulateOracleConsensus(instance, periodIndex, trueReading);

    const { seed } = req.body as { seed?: string };
    console.log(`[oracle-run] contract=${req.params.id} period=${periodIndex} scenario=${scenario} consensus=${consensus} metric=${trueReading.toFixed(2)}`);

    const periodResult = await submitPeriodCore(req.params.id, periodIndex, trueReading, seed);

    res.json({
      periodIndex,
      trueReading,
      truelyCompliant,
      oracleVotes,
      compliantVotes,
      violationVotes,
      consensus,
      quorumRequired: instance.template.quorumRequired,
      periodResult,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── PATCH /contracts/:id/scenario — persist active scenario selection ────────

app.patch('/contracts/:id/scenario', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }
    const { scenario } = req.body as { scenario: 'all-compliant' | 'all-violation' | 'mixed' };
    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    instance.activeScenario = scenario;
    await writeFile(filePath, JSON.stringify(instance, null, 2));
    res.json({ ok: true, scenario });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── GET /contracts/:id/oracle-status — worker status + next fire time ────────

app.get('/contracts/:id/oracle-status', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }
    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    const running = contractWorkers.has(req.params.id);
    const periodMs = getPeriodMs(instance.template);
    const origin = new Date(instance.activatedAt ?? instance.createdAt).getTime();
    const nextFireAt = origin + (instance.currentPeriod + 1) * periodMs;
    res.json({ running, nextFireAt, currentPeriod: instance.currentPeriod, status: instance.status });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── deployHook — shared helper to install compliance Hook on company account ─

async function deployHook(
  instance: ContractInstance,
  wallet: Wallet,
  client: Client,
): Promise<string> {
  const { template } = instance;

  const wasmPath = join(__dirname, '../hook/compliance_hook.wasm');
  if (!existsSync(wasmPath)) {
    throw new Error(`WASM not found at ${wasmPath} — run: cd hook && make`);
  }
  const wasmBytes = await readFile(wasmPath);
  const wasmHex = wasmBytes.toString('hex').toUpperCase();

  const totalDrops = Number(instance.totalLocked);
  const periodicDrops = Math.floor(totalDrops * template.compliancePoolPct / 100);
  const sliceDrops = Math.floor(periodicDrops / template.periods);
  const mThreshold = Math.ceil(template.oracleCount * 0.6);

  const encodeParam = (address: string) =>
    Buffer.from(decodeAccountID(address)).toString('hex').toUpperCase();
  const encodeU8 = (v: number) => Buffer.from([v]).toString('hex').toUpperCase();
  const encodeU64 = (v: number) => {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(v));
    return buf.toString('hex').toUpperCase();
  };

  const hookParams = [
    { HookParameter: { HookParameterName: toMemo('REGULATOR'),    HookParameterValue: encodeParam(instance.regulatorAddress) } },
    { HookParameter: { HookParameterName: toMemo('CONTRACTOR'),   HookParameterValue: encodeParam(instance.contractorAddress || instance.regulatorAddress) } },
    { HookParameter: { HookParameterName: toMemo('SCHEMA_VER'),   HookParameterValue: encodeU8(1) } },
    { HookParameter: { HookParameterName: toMemo('M_THRESHOLD'),  HookParameterValue: encodeU8(mThreshold) } },
    { HookParameter: { HookParameterName: toMemo('K_COMMITTEE'),  HookParameterValue: encodeU8(template.oracleCount) } },
    { HookParameter: { HookParameterName: toMemo('COLLAT_DROPS'), HookParameterValue: encodeU64(totalDrops) } },
    { HookParameter: { HookParameterName: toMemo('SLICE_DROPS'),  HookParameterValue: encodeU64(sliceDrops) } },
  ];

  const { hash } = await xrplSubmit(wallet, {
    TransactionType: 'SetHook',
    Account: wallet.address,
    Hooks: [{
      Hook: {
        CreateCode: wasmHex,
        HookOn: '0000000000000000000000000000000000000000000000000000000000000000',
        HookNamespace: Buffer.alloc(32).toString('hex').toUpperCase(),
        HookApiVersion: 0,
        HookParameters: hookParams,
        Flags: 1,  // hsfOVERRIDE
      },
    }],
  }, client);

  return hash;
}

// ─── POST /contracts/:id/deploy-hook — fallback re-deploy endpoint ────────────
// Normally the hook is deployed automatically at signing time.
// This endpoint allows re-deployment if the hook is ever removed.

app.post('/contracts/:id/deploy-hook', async (req, res) => {
  const { seed } = req.body as { seed: string };
  if (!seed) { res.status(400).json({ error: 'seed required' }); return; }

  const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
  if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

  try {
    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    const wallet = Wallet.fromSeed(seed);
    const client = new Client(XRPL_WSS);
    await client.connect();
    try {
      const hash = await deployHook(instance, wallet, client);
      instance.hookDeployed = true;
      await writeFile(filePath, JSON.stringify(instance, null, 2));
      res.json({ txHash: hash, hookAccount: wallet.address });
    } finally {
      await client.disconnect();
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── POST /contracts/:id/claim/:n — permitted party claims period funds ────────
// Body: { seed: string }  (company or contractor seed)
// Sends CLAM payment to the company account, triggering the Hook.

app.post('/contracts/:id/claim/:n', async (req, res) => {
  const { seed } = req.body as { seed: string };
  const periodIndex = parseInt(req.params.n, 10);
  if (!seed) { res.status(400).json({ error: 'seed required' }); return; }
  if (isNaN(periodIndex)) { res.status(400).json({ error: 'invalid period index' }); return; }

  const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
  if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

  try {
    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    if (!instance.hookDeployed) {
      res.status(400).json({ error: 'Hook not deployed for this contract' }); return;
    }

    const wallet = Wallet.fromSeed(seed);
    const memoData = Buffer.alloc(4);
    memoData.writeUInt32BE(periodIndex, 0);

    const client = new Client(XRPL_WSS);
    await client.connect();
    try {
      const { hash } = await xrplSubmit(wallet, {
        TransactionType: 'Payment',
        Account: wallet.address,
        Destination: instance.enterpriseAddress,
        Amount: '1',  // 1 drop; Hook uses SLICE_DROPS param for the actual release amount
        Memos: [{ Memo: {
          MemoType: toMemo('CLAM'),
          MemoData: memoData.toString('hex').toUpperCase(),
        }}],
      }, client);

      // Claim recorded on-chain via the CLAM tx — no server-side bookkeeping needed
      res.json({ txHash: hash, claimer: wallet.address, success: true });
    } finally {
      await client.disconnect();
    }
  } catch (e) {
    // Hook rollback surfaces as a transaction error — return it as a structured response
    const errStr = String(e);
    const hookMsg = errStr.match(/compliance_hook: (.+?)(?:"|\n|$)/)?.[1];
    res.status(200).json({
      success: false,
      error: hookMsg ? `Hook rejected: ${hookMsg}` : errStr,
    });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3001;
app.listen(PORT, async () => {
  await ensureDirs();
  console.log(`NuclearEscrow API server running at http://localhost:${PORT}`);
  console.log(`  GET  /state`);
  console.log(`  POST /deploy`);
  console.log(`  POST /milestone/:phase`);
  console.log(`  GET  /templates`);
  console.log(`  POST /templates`);
  console.log(`  GET  /contracts`);
  console.log(`  POST /contracts`);
  console.log(`  PATCH /contracts/:id`);
  console.log(`  POST /ai/draft-template`);
  console.log(`  POST /ai/draft-template/stream`);
  console.log(`  POST /ai/explain`);
  console.log(`  POST /ai/evaluate-compliance`);
  console.log(`  POST /contracts/:id/period/:n`);
  console.log(`  PATCH /contracts/:id/scenario`);
  console.log(`  GET  /contracts/:id/oracle-status`);
  console.log(`  POST /contracts/:id/deploy-hook`);
  console.log(`  POST /contracts/:id/claim/:n`);
});
