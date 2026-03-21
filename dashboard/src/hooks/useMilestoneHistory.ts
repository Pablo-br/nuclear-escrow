import { useState, useEffect } from 'react';
import { type MilestoneEvent, MOCK_MILESTONE_HISTORY } from '../mock-data.ts';

interface MilestoneHistoryResult {
  milestones: MilestoneEvent[];
  loading: boolean;
}

// XRPL epoch offset: 2000-01-01 00:00:00 UTC in Unix seconds
const XRPL_EPOCH_OFFSET = 946684800;

async function xrplRpc(method: string, params: unknown): Promise<unknown> {
  const resp = await fetch('/xrpl-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: [params] }),
  });
  const json = await resp.json() as { result: unknown };
  return json.result;
}

export function useMilestoneHistory(escrowOwner: string): MilestoneHistoryResult {
  const [milestones, setMilestones] = useState<MilestoneEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (escrowOwner === 'mock') {
      setMilestones(MOCK_MILESTONE_HISTORY);
      setLoading(false);
      return;
    }

    let active = true;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchHistory = async () => {
      try {
        const result = await xrplRpc('account_tx', {
          account: escrowOwner,
          ledger_index_min: -1,
          ledger_index_max: -1,
          limit: 200,
        }) as { transactions?: unknown[] };

        if (!active) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txList: any[] = result?.transactions ?? [];

        const events: MilestoneEvent[] = [];

        for (const entry of txList) {
          const tx = entry.tx ?? entry.transaction ?? {};
          const meta = entry.meta ?? entry.metaData ?? {};

          if (tx.TransactionType !== 'EscrowFinish') continue;
          if (meta.TransactionResult !== 'tesSUCCESS') continue;

          // Extract milestone index from memos
          const memos: { Memo?: { MemoData?: string } }[] = tx.Memos ?? [];
          let milestoneIndex = events.length; // fallback

          for (const m of memos) {
            const data = m.Memo?.MemoData;
            if (data) {
              try {
                const decoded = decodeURIComponent(
                  data.replace(/../g, '%$&')
                );
                const parsed: unknown = JSON.parse(decoded);
                if (typeof parsed === 'object' && parsed !== null && 'milestone' in parsed) {
                  milestoneIndex = Number((parsed as { milestone: unknown }).milestone);
                }
              } catch {
                // ignore parse errors
              }
            }
          }

          const timestamp = tx.date != null
            ? (Number(tx.date) + XRPL_EPOCH_OFFSET) * 1000
            : Date.now();

          const delivered = meta.delivered_amount ?? meta.DeliveredAmount ?? '0';
          const rlusdReleased = typeof delivered === 'string' ? delivered
            : typeof delivered === 'object' && delivered !== null && 'value' in delivered
              ? String((delivered as { value: unknown }).value)
              : '0';

          events.push({
            index: milestoneIndex,
            txHash: tx.hash ?? '',
            timestamp,
            rlusdReleased,
            radiationReading: 0,
            oracleIds: [],
          });
        }

        // Sort by milestone index
        events.sort((a, b) => a.index - b.index);
        setMilestones(events);
        setLoading(false);
      } catch {
        if (!active) return;
        setMilestones([]);
        setLoading(false);
      }
    };

    void fetchHistory();
    intervalId = setInterval(() => { void fetchHistory(); }, 8000);

    return () => {
      active = false;
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [escrowOwner]);

  return { milestones, loading };
}
