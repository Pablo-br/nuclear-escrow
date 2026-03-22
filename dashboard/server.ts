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
    const totalDrops = Math.round(Number(instance.totalLocked) * 1_000_000);
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

// ─── POST /contracts/:id/period/:n — submit period attestation ───────────────
// Body: { metricValue: number }
// Verdict is auto-computed from metricValue vs threshold; on-chain release via gov wallet.

app.post('/contracts/:id/period/:n', async (req, res) => {
  try {
    const filePath = join(CONTRACTS_DIR, `${req.params.id}.json`);
    if (!existsSync(filePath)) { res.status(404).json({ error: 'contract not found' }); return; }

    const instance: ContractInstance = JSON.parse(await readFile(filePath, 'utf-8'));
    const periodIndex = parseInt(req.params.n, 10);
    const { metricValue } = req.body as { metricValue: number };

    const { template } = instance;
    const threshold = instance.thresholdPerPeriod[periodIndex] ?? 0;
    const compliant = template.complianceIsBelow
      ? Number(metricValue) <= threshold
      : Number(metricValue) >= threshold;
    const verdict = compliant ? 'compliant' : 'violation';

    const totalDrops = Math.round(Number(instance.totalLocked) * 1_000_000);
    const periodicDrops = Math.floor(totalDrops * template.compliancePoolPct / 100);
    const sliceDrops = Math.floor(periodicDrops / template.periods);
    const bonusDrops = totalDrops - periodicDrops;

    let txHash = '';

    // On-chain escrow release (requires GOVERNMENT_SEED in .env)
    const govSeed = process.env.GOVERNMENT_SEED;
    const escrowSeq = instance.complianceChildEscrows?.[periodIndex];

    if (govSeed && escrowSeq !== undefined) {
      const client = new Client(XRPL_WSS);
      try {
        await client.connect();
        const govWallet = Wallet.fromSeed(govSeed);

        if (compliant) {
          // EscrowFinish — funds go to enterprise
          const { hash } = await xrplSubmit(govWallet, {
            TransactionType: 'EscrowFinish',
            Account: govWallet.address,
            Owner: govWallet.address,
            OfferSequence: escrowSeq,
          }, client);
          txHash = hash;
        } else {
          // EscrowCancel — funds return to gov, then Payment to contractor
          await xrplSubmit(govWallet, {
            TransactionType: 'EscrowCancel',
            Account: govWallet.address,
            Owner: govWallet.address,
            OfferSequence: escrowSeq,
          }, client);
          const { hash } = await xrplSubmit(govWallet, {
            TransactionType: 'Payment',
            Account: govWallet.address,
            Destination: instance.contractorAddress,
            Amount: String(sliceDrops),
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
                TransactionType: 'EscrowFinish',
                Account: govWallet.address,
                Owner: govWallet.address,
                OfferSequence: bonusSeq,
              }, client);
            } else {
              await xrplSubmit(govWallet, {
                TransactionType: 'EscrowCancel',
                Account: govWallet.address,
                Owner: govWallet.address,
                OfferSequence: bonusSeq,
              }, client);
              await xrplSubmit(govWallet, {
                TransactionType: 'Payment',
                Account: govWallet.address,
                Destination: instance.contractorAddress,
                Amount: String(bonusDrops),
              }, client);
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
