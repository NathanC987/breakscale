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
 * a canvas that silently stops moving. On AWS it also says what is running,
 * what that is costing, and offers the way to stop it.
 */
export function LiveStatus({
  view,
  onStopCloud,
}: {
  view: LiveView;
  onStopCloud?: () => void;
}) {
  const issues = [...view.errors, ...view.problems.map((p) => p.message)];
  const cloud = view.cloud;
  let text = CONN_TEXT[view.connection];
  if (view.connection === 'live' && view.phase && view.phase !== 'ready') {
    text =
      view.phase === 'degraded'
        ? 'Live, but maglev-lb is not running'
        : cloud
          ? 'Live, EC2 instances starting'
          : 'Live system starting';
  } else if (view.connection === 'live' && view.autoPaused) {
    text = 'Live, load paused while no tab was watching';
  }
  return (
    <div className={`live-status is-${view.connection}`} role="status" data-chrome="">
      <span className="live-status-dot" aria-hidden="true" />
      <span>{text}</span>
      {cloud && view.connection === 'live' && (
        <span
          className="live-status-cloud"
          title={`Estimated by the bridge. AWS's bill is the real number. Everything stops at ${usd(cloud.budgetUsd)}, or in ${minutes(cloud.sessionLeftS)}, or 10 minutes after the last tab closes.`}
        >
          AWS {cloud.region}: {cloud.running} of {cloud.hosts.length} instances running,{' '}
          about {usd(cloud.usdPerHour)}/h, {usd(cloud.spentUsd)} so far
        </span>
      )}
      {cloud && view.connection === 'live' && onStopCloud && (
        <button
          type="button"
          className="btn btn-sm"
          disabled={cloud.stopping !== null}
          onClick={onStopCloud}
          title="Stops every EC2 instance and ends the bridge. Start again with cloud/canvas.sh run."
        >
          {cloud.stopping ? 'Stopping' : 'Stop all on AWS'}
        </button>
      )}
      {issues.length > 0 && (
        <span className="live-status-issues" title={issues.join('\n')}>
          {issues.length === 1 ? '1 issue' : `${issues.length} issues`}
        </span>
      )}
    </div>
  );
}
