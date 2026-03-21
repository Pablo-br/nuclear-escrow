import { useState, useEffect, useRef } from 'react';

interface TerminalModalProps {
  url: string;
  title: string;
  onClose: () => void;
}

export function TerminalModal({ url, title, onClose }: TerminalModalProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running');
  const bottomRef = useRef<HTMLDivElement>(null);

  // Start streaming on mount
  useEffect(() => {
    let cancelled = false;
    const decoder = new TextDecoder();

    (async () => {
      try {
        const resp = await fetch(url, { method: 'POST' });
        if (!resp.body) throw new Error('No response body');

        let rawBuffer = '';
        const reader = resp.body.getReader();

        while (true) {
          const { done, value } = await reader.read();
          if (cancelled) { reader.cancel(); return; }
          if (done) break;
          rawBuffer += decoder.decode(value, { stream: true });
          setLines(rawBuffer.split('\n'));
        }

        setStatus(rawBuffer.trimEnd().endsWith('[exit 0]') ? 'done' : 'error');
      } catch (err) {
        if (!cancelled) {
          setLines(prev => [...prev, `[client error] ${String(err)}`]);
          setStatus('error');
        }
      }
    })();

    return () => { cancelled = true; };
  }, [url]);

  // Auto-scroll to bottom as output grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const canClose = status !== 'running';

  return (
    <div
      className="terminal-modal__backdrop"
      onClick={canClose ? onClose : undefined}
    >
      <div
        className="terminal-modal__panel"
        onClick={e => e.stopPropagation()}
      >
        <div className="terminal-modal__header">
          <span className="terminal-modal__title">{title}</span>
          {status === 'running' && <span className="terminal-modal__spinner" aria-label="Running" />}
          {status === 'done'    && <span className="terminal-modal__status terminal-modal__status--ok">Done ✓</span>}
          {status === 'error'   && <span className="terminal-modal__status terminal-modal__status--err">Error ✗</span>}
          {canClose && (
            <button className="terminal-modal__close" onClick={onClose}>Close</button>
          )}
        </div>
        <pre className="terminal-modal__output">
          {lines.join('\n')}
          <div ref={bottomRef} />
        </pre>
      </div>
    </div>
  );
}
