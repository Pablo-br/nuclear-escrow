import express from 'express';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { Client, Wallet } from 'xrpl';
import { SensorSimulator, PHASE_THRESHOLDS } from '../oracle/src/sensor-simulator.ts';
// No mock contracts — all contracts are created through the UI with real wallets

const XRPL_WS = 'wss://s.altnet.rippletest.net:51233';

async function submitEscrowFinish(companySeed: string, ownerAddress: string, escrowSequence: number): Promise<string> {
  const client = new Client(XRPL_WS);
  await client.connect();
  try {
    const wallet = Wallet.fromSeed(companySeed);
    const result = await client.submitAndWait({
      TransactionType: 'EscrowFinish',
      Account: wallet.classicAddress,
      Owner: ownerAddress,
      OfferSequence: escrowSequence,
    } as any, { wallet });
    const hash: string = (result.result as any).hash ?? (result.result as any).tx_json?.hash ?? '';
    const txResult: string = (result.result as any).meta?.TransactionResult ?? 'unknown';
    console.log(`[EscrowFinish] seq=${escrowSequence} result=${txResult} hash=${hash}`);
    if (txResult !== 'tesSUCCESS') throw new Error(`EscrowFinish failed: ${txResult}`);
    return hash;
  } finally {
    await client.disconnect();
  }
}

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

let contracts: any[] = [];

// ─── GET & POST /contracts ──────────────────────────────────────────────────
app.get('/contracts', (req, res) => {
  res.json(contracts);
});

app.post('/contracts', (req, res) => {
  const newContract = req.body;
  console.log(`[POST /contracts] New contract: id=${newContract.id}, govWallet=${newContract.governmentWallet}, companyWallet=${newContract.companyWallet}`);
  contracts.push(newContract);
  res.json(newContract);
});

app.post('/contracts/:id/accept', (req, res) => {
  const { id } = req.params;
  const { acceptanceTxHash, escrowSequences, companySeed, companyAddress, totalDrops, dropsPerPhase } = req.body || {};
  contracts = contracts.map(c =>
    c.id === id ? {
      ...c,
      status: 'active',
      fundsFrozen: c.totalAmount,
      acceptanceTxHash: acceptanceTxHash || c.acceptanceTxHash || '',
      escrowSequences: escrowSequences || c.escrowSequences || [],
      companySeed: companySeed || c.companySeed || '',
      companyAddress: companyAddress || c.companyAddress || '',
      totalDrops: totalDrops ?? c.totalDrops ?? 0,
      dropsPerPhase: dropsPerPhase ?? c.dropsPerPhase ?? 0,
    } : c
  );
  console.log(`[POST /contracts/${id}/accept] acceptanceTxHash=${acceptanceTxHash || '(none)'} escrows=${JSON.stringify(escrowSequences || [])}`);
  res.json({ success: true });
});

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

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = 3001;
app.listen(PORT, () => {
  console.log(`NuclearEscrow API server running at http://localhost:${PORT}`);
  console.log(`  GET  /state`);
  console.log(`  GET  /contracts`);
  console.log(`  POST /contracts`);
  console.log(`  POST /deploy`);
  console.log(`  POST /milestone/:phase`);
});

// ─── Sensor Automation Cycle (1 Minute) ───────────────────────────────────────
const processingContracts = new Set<string>();

setInterval(async () => {
  console.log(`[Cron] Executing 1-minute sensor checking cycle...`);
  for (const c of contracts) {
    if (c.status === 'active' && c.currentPhase < 7 && !processingContracts.has(c.id)) {
      const sim = new SensorSimulator(c.facilityName);
      // Advance sensor to match contract phase
      for (let i = 0; i < c.currentPhase; i++) sim.advancePhase();

      const batch = sim.getCurrentBatch();
      const threshold = PHASE_THRESHOLDS[c.currentPhase];

      if (batch.median < threshold) {
        console.log(`[Cron] Contract ${c.id} passed phase ${c.currentPhase} sensor check (${batch.median} < ${threshold}).`);

        const phaseAmount = c.dropsPerPhase > 0 ? c.dropsPerPhase : Math.floor(c.totalAmount * 0.15);
        let txHash = '';

        // Submit real EscrowFinish if we have the escrow data
        if (c.companySeed && c.companyAddress && c.escrowSequences && c.escrowSequences[c.currentPhase]) {
          processingContracts.add(c.id);
          try {
            console.log(`[Cron] Submitting EscrowFinish for contract ${c.id} phase ${c.currentPhase} seq=${c.escrowSequences[c.currentPhase]}...`);
            txHash = await submitEscrowFinish(c.companySeed, c.companyAddress, c.escrowSequences[c.currentPhase]);
            console.log(`[Cron] EscrowFinish SUCCESS: ${txHash}`);
          } catch (err: any) {
            console.error(`[Cron] EscrowFinish FAILED for ${c.id} phase ${c.currentPhase}: ${err.message}`);
            processingContracts.delete(c.id);
            continue; // Skip updating state if TX failed
          }
          processingContracts.delete(c.id);
        } else {
          console.log(`[Cron] No escrow data for ${c.id}, updating balances in memory only.`);
        }

        c.fundsFrozen = Math.max(0, c.fundsFrozen - phaseAmount);
        c.fundsRecovered += phaseAmount;
        c.history.push({
          timestamp: Date.now(),
          radiationLevel: batch.median,
          threshold: threshold,
          passed: true,
          amountToCompany: phaseAmount,
          amountToGovernment: 0,
          txHash,
        });

        c.currentPhase += 1;
        if (c.currentPhase >= 7) {
          c.status = 'completed';
          console.log(`[Cron] Contract ${c.id} COMPLETED.`);
        }
      } else {
        console.log(`[Cron] Contract ${c.id} failed phase ${c.currentPhase} sensor check (${batch.median} >= ${threshold}).`);
        c.history.push({
          timestamp: Date.now(),
          radiationLevel: batch.median,
          threshold: threshold,
          passed: false,
          amountToCompany: 0,
          amountToGovernment: 0,
          txHash: '',
        });
      }
    }
  }
}, 60000);
