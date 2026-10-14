import type { LiveView } from './mapping';
import './live.css';

const CONN_TEXT: Record<LiveView['connection'], string> = {
  connecting: 'Connecting to the live system',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Bridge not reachable',
  unauthorized: 'Open the link the bridge printed: this tab has no access token',
};

/**
 * One line saying whether the numbers on screen are real right now, and if
 * not, why. Everything that goes wrong in live mode (no bridge, an expired
 * token, a design the real system cannot run) surfaces here rather than as
 * a canvas that silently stops moving.
 */
export function LiveStatus({ view }: { view: LiveView }) {
  const issues = [...view.errors, ...view.problems.map((p) => p.message)];
  let text = CONN_TEXT[view.connection];
  if (view.connection === 'live' && view.phase && view.phase !== 'ready') {
    text =
      view.phase === 'degraded'
        ? 'Live, but maglev-lb is not running'
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
