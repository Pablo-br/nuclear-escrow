import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { OnChainEscrow } from '../../../shared/src/contract-template.js';

const RIPPLE_EPOCH = 946684800;

function rippleToDate(ts: number): string {
  return new Date((ts + RIPPLE_EPOCH) * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function decodeMemoHex(hex: string): string {
  try { return Buffer.from(hex, 'hex').toString('utf-8'); } catch { return hex; }
}

function getMemoValue(escrow: OnChainEscrow, key: string): string | null {
  if (!escrow.Memos) return null;
  const keyHex = Buffer.from(key, 'utf-8').toString('hex').toUpperCase();
  for (const { Memo } of escrow.Memos) {
    if (Memo.MemoType?.toUpperCase() === keyHex && Memo.MemoData) {
      return decodeMemoHex(Memo.MemoData);
    }
  }
  return null;
}

function dropsToXrp(drops: string): string {
  const n = Number(drops) / 1_000_000;
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

interface Props {
  address: string;
}

export function ActiveHooksPanel({ address }: Props) {
  const [escrows, setEscrows] = useState<OnChainEscrow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!address) { setLoading(false); return; }
    let active = true;

    const load = () => {
      fetch(`/xrpl/hooks/${address}`)
        .then(r => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<OnChainEscrow[]>;
        })
        .then(data => {
          if (!active) return;
          setEscrows(data);
          setLoading(false);
        })
        .catch(e => {
          if (!active) return;
          setError(String(e));
          setLoading(false);
        });
    };

    load();
    const id = setInterval(load, 5000);
    return () => { active = false; clearInterval(id); };
  }, [address]);

  if (!address) return null;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3 style={{ margin: 0, fontSize: 15 }}>Active On-Chain Hooks</h3>
        <span style={{ fontSize: 12, opacity: 0.7 }}>Unresolved escrows · refreshes every 5s</span>
      </div>
      <div className="card-body">
        {loading && <div style={{ color: 'var(--c-muted)', fontSize: 14 }}>Loading escrows…</div>}
        {error && <div className="banner banner--red">{error}</div>}
        {!loading && !error && escrows.length === 0 && (
          <div className="hooks-panel__empty">No active escrows on chain for this address.</div>
        )}
        {!loading && escrows.length > 0 && (
          <div className="hooks-panel__list">
            {escrows.map(escrow => {
              const templateId = getMemoValue(escrow, 'TemplateId');
              const period = getMemoValue(escrow, 'Period');
              const pool = getMemoValue(escrow, 'Pool');
              const label = pool === 'final-bonus'
                ? 'Bonus Escrow'
                : period !== null
                  ? `Period ${Number(period) + 1}`
                  : 'Escrow';

              return (
                <div key={escrow.index} className="hooks-panel__item">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{label}</div>
                    {templateId && (
                      <div style={{ fontSize: 11, color: 'var(--c-muted)' }}>
                        Template: {templateId.slice(0, 24)}{templateId.length > 24 ? '…' : ''}
                      </div>
                    )}
                  </div>
                  <div className="hooks-panel__amount">{dropsToXrp(escrow.Amount)} XRP</div>
                  <div className="hooks-panel__deadline">
                    {escrow.FinishAfter ? rippleToDate(escrow.FinishAfter) : '—'}
                  </div>
                  <div>
                    {templateId && period !== null ? (
                      <Link
                        to={`/contract/${templateId}-${escrow.Account.slice(-8)}`}
                        style={{ fontSize: 12, color: 'var(--c-teal)' }}
                      >
                        View
                      </Link>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--c-muted)' }}>—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
