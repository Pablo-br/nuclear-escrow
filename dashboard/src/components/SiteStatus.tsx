import { type SiteState } from '../mock-data.ts';

const PHASE_NAMES = [
  'Pre-shutdown',
  'Defueling',
  'Fuel storage',
  'Decontamination',
  'Demolition',
  'Soil remediation',
  'Site released',
];

function facilityIdToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0/g, '');
}

interface Props {
  siteState: SiteState | null;
}

export function SiteStatus({ siteState }: Props) {
  const milestone = siteState?.current_milestone ?? 0;
  const facilityId = siteState ? facilityIdToString(siteState.facility_id) : 'PLANT-FR-001';
  const phaseName = PHASE_NAMES[milestone] ?? 'Unknown';

  const badgeClass =
    milestone === 0 ? 'badge badge--gray'
    : milestone === 6 ? 'badge badge--green'
    : 'badge badge--amber';

  return (
    <div className="card site-status">
      <div className="card-header">
        <h2>Facility Status</h2>
        <span className="badge badge--navy">{facilityId}</span>
      </div>
      <div className="card-body">
        <div className="site-status__phase">
          <span className="site-status__phase-name">{phaseName}</span>
          <span className={badgeClass}>Phase {milestone}</span>
        </div>

        <div className="banner banner--red">
          <span className="banner__icon">🔒</span>
          <strong>Bankruptcy protection: ACTIVE</strong>
          <span> — funds unreachable by creditors</span>
        </div>

        <p className="site-status__domain">
          Operating under Permissioned Domain:{' '}
          <code>nuclear-decommission-FR</code>
        </p>
      </div>
    </div>
  );
}
