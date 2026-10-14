import { useState } from 'react';
import { NumberRow, Section, StatRow, type NumberSpec } from '../components/Inspector';
import type { NodeConfig, SimNode } from '../sim/types';
import type { LiveEngine } from './LiveEngine';
import type { LiveView } from './mapping';
import './live.css';

const POOL_SPEC: NumberSpec = {
  control: 'number',
  label: 'Connections kept open',
  unit: 'conns',
  min: 0,
  max: 64,
  step: 1,
  hint: '0 opens a new connection for every request. A load balancer like this one picks a backend per connection, not per request, so a few long-lived connections pin all of this client’s traffic to a few backends.',
};

const AGE_SPEC: NumberSpec = {
  control: 'number',
  label: 'Reconnect after',
  unit: 'ms',
  min: 0,
  max: 60000,
  step: 1000,
  hint: '0 keeps a connection forever. Anything else closes and reopens each kept connection this often, which lets the load balancer spread the traffic again. Values under 1000 are raised to 1000.',
};

const SLOW_SPEC: NumberSpec = {
  control: 'number',
  label: 'Slow down by',
  unit: 'times',
  min: 2,
  max: 50,
  step: 1,
};
const ERR_SPEC: NumberSpec = {
  control: 'number',
  label: 'Error share',
  unit: '%',
  min: 1,
  max: 100,
  step: 1,
};

export function LivePanel({
  node,
  view,
  engine,
  onChange,
}: {
  node: SimNode;
  view: LiveView;
  engine: LiveEngine;
  onChange: (id: string, patch: Partial<NodeConfig>) => void;
}) {
  const [factor, setFactor] = useState(4);
  const [errPct, setErrPct] = useState(30);
  const nv = view.nodes[node.id];
  // Faults and drains act on a running process. A detached or pending backend
  // has none yet (the bridge would refuse), and a stopping one is going away.
  const running =
    nv !== undefined &&
    ['starting', 'serving', 'unhealthy', 'draining', 'crashed'].includes(nv.phase);

  return (
    <>
      {node.kind === 'lb' && (
        <p className="ins-blurb live-note">
          This is the real maglev-lb. Backends answer clients directly, so it never sees
          a reply and has no response time of its own; what it spends is CPU per packet.
        </p>
      )}

      {nv ? (
        <Section title="In the live system">
          <div className="ins-stats">
            {nv.facts.map(([k, v]) => (
              <StatRow key={k} label={k} value={v} />
            ))}
          </div>
        </Section>
      ) : (
        <Section title="In the live system">
          <p className="ins-hint">
            {view.connection === 'live'
              ? 'Waiting for this component to start.'
              : 'Not connected to the bridge.'}
          </p>
        </Section>
      )}

      {node.kind === 'service' && nv && !running && (
        <p className="ins-hint">
          {nv.phase === 'detached'
            ? 'Not started: draw a wire from the load balancer to this backend to give it a real process.'
            : nv.phase === 'pending'
              ? 'Waiting for a free backend slot.'
              : 'Shutting down.'}
        </p>
      )}

      {node.kind === 'client' && (
        <Section title="Connections">
          <div className="ins-fields">
            <NumberRow
              spec={POOL_SPEC}
              value={node.config.poolSize ?? 0}
              onChange={(v) => onChange(node.id, { poolSize: v })}
            />
            <NumberRow
              spec={AGE_SPEC}
              value={node.config.maxConnAgeMs ?? 0}
              onChange={(v) => onChange(node.id, { maxConnAgeMs: v })}
            />
          </div>
        </Section>
      )}

      {node.kind === 'service' && nv && running && (
        <Section title="Break it">
          {nv.fault === 'crash' ? (
            <div className="live-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => engine.restart(node.id)}
              >
                Restart the process
              </button>
            </div>
          ) : (
            <>
              <div className="live-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => engine.injectFailure(node.id, 'crash')}
                >
                  Crash the process
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => engine.injectFailure(node.id, 'partition')}
                  title="Its health checks still pass, so the load balancer keeps sending traffic into nothing"
                >
                  Cut its data path
                </button>
              </div>
              <div className="ins-fields">
                <NumberRow spec={SLOW_SPEC} value={factor} onChange={setFactor} />
              </div>
              <div className="live-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => engine.injectFailure(node.id, 'slow', { factor })}
                >
                  Slow it down
                </button>
              </div>
              <div className="ins-fields">
                <NumberRow spec={ERR_SPEC} value={errPct} onChange={setErrPct} />
              </div>
              <div className="live-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    engine.injectFailure(node.id, 'errors', { rate: errPct / 100 })
                  }
                >
                  Make it fail requests
                </button>
              </div>
            </>
          )}
          {nv.fault && nv.fault !== 'crash' && (
            <div className="live-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => engine.clearFailure(node.id)}
              >
                Fix it
              </button>
            </div>
          )}
          <p className="ins-hint">
            These act on the real backend process. Watch how long the load balancer
            takes to notice each one, or whether it notices at all.
          </p>
        </Section>
      )}

      {node.kind === 'service' && nv && running && nv.fault !== 'crash' && (
        <Section title="Take it out of rotation">
          <div className="live-actions">
            {nv.draining ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => engine.undrain(node.id)}
              >
                Accept new connections again
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => engine.drain(node.id)}
              >
                Stop new connections
              </button>
            )}
          </div>
          <p className="ins-hint">
            Draining sends no new connections here but lets the ones already pinned
            finish, so nothing fails. Compare it with crashing the process.
          </p>
        </Section>
      )}

      {node.kind === 'lb' && view.events.length > 0 && (
        <Section title="What just happened">
          <ol className="live-events">
            {view.events
              .slice(-8)
              .reverse()
              .map((e, i) => (
                <li key={`${e.tMs}-${i}`} className={`live-event is-${e.level}`}>
                  <span className="live-event-t">{(e.tMs / 1000).toFixed(1)}s</span>{' '}
                  {e.msg}
                </li>
              ))}
          </ol>
        </Section>
      )}
    </>
  );
}
