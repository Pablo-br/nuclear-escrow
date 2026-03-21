import { useState, useEffect } from 'react';
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
    // Extract amount from the deleted Escrow ledger object
    const affectedNodes = (meta.AffectedNodes as Array<Record<string, unknown>> | undefined) ?? [];
    let escapedDrops = '0';
    for (const node of affectedNodes) {
      const deleted = node.DeletedNode as Record<string, unknown> | undefined;
      if (deleted?.LedgerEntryType === 'Escrow') {
        const fields = (deleted.FinalFields ?? deleted.NewFields) as Record<string, unknown> | undefined;
        escapedDrops = String(fields?.Amount ?? '0');
        break;
      }
    }
    return {
      timestamp: date,
      eventType: 'EscrowFinish',
      detail: success
        ? `Milestone COMPLETE — ${Number(escapedDrops).toLocaleString()} drops released`
        : `Milestone REJECTED by WASM`,
      txHash: hash,
    };
  }

  if (type === 'MPTokenIssuanceCreate') {
    return {
      timestamp: date,
      eventType: 'Receipt Minted',
      detail: 'Milestone receipt (MPT) issued to contractor',
      txHash: hash,
    };
  }

  return null;
}

export function AuditFeed({ escrowOwner }: Props) {
  const [events, setEvents] = useState<AuditEvent[]>([...MOCK_AUDIT_EVENTS].reverse());

  useEffect(() => {
    if (escrowOwner === 'mock') return;

    let active = true;

    const load = () => {
      fetch('/audit')
        .then(r => r.json())
        .then((entries: Array<Record<string, unknown>>) => {
          if (!active) return;
          const parsed: AuditEvent[] = [];
          for (const entry of entries) {
            const tx = (entry.tx ?? entry.transaction ?? {}) as Record<string, unknown>;
            const meta = (entry.meta ?? entry.metaData ?? {}) as Record<string, unknown>;
            const ev = classifyTx(tx, meta);
            if (ev) parsed.push(ev);
          }
          if (parsed.length > 0) setEvents(parsed);
        })
        .catch(() => { /* keep current events */ });
    };

    load();
    const id = setInterval(load, 4000);
    return () => { active = false; clearInterval(id); };
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
