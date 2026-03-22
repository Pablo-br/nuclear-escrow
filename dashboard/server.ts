import 'dotenv/config';
import express from 'express';
import { readFile, writeFile, readdir, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { Client, Wallet } from 'xrpl';
import { draftTemplate, explainTemplate, evaluateCompliance, streamDraftTemplate } from '../api/claude-assistant.js';
import type { ContractTemplate, ContractInstance } from '../shared/src/contract-template.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Allow browser fetch from Vite dev server
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

// ─── POST /contracts/:id/lock-escrow — create EscrowCreate on XRPL ───────────

app.post('/contracts/:id/lock-escrow', async (req, res) => {
  const { enterpriseSeed } = req.body as { enterpriseSeed: string };
  if (!enterpriseSeed) { res.status(400).json({ error: 'enterpriseSeed required' }); return; }

  const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
  if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

  const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
  const destination = instance.regulatorAddress;
  if (!destination) { res.status(400).json({ error: 'contract has no regulatorAddress (government address)' }); return; }

  const client = new Client('wss://s.altnet.rippletest.net:51233');
  try {
    await client.connect();
    const wallet = Wallet.fromSeed(enterpriseSeed);

    // Ripple epoch: seconds since 2000-01-01T00:00:00Z
    const RIPPLE_EPOCH = 946684800;
    const periods = instance.template.periods;
    const periodDays = instance.template.periodLengthDays;
    const lockDurationSecs = periods * periodDays * 86400;
    const finishAfter = Math.floor(Date.now() / 1000) - RIPPLE_EPOCH + lockDurationSecs;

    const toHex = (s: string) => Buffer.from(s, 'utf-8').toString('hex').toUpperCase();

    const tx: Record<string, unknown> = {
      TransactionType: 'EscrowCreate',
      Account: wallet.address,
      Destination: destination,
      Amount: '1000000', // 1 XRP collateral (RLUSD liability stored in memo)
      FinishAfter: finishAfter,
      Memos: [
        { Memo: { MemoType: toHex('ContractId'),     MemoData: toHex(instance.id) } },
        { Memo: { MemoType: toHex('LiabilityRlusd'), MemoData: toHex(instance.totalLocked) } },
      ],
    };

    const prepared = await client.autofill(tx);
    const signed = wallet.sign(prepared as Parameters<typeof wallet.sign>[0]);
    const result = await client.submitAndWait(signed.tx_blob);

    const txHash: string = (result.result as Record<string, unknown>).hash as string;
    const sequence: number = (result.result as Record<string, unknown>).Sequence as number
      ?? ((result.result as Record<string, unknown>).tx_json as Record<string, unknown>)?.Sequence as number;

    // Persist escrow state on the contract
    const updated: ContractInstance = {
      ...instance,
      complianceEscrowSequence: sequence,
      activatedAt: new Date().toISOString(),
      status: 'active',
    };
    await writeFile(filePath, JSON.stringify(updated, null, 2));

    res.json({ txHash, sequence });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  } finally {
    await client.disconnect();
  }
});

// ─── POST /contracts/:id/period/:n — submit period attestation ───────────────
// Body: { verdict: 'compliant' | 'violation', metricValue, oracleSigs?, txHash }

app.post('/contracts/:id/period/:n', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    const periodIndex = parseInt(req.params.n, 10);
    const { verdict, metricValue, txHash, claudeExplanation } = req.body;

    const threshold = instance.thresholdPerPeriod[periodIndex] ?? 0;
    const pct = instance.template.periodDistribution[periodIndex] ?? 0;
    const pool = verdict === 'compliant' ? instance.compliancePool : instance.penaltyPool;
    const amountReleased = String(Math.floor(Number(pool) * pct / 100));

    const result = {
      periodIndex,
      verdict,
      metricValue,
      threshold,
      oracleCount: instance.oraclePubkeys.length,
      txHash: txHash ?? '',
      amountReleased,
      releasedTo: verdict === 'compliant' ? 'enterprise' : 'contractor',
      claudeExplanation: claudeExplanation ?? '',
      timestamp: new Date().toISOString(),
    };

    instance.periodResults = instance.periodResults ?? [];
    instance.periodResults.push(result);
    instance.currentPeriod = periodIndex + 1;

    await writeFile(filePath, JSON.stringify(instance, null, 2));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3001;
app.listen(PORT, () => {
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
});
