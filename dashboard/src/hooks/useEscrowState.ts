import { useState, useEffect } from 'react';
import {
  type SiteState,
  MOCK_SITE_STATE,
  MOCK_ESCROW_BALANCE,
} from '../mock-data.ts';

// ─── Browser-native SiteState decoder (mirrors shared/src/index.ts) ──────────

function decodeSiteState(hex: string): SiteState {
  const bytes = new Uint8Array(
    (hex.match(/.{1,2}/g) ?? []).map(b => parseInt(b, 16))
  );
  const view = new DataView(bytes.buffer);
  let offset = 0;

  const current_milestone = bytes[offset++];

  const oracle_pubkeys: Uint8Array[] = [];
  for (let i = 0; i < 5; i++) {
    oracle_pubkeys.push(bytes.slice(offset, offset + 32));
    offset += 32;
  }

  const thresholds: number[] = [];
  for (let i = 0; i < 7; i++) {
    thresholds.push(view.getFloat32(offset, true));
    offset += 4;
  }

  const domain_id = bytes.slice(offset, offset + 32);
  offset += 32;
  const facility_id = bytes.slice(offset, offset + 16);
  offset += 16;

  const milestone_timestamps: bigint[] = [];
  for (let i = 0; i < 7; i++) {
    milestone_timestamps.push(view.getBigUint64(offset, true));
    offset += 8;
  }

  return { current_milestone, oracle_pubkeys, thresholds, domain_id, facility_id, milestone_timestamps };
}

// ─── XRPL HTTP helper (goes through our own server to avoid CORS) ─────────────

async function xrplRpc(method: string, params: unknown): Promise<unknown> {
  const resp = await fetch('/xrpl-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: [params] }),
  });
  const json = await resp.json() as { result: unknown };
  return json.result;
}

// ─── Hook ────────────────────────────────────────────────────────────────────

interface EscrowStateResult {
  siteState: SiteState | null;
  escrowBalance: string;
  loading: boolean;
  error: string | null;
}

export function useEscrowState(escrowOwner: string, escrowSequence: number, childEscrows: number[] = []): EscrowStateResult {
  const [siteState, setSiteState] = useState<SiteState | null>(null);
  const [escrowBalance, setEscrowBalance] = useState<string>('0');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (escrowOwner === 'mock') {
      setSiteState(MOCK_SITE_STATE);
      setEscrowBalance(MOCK_ESCROW_BALANCE);
      setLoading(false);
      return;
    }

    // Reset stale mock state before connecting to real chain
    setSiteState(null);
    setEscrowBalance('0');
    setLoading(true);
    setError(null);

    let active = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      // Try master escrow first, then child escrows in order.
      // The master escrow is deleted after M0; child escrows are deleted as each phase completes.
      const candidates = [escrowSequence, ...childEscrows];
      let found = false;

      for (const seq of candidates) {
        try {
          const result = await xrplRpc('ledger_entry', {
            escrow: { owner: escrowOwner, seq },
            ledger_index: 'validated',
          }) as { status?: string; node?: Record<string, unknown> };

          if (result?.status !== 'success') continue;
          if (!active) return;

          found = true;
          const node = result.node ?? {};
          const amount = (node.Amount as string | undefined) ?? '0';
          setEscrowBalance(amount);

          const dataHex = node.Data as string | undefined;
          if (dataHex) {
            setSiteState(decodeSiteState(dataHex));
          }

          setError(null);
          setLoading(false);
          break;
        } catch {
          // This escrow doesn't exist or errored; try the next one.
          continue;
        }
      }

      if (!active) return;
      if (!found) {
        setError('no active escrow found');
        setLoading(false);
      }
    };

    const run = async () => {
      try {
        await poll();
        if (active) {
          intervalId = setInterval(() => { void poll(); }, 4000);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    void run();

    return () => {
      active = false;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [escrowOwner, escrowSequence]);

  return { siteState, escrowBalance, loading, error };
}
