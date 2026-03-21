import { type OracleNode } from '../mock-data.ts';

interface Props {
  oracles: OracleNode[];
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function OracleHealth({ oracles }: Props) {
  return (
    <div className="card oracle-health">
      <div className="card-header">
        <h2>Oracle Network</h2>
        <span className="badge badge--teal">
          {oracles.filter(o => o.status === 'online').length}/{oracles.length} Online
        </span>
      </div>
      <div className="card-body">
        <div className="oracle-grid--5">
          {oracles.map(oracle => (
            <div key={oracle.index} className="oracle-card">
              <div className="oracle-card__header">
                <div
                  className={`oracle-card__status oracle-card__status--${oracle.status}`}
                />
                <div className="oracle-card__title">Oracle {oracle.index + 1}</div>
                {oracle.contributedToLastQuorum && (
                  <span className="badge badge--teal" style={{ marginLeft: 'auto', fontSize: '10px' }}>
                    Quorum
                  </span>
                )}
              </div>
              <div className="oracle-card__address">
                {truncateAddress(oracle.address)}
              </div>
              <div className="oracle-card__attest">
                Last attestation: {oracle.lastAttestationMinutesAgo} min ago
              </div>
              {oracle.contributedToLastQuorum && (
                <div className="oracle-card__quorum">Signed last milestone</div>
              )}
            </div>
          ))}
        </div>
        <p className="oracle-caption">3-of-5 quorum required to verify each milestone</p>
      </div>
    </div>
  );
}
