import { useState, useEffect, useRef } from 'react';

interface Props {
  balance: string;
  yieldEarned: string;
}

export function EscrowBalance({ balance, yieldEarned }: Props) {
  const [displayYield, setDisplayYield] = useState(parseFloat(yieldEarned));
  const startRef = useRef(parseFloat(yieldEarned));

  // Update baseline when prop changes
  useEffect(() => {
    startRef.current = parseFloat(yieldEarned);
    setDisplayYield(parseFloat(yieldEarned));
  }, [yieldEarned]);

  // Increment by 0.001 every second
  useEffect(() => {
    const id = setInterval(() => {
      setDisplayYield(prev => parseFloat((prev + 0.001).toFixed(3)));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const localeBalance = Number(balance).toLocaleString('en-US');
  const localeYield = displayYield.toLocaleString('en-US', {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });

  return (
    <div className="card escrow-balance">
      <div className="card-header">
        <h2>Escrow Balance</h2>
      </div>
      <div className="card-body">
        <div className="escrow-balance__amount">
          <span className="escrow-balance__number">{localeBalance}</span>
          <span className="escrow-balance__currency">RLUSD</span>
          <span className="escrow-balance__label">locked on-chain</span>
        </div>

        <div className="escrow-balance__yield">
          <span className="escrow-balance__yield-label">AMM yield earned:</span>
          <span className="escrow-balance__yield-value">{localeYield} RLUSD</span>
        </div>

        <p className="escrow-balance__warning">
          Operator cannot withdraw. Funds release only on verified milestones.
        </p>
      </div>
    </div>
  );
}
