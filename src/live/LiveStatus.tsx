import type { LiveView } from './mapping';
import './live.css';

const CONN_TEXT: Record<LiveView['connection'], string> = {
  connecting: 'Connecting to the live system',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Bridge not reachable',
  unauthorized: 'Open the link the bridge printed: this tab has no access token',
};

function usd(x: number): string {
  return `$${x.toFixed(2)}`;
}

function minutes(s: number): string {
  return `${Math.ceil(s / 60)} min`;
}

/**
 * One line saying whether the numbers on screen are real right now, and if
 * not, why. Everything that goes wrong in live mode (no bridge, an expired
 * token, a design the real system cannot run) surfaces here rather than as
 * a canvas that silently stops moving. What AWS is running and costing is
 * LiveCloud's, on a row of its own under the bar, so this stays short and
 * the load control beside it keeps its room.
 */
export function LiveStatus({ view }: { view: LiveView }) {
  const issues = [...view.errors, ...view.problems.map((p) => p.message)];
  let text = CONN_TEXT[view.connection];
  if (view.connection === 'live' && view.phase && view.phase !== 'ready') {
    text =
      view.phase === 'degraded'
        ? 'Live, but maglev-lb is not running'
        : view.cloud
          ? 'Live, EC2 instances starting'
          : 'Live system starting';
  } else if (view.connection === 'live' && view.autoPaused) {
    text = 'Live, load paused while no tab was watching';
  }
  return (
    <div className={`live-status is-${view.connection}`} role="status" data-chrome="">
      <span className="live-status-dot" aria-hidden="true" />
      <span>{text}</span>
      {issues.length > 0 && (
        <span className="live-status-issues" title={issues.join('\n')}>
          {issues.length === 1 ? '1 issue' : `${issues.length} issues`}
        </span>
      )}
    </div>
  );
}

/**
 * On AWS: what is running, what it is costing, and the way to stop it, as a
 * second row of the top bar. Nothing when the bridge runs locally.
 */
export function LiveCloud({ view, onStop }: { view: LiveView; onStop?: () => void }) {
  const cloud = view.cloud;
  if (!cloud || view.connection !== 'live') return null;
  return (
    <div className="live-cloud-row">
      <div
        className="app-island live-cloud"
        role="status"
        aria-label="AWS usage"
        data-chrome=""
      >
        <span
          className="live-status-cloud"
          title={`Estimated by the bridge. AWS's bill is the real number. Everything stops at ${usd(cloud.budgetUsd)}, or in ${minutes(cloud.sessionLeftS)}, or 10 minutes after the last tab closes.`}
        >
          AWS {cloud.region}: {cloud.running} of {cloud.hosts.length} instances running,{' '}
          about {usd(cloud.usdPerHour)}/h, {usd(cloud.spentUsd)} so far
        </span>
        {onStop && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={cloud.stopping !== null}
            onClick={onStop}
            title="Stops every EC2 instance and ends the bridge. Start again with cloud/canvas.sh run."
          >
            {cloud.stopping ? 'Stopping' : 'Stop all on AWS'}
          </button>
        )}
      </div>
    </div>
  );
}
