import { useState } from 'react';
import type { WalletSession } from '../../../shared/src/contract-template.js';

interface Props {
  label: string;
  onConnect: (session: WalletSession, seed: string) => void;
  connected: WalletSession | null;
}

export function WalletConnect({ label, onConnect, connected }: Props) {
  const [seed, setSeed] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const handleDerive = async () => {
    if (!seed.trim()) return;
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/auth/wallet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seed }),
      });
      if (!resp.ok) {
        const err = await resp.json() as { error: string };
        throw new Error(err.error ?? 'Failed to derive wallet');
      }
      const session = await resp.json() as WalletSession;
      onConnect(session, seed);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const copyPubkey = () => {
    if (!connected) return;
    navigator.clipboard.writeText(connected.publicKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (connected) {
    return (
      <div className="wallet-connect wallet-connect--connected">
        <div className="wallet-connect__label">{label}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 2 }}>Address</div>
          <code style={{ fontSize: 13, wordBreak: 'break-all' }}>{connected.address}</code>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, color: 'var(--c-muted)', marginBottom: 2 }}>Public Key</div>
          <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{connected.publicKey.slice(0, 24)}…</code>
          <button
            className="portal-btn portal-btn--ghost"
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11 }}
            onClick={copyPubkey}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <span className="badge badge--green">Connected</span>
      </div>
    );
  }

  return (
    <div className="wallet-connect">
      <div className="wallet-connect__label">{label}</div>
      <div
        className="banner banner--warn"
        style={{ marginBottom: 12, fontSize: 13 }}
      >
        Your seed is sent to the local server only to sign transactions. It is never stored or logged.
      </div>
      <div className="form-row">
        <label className="form-row__label">XRPL Seed</label>
        <input
          className="portal-input"
          type="password"
          placeholder="sEd… or s…"
          value={seed}
          onChange={e => setSeed(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleDerive(); }}
          disabled={loading}
          autoComplete="off"
        />
      </div>
      {error && (
        <div className="banner banner--red" style={{ marginTop: 8 }}>{error}</div>
      )}
      <div style={{ marginTop: 12 }}>
        <button
          className="portal-btn portal-btn--primary"
          onClick={handleDerive}
          disabled={loading || !seed.trim()}
        >
          {loading ? 'Connecting…' : 'Connect Wallet'}
        </button>
      </div>
    </div>
  );
}
