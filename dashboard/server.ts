import express from 'express';
import { readFile } from 'fs/promises';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Allow browser fetch from Vite dev server
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  next();
});

app.options('/{*path}', (_req, res) => { res.sendStatus(204); });

// ─── GET /state ───────────────────────────────────────────────────────────────

app.get('/state', async (_req, res) => {
  try {
    const statePath = join(__dirname, '..', '.nuclear-state.json');
    const raw = await readFile(statePath, 'utf-8');
    res.json(JSON.parse(raw));
  } catch {
    res.status(404).json({ error: 'state file not found' });
  }
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
  console.log(`  POST /milestone/:phase`);
});
