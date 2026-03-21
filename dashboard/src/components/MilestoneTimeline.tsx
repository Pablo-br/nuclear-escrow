import { useState } from 'react';
import { type MilestoneEvent } from '../mock-data.ts';

const STEPS = [
  { name: 'Shutdown',        pct: '0%'       },
  { name: 'Defueling',       pct: '15%'      },
  { name: 'Fuel storage',    pct: '20%'      },
  { name: 'Decontamination', pct: '20%'      },
  { name: 'Demolition',      pct: '20%'      },
  { name: 'Soil remediation',pct: '20%'      },
  { name: 'Site release',    pct: '5% + yield'},
];

interface Props {
  currentMilestone: number;
  milestoneHistory: MilestoneEvent[];
}

function truncateHash(hash: string): string {
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 6)}…${hash.slice(-6)}`;
}

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatRlusd(raw: string): string {
  const n = Number(raw);
  if (n === 0) return '—';
  return n.toLocaleString('en-US') + ' RLUSD';
}

export function MilestoneTimeline({ currentMilestone, milestoneHistory }: Props) {
  const [activeTooltip, setActiveTooltip] = useState<number | null>(null);

  const historyMap = new Map(milestoneHistory.map(m => [m.index, m]));

  const handleClick = (i: number, isCompleted: boolean) => {
    if (!isCompleted) return;
    setActiveTooltip(prev => (prev === i ? null : i));
  };

  // Close tooltip when clicking outside
  const handleTrackClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.milestone-step')) return;
    setActiveTooltip(null);
  };

  return (
    <div className="card milestone-timeline">
      <div className="card-header">
        <h2>Decommissioning Milestones</h2>
        <span className="badge badge--amber">
          M{currentMilestone} Active
        </span>
      </div>
      <div className="card-body">
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div className="milestone-timeline__track" onClick={handleTrackClick}>
          {STEPS.map((step, i) => {
            const isCompleted = i < currentMilestone;
            const isActive    = i === currentMilestone;

            let stepClass = 'milestone-step';
            if (isCompleted)    stepClass += ' milestone-step--completed';
            else if (isActive)  stepClass += ' milestone-step--active';
            else                stepClass += ' milestone-step--locked';

            const event = historyMap.get(i);
            const showTooltip = activeTooltip === i;

            const dotContent = isCompleted ? '✓' : isActive ? '●' : '🔒';

            return (
              <div
                key={i}
                className={stepClass}
                onClick={() => handleClick(i, isCompleted)}
                title={isCompleted ? 'Click for details' : undefined}
              >
                <div className="milestone-step__dot">{dotContent}</div>
                <div className="milestone-step__name">M{i}: {step.name}</div>
                <div className="milestone-step__pct">{step.pct}</div>

                {showTooltip && event && (
                  <div className="milestone-tooltip">
                    <div className="milestone-tooltip__row">
                      <span className="milestone-tooltip__label">Completed</span>
                      <span className="milestone-tooltip__val">{formatTs(event.timestamp)}</span>
                    </div>
                    <div className="milestone-tooltip__row">
                      <span className="milestone-tooltip__label">Radiation</span>
                      <span className="milestone-tooltip__val">{event.radiationReading} μSv/h</span>
                    </div>
                    <div className="milestone-tooltip__row">
                      <span className="milestone-tooltip__label">Released</span>
                      <span className="milestone-tooltip__val">{formatRlusd(event.rlusdReleased)}</span>
                    </div>
                    <div className="milestone-tooltip__row">
                      <span className="milestone-tooltip__label">Tx</span>
                      <span className="milestone-tooltip__val">
                        <a
                          href={`https://testnet.xrpl.org/transactions/${event.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          onClick={e => e.stopPropagation()}
                        >
                          {truncateHash(event.txHash)}
                        </a>
                      </span>
                    </div>
                    {event.oracleIds.length > 0 && (
                      <div className="milestone-tooltip__row">
                        <span className="milestone-tooltip__label">Oracles</span>
                        <span className="milestone-tooltip__val">
                          {event.oracleIds.map(id =>
                            `${id.slice(0, 6)}…${id.slice(-4)}`
                          ).join(', ')}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
