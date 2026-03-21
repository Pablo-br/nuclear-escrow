import { useState, useEffect, useRef } from 'react';
import { Client } from 'xrpl';
import { type AuditEvent, MOCK_AUDIT_EVENTS } from '../mock-data.ts';

interface Props {
  escrowOwner: string;
}

// XRPL epoch offset: seconds between 2000-01-01 and 1970-01-01 UTC
const XRPL_EPOCH = 946684800;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function classifyTx(tx: Record<string, unknown>, meta: Record<string, unknown>): AuditEvent | null {
  const type = tx.TransactionType as string | undefined;
  const hash = (tx.hash as string | undefined) ?? '';
  const date = tx.date != null ? (Number(tx.date) + XRPL_EPOCH) * 1000 : Date.now();

  if (!type) return null;

  if (type === 'CredentialCreate') {
    const subject = (tx.Subject as string | undefined) ?? '';
    return {
      timestamp: date,
      eventType: 'CredentialCreate',
      detail: `Credential issued to ${subject}`,
      txHash: hash,
    };
  }

  if (type === 'EscrowCreate') {
    const amount = (tx.Amount as string | undefined) ?? '0';
    return {
      timestamp: date,
      eventType: 'EscrowCreate',
      detail: `Escrow created: ${Number(amount).toLocaleString()} RLUSD locked`,
      txHash: hash,
    };
  }

  if (type === 'EscrowFinish') {
    const result = (meta.TransactionResult as string | undefined) ?? '';
    const success = result === 'tesSUCCESS';
    const delivered = (meta.delivered_amount as string | undefined) ?? '0';
    const memos = (tx.Memos as Array<{ Memo?: { MemoData?: string } }> | undefined) ?? [];
    let milestoneIdx = '?';
    for (const m of memos) {
      const data = m.Memo?.MemoData;
      if (data) {
        try {
          const decoded = decodeURIComponent(data.replace(/../g, '%$&'));
          const parsed: unknown = JSON.parse(decoded);
          if (typeof parsed === 'object' && parsed !== null && 'milestone' in parsed) {
            milestoneIdx = String((parsed as { milestone: unknown }).milestone);
          }
        } catch { /* skip */ }
      }
    }
    return {
      timestamp: date,
      eventType: 'EscrowFinish',
      detail: success
        ? `Milestone ${milestoneIdx} COMPLETE — ${Number(delivered).toLocaleString()} RLUSD released`
        : `Milestone ${milestoneIdx} REJECTED by WASM`,
      txHash: hash,
    };
  }

  if (type === 'MPTokenIssuanceCreate') {
    return {
      timestamp: date,
      eventType: 'MPTokenIssuanceCreate',
      detail: 'Receipt MPT minted for contractor',
      txHash: hash,
    };
  }

  return null;
}

export function AuditFeed({ escrowOwner }: Props) {
  const [events, setEvents] = useState<AuditEvent[]>([...MOCK_AUDIT_EVENTS].reverse());
  const clientRef = useRef<Client | null>(null);

  useEffect(() => {
    if (escrowOwner === 'mock') return;

    const client = new Client('wss://s.altnet.rippletest.net:51233');
    clientRef.current = client;
    let active = true;

    const run = async () => {
      try {
        await client.connect();

        // Load recent history first
        const resp = await client.request({
          command: 'account_tx',
          account: escrowOwner,
          limit: 50,
          ledger_index_min: -1,
          ledger_index_max: -1,
        });

        if (!active) return;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txList: any[] = (resp.result as any).transactions ?? [];
        const initial: AuditEvent[] = [];

        for (const entry of txList) {
          const tx = entry.tx ?? entry.transaction ?? {};
          const meta = entry.meta ?? entry.metaData ?? {};
          const ev = classifyTx(tx as Record<string, unknown>, meta as Record<string, unknown>);
          if (ev) initial.push(ev);
        }

        if (active) {
          setEvents(initial.length > 0 ? initial : [...MOCK_AUDIT_EVENTS].reverse());
        }

        // Subscribe to live transactions
        await client.request({ command: 'subscribe', accounts: [escrowOwner] });

        client.on('transaction', (data) => {
          if (!active) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tx = (data as any).transaction ?? {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const meta = (data as any).meta ?? {};
          const ev = classifyTx(tx as Record<string, unknown>, meta as Record<string, unknown>);
          if (ev) setEvents(prev => [ev, ...prev].slice(0, 100));
        });
      } catch {
        // silently keep mock events on connection failure
      }
    };

    void run();

    return () => {
      active = false;
      void client.disconnect();
    };
  }, [escrowOwner]);

  return (
    <div className="card audit-feed">
      <div className="card-header">
        <h2>On-Chain Audit Feed</h2>
        <span className="badge badge--navy">{escrowOwner === 'mock' ? 'Mock' : 'Live'}</span>
      </div>
      <div className="card-body" style={{ padding: '0' }}>
        <div className="audit-feed__list">
          {events.map((ev, idx) => (
            <div key={idx} className="audit-feed__item">
              <span className="audit-feed__time">{formatTime(ev.timestamp)}</span>
              <span className="audit-feed__type">{ev.eventType}</span>
              <span className="audit-feed__detail">{ev.detail}</span>
              <span className="audit-feed__link">
                {ev.txHash && (
                  <a
                    href={`https://testnet.xrpl.org/transactions/${ev.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    view ↗
                  </a>
                )}
              </span>
            </div>
          ))}
          {events.length === 0 && (
            <div className="loading-msg">No events yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
