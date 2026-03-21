import { useState, useEffect } from 'react';
import { Client } from 'xrpl';
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

// ─── Hook ────────────────────────────────────────────────────────────────────

interface EscrowStateResult {
  siteState: SiteState | null;
  escrowBalance: string;
  loading: boolean;
  error: string | null;
}

export function useEscrowState(escrowOwner: string, escrowSequence: number): EscrowStateResult {
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

    const client = new Client('wss://s.altnet.rippletest.net:51233');
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let active = true;

    const poll = async () => {
      try {
        const resp = await client.request({
          command: 'ledger_entry',
          escrow: { owner: escrowOwner, seq: escrowSequence },
          ledger_index: 'validated',
        });

        if (!active) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const node = (resp.result as any).node ?? {};
        const amount: string = node.Amount ?? '0';
        setEscrowBalance(amount);

        const dataHex: string | undefined = node.Data;
        if (dataHex) {
          setSiteState(decodeSiteState(dataHex));
        }

        setError(null);
        setLoading(false);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };

    const run = async () => {
      try {
        await client.connect();
        await poll();
        intervalId = setInterval(poll, 4000);
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
      void client.disconnect();
    };
  }, [escrowOwner, escrowSequence]);

  return { siteState, escrowBalance, loading, error };
}
