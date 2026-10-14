import type {
  ActiveFailure,
  EdgeState,
  FailureReason,
  HistoryPoint,
  NodeStats,
  RequestTrace,
  SimSnapshot,
  Topology,
} from '../sim/types';
import type {
  BridgeBackend,
  BridgeClient,
  BridgeEvent,
  BridgeFaultKind,
  BridgeSnapshot,
} from './bridge';
import type { LiveProblem } from './validate';

/** Same window the simulator keeps: 240 points at the bridge's 4Hz is 60s. */
export const HISTORY_LEN = 240;

const FAILURE_REASONS: readonly FailureReason[] = [
  'error',
  'shed',
  'timeout',
  'no-route',
  'depth',
  'throttled',
  'rejected',
  'crashed',
  'partitioned',
  'region-down',
  'conn-refused',
  'unauthorized',
  'bulkhead-full',
  'acquire-timeout',
  'deprioritized',
];

/**
 * How a real client failure is named in the simulator's vocabulary.
 *
 * `client-overload` is deliberately absent: it means the load generator itself
 * could not keep up, which is a fact about the measuring instrument, not about
 * the system under test. It is surfaced as a warning on the client instead of
 * being counted as a lost request.
 *
 * `partitioned` is never produced either. A client behind a black-holed
 * backend cannot tell that from a slow one; it just times out. That gap is the
 * lesson of the partition fault, so the honest mapping keeps it.
 */
const CLIENT_REASON: Record<string, FailureReason | undefined> = {
  timeout: 'timeout',
  shed: 'shed',
  error: 'error',
  crashed: 'crashed',
  'no-route': 'no-route',
};

export type ConnState =
  'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'offline';

export interface LiveNodeView {
  /** Backend phase or client state, as the bridge reports it. */
  phase: string;
  /** The fault injected here right now, if any. */
  fault: BridgeFaultKind | null;
  /** True while the load balancer is holding new flows away from it. */
  draining: boolean;
  /** Short word for the canvas header, or null when nothing needs saying. */
  badge: string | null;
  /** Read-only facts for the inspector, in display order. */
  facts: readonly (readonly [string, string])[];
}

export interface ReturnEdge {
  id: string;
  /** The backend that replied. */
  from: string;
  /** The client that received the reply, directly. */
  to: string;
  flow: number;
}

export interface LiveLbFacts {
  cpu: number;
  pps: number;
  ceilingPps: number;
  activeFlows: number;
  newFlowsPs: number;
}

export interface LiveView {
  connection: ConnState;
  phase: BridgeSnapshot['status']['phase'] | null;
  loadEnabled: boolean;
  autoPaused: boolean;
  /** Problems the bridge itself reports (no free slot, maglev-lb down...). */
  errors: readonly string[];
  /** What the live system cannot run in this canvas (see validate.ts). */
  problems: readonly LiveProblem[];
  nodes: Readonly<Record<string, LiveNodeView>>;
  lb: LiveLbFacts | null;
  returnEdges: readonly ReturnEdge[];
  events: readonly BridgeEvent[];
}

export function emptyStats(over: Partial<NodeStats> = {}): NodeStats {
  return {
    inFlight: 0,
    queued: 0,
    throughput: 0,
    arrivalRate: 0,
    utilization: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    errorRate: 0,
    shedRate: 0,
    timeoutRate: 0,
    hitRate: 0,
    totalCompleted: 0,
    totalFailed: 0,
    queueLimit: 0,
    staleReadRate: 0,
    maxShardUtilization: 0,
    minShardUtilization: 0,
    shardUtilization: [],
    ...over,
  };
}

function ratio(n: number, d: number): number {
  return d > 0 && Number.isFinite(n) ? Math.min(1, Math.max(0, n / d)) : 0;
}

function num(x: number | undefined): number {
  return Number.isFinite(x) ? (x as number) : 0;
}

function emptyFailures(): Record<FailureReason, number> {
  const out = {} as Record<FailureReason, number>;
  for (const r of FAILURE_REASONS) out[r] = 0;
  return out;
}

export function emptySnapshot(t: Topology): SimSnapshot {
  const nodes: Record<string, NodeStats> = {};
  for (const n of t.nodes)
    nodes[n.id] = emptyStats({ queueLimit: n.config.queueLimit });
  const edgeFlow: Record<string, number> = {};
  const edgeState: Record<string, EdgeState> = {};
  for (const e of t.edges) {
    edgeFlow[e.id] = 0;
    edgeState[e.id] = 'idle';
  }
  return {
    system: {
      timeMs: 0,
      offeredRps: 0,
      goodputRps: 0,
      errorRate: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      totalRequests: 0,
      totalFailed: 0,
    },
    nodes,
    history: [],
    edgeFlow,
    edgeState,
    failuresByReason: emptyFailures(),
    activeFailures: [],
    trace: null,
  };
}

function clientStats(c: BridgeClient): NodeStats {
  const ok = num(c.rates.ok);
  const failed = num(c.rates.failed);
  return emptyStats({
    inFlight: num(c.inFlight),
    throughput: ok,
    arrivalRate: num(c.rates.attempts),
    p50: num(c.latencyMs.p50),
    p95: num(c.latencyMs.p95),
    p99: num(c.latencyMs.p99),
    errorRate: ratio(failed, ok + failed),
    timeoutRate: num(c.failedPsByReason.timeout),
    shedRate: num(c.failedPsByReason.shed),
    totalCompleted: num(c.totals.ok),
    totalFailed: num(c.totals.failed),
  });
}

function backendStats(b: BridgeBackend): NodeStats {
  // A dead process does no work. The bridge already reports zeros for one;
  // this keeps a frame from an older bridge from drawing it busy.
  if (b.proc && !b.proc.alive) {
    return emptyStats({
      totalCompleted: num(b.totals?.ok),
      totalFailed: num(b.totals?.errors) + num(b.totals?.shed),
      queueLimit: b.config.queueLimit,
    });
  }
  const r = b.rates;
  const ok = num(r?.ok);
  const bad = num(r?.errors) + num(r?.shed);
  return emptyStats({
    inFlight: num(b.inFlight),
    queued: num(b.queued),
    throughput: ok,
    arrivalRate: num(r?.arrivals),
    utilization: Math.min(1, num(b.utilization)),
    p50: num(b.latencyMs?.p50),
    p95: num(b.latencyMs?.p95),
    p99: num(b.latencyMs?.p99),
    errorRate: ratio(bad, ok + bad),
    shedRate: num(r?.shed),
    totalCompleted: num(b.totals?.ok),
    totalFailed: num(b.totals?.errors) + num(b.totals?.shed),
    queueLimit: b.config.queueLimit,
  });
}

/**
 * Edge rate and state for lb -> backend.
 *
 * The rate is what the BACKEND says it received while its process is alive.
 * Once it has crashed it can say nothing, so the rate falls back to maglev-lb's
 * own count of new flows it is still pinning there: the wire keeps carrying
 * traffic to a dead box until the health checker notices, which is exactly
 * the window the crash fault exists to show.
 */
function backendEdge(b: BridgeBackend | undefined): [number, EdgeState] {
  if (!b || !b.lb) return [0, 'blocked'];
  const alive = b.proc?.alive ?? false;
  const flow = alive ? num(b.rates?.arrivals) : num(b.lb.flowsAssignedPs);
  if (b.fault?.kind === 'partition') return [flow, 'cut'];
  switch (b.phase) {
    case 'starting':
    case 'stopping':
    case 'pending':
    case 'detached':
      return [0, 'blocked'];
    case 'unhealthy':
      return [flow, 'blocked'];
    case 'crashed':
      return [flow, b.lb.up ? (flow > 0.05 ? 'live' : 'idle') : 'blocked'];
    case 'draining':
      return [flow, flow > 0.05 ? 'live' : 'standby'];
    default:
      return [flow, flow > 0.05 ? 'live' : 'idle'];
  }
}

function fmt(x: number, digits = 0): string {
  return Number.isFinite(x) ? x.toFixed(digits) : '0';
}

function backendView(b: BridgeBackend): LiveNodeView {
  const badge =
    b.fault?.kind === 'partition' && b.phase === 'serving'
      ? 'cut off'
      : b.phase === 'serving'
        ? null
        : b.phase === 'unhealthy'
          ? 'down'
          : b.phase;
  const facts: [string, string][] = [['State', b.phase]];
  if (b.addr) facts.push(['Address', b.addr]);
  if (b.lb) {
    facts.push(['Load balancer health', b.lb.up ? 'up' : 'down']);
    facts.push(['Accepting new flows', b.lb.adminEnabled ? 'yes' : 'no (draining)']);
    facts.push(['New flows per second', fmt(b.lb.flowsAssignedPs, 1)]);
    facts.push(['Flows pinned here', fmt(b.lb.activeFlows)]);
    facts.push(['Failed health checks per second', fmt(b.lb.hcFailuresPs, 1)]);
  }
  if (b.openConns !== undefined) facts.push(['Open connections', fmt(b.openConns)]);
  if (b.rates) facts.push(['Health probes per second', fmt(b.rates.probes, 1)]);
  return {
    phase: b.phase,
    fault: b.fault?.kind ?? null,
    draining: b.lb?.draining ?? false,
    badge,
    facts,
  };
}

function clientView(c: BridgeClient): LiveNodeView {
  const overload = num(c.totals.failedByReason['client-overload']);
  const badge =
    c.behind || overload > 0 ? 'saturated' : c.state === 'running' ? null : c.state;
  const facts: [string, string][] = [
    ['State', c.state],
    ['Source address', c.ip ?? '-'],
    ['Open connections', fmt(c.openConns)],
    ['Retries per second', fmt(c.rates.retries, 1)],
    ['Generator lag', `${fmt(c.lagMs, 1)} ms`],
  ];
  if (c.behind || overload > 0) {
    facts.push([
      'Warning',
      'this load generator cannot keep up; its numbers are unreliable',
    ]);
  }
  return { phase: c.state, fault: null, draining: false, badge, facts };
}

export interface MapResult {
  snapshot: SimSnapshot;
  view: Omit<LiveView, 'connection' | 'problems'>;
}

/**
 * One bridge frame as a SimSnapshot the existing canvas, inspector and
 * charts can draw unchanged, plus the overlay for what the simulator has no
 * field for. Pure: same inputs, same output.
 */
export function toSimSnapshot(
  msg: BridgeSnapshot,
  topology: Topology,
  prevHistory: readonly HistoryPoint[],
  prevSessionId: string | null,
): MapResult {
  const nodes: Record<string, NodeStats> = {};
  const views: Record<string, LiveNodeView> = {};
  const lbNode = topology.nodes.find((n) => n.id === msg.lb.id && n.kind === 'lb');

  let offered = 0;
  let goodput = 0;
  let failedRate = 0;
  let attempts = 0;
  let totalRequests = 0;
  let totalFailed = 0;
  const failures = emptyFailures();

  for (const n of topology.nodes) {
    if (n.kind === 'client') {
      const c = msg.clients[n.id];
      if (!c) continue;
      nodes[n.id] = clientStats(c);
      views[n.id] = clientView(c);
      offered += num(c.rates.scheduled);
      goodput += num(c.rates.ok);
      failedRate += num(c.rates.failed) - num(c.failedPsByReason['client-overload']);
      attempts += num(c.rates.attempts);
      totalRequests += num(c.totals.requests);
      for (const [reason, count] of Object.entries(c.totals.failedByReason)) {
        const mapped = CLIENT_REASON[reason];
        if (mapped) {
          failures[mapped] += num(count);
          totalFailed += num(count);
        }
      }
    } else if (n.kind === 'service') {
      const b = msg.backends[n.id];
      if (!b) continue;
      nodes[n.id] = backendStats(b);
      views[n.id] = backendView(b);
    }
  }

  let served = 0;
  for (const b of Object.values(msg.backends)) served += num(b.rates?.arrivals);
  // Removed backends still draining are still being routed to by the LB.
  let retiringPs = 0;
  for (const r of msg.retiring) retiringPs += num(r.arrivalsPs);
  served += retiringPs;

  if (lbNode) {
    const lb = msg.lb;
    let drops = 0;
    for (const v of Object.values(lb.dropsPps)) drops += num(v);
    nodes[lbNode.id] = emptyStats({
      // The datapath's real CPU share: the honest answer to "is the load
      // balancer the bottleneck", and in practice a few percent.
      utilization: Math.min(1, num(lb.cpuDatapath)),
      throughput: served,
      arrivalRate: attempts,
      errorRate: ratio(drops, num(lb.rxPps)),
      totalCompleted: 0,
    });
    const facts: [string, string][] = [
      ['State', lb.state],
      ['Datapath CPU', `${fmt(num(lb.cpuDatapath) * 100, 1)}% of one core`],
      ['Packets per second', `${fmt(lb.rxPps)} in / ${fmt(lb.txPps)} out`],
      ['Measured ceiling', `${fmt(lb.config.measuredCeilingPps / 1000)}k pkt/s`],
      ['Flows in conntrack', fmt(lb.conntrack.activeFlows)],
      ['Conntrack idle timeout', `${fmt(lb.config.ctTcpTimeoutMs / 1000)} s`],
      ['Eligible backends', fmt(lb.backendsEligible)],
      ['Maglev table generation', fmt(lb.tableGeneration)],
      ['Last table rebuild', `${fmt(lb.regenLastUs)} µs`],
      ...(msg.retiring.length > 0
        ? ([
            [
              'Removed, still draining',
              `${msg.retiring.length} (${fmt(retiringPs, 1)} req/s)`,
            ],
          ] as [string, string][])
        : []),
      ['Health check every', `${lb.config.hcIntervalMs} ms`],
      ['Down / up after', `${lb.config.hcFall} / ${lb.config.hcRise} checks`],
    ];
    // Per second, for every reason that has ever dropped anything: a lifetime
    // total keeps start-up drops on screen forever, as if they were current.
    for (const [reason, total] of Object.entries(lb.dropsTotal)) {
      if (total > 0) {
        facts.push([
          `Drops/s, ${reason.replace(/_/g, ' ')}`,
          fmt(num(lb.dropsPps[reason]), 1),
        ]);
      }
    }
    views[lbNode.id] = {
      phase: lb.state,
      fault: null,
      draining: false,
      badge: lb.state === 'running' ? null : lb.state,
      facts,
    };
  }

  const edgeFlow: Record<string, number> = {};
  const edgeState: Record<string, EdgeState> = {};
  const activeFailures: ActiveFailure[] = [];
  for (const e of topology.edges) {
    const from = topology.nodes.find((n) => n.id === e.from);
    const to = topology.nodes.find((n) => n.id === e.to);
    if (from?.kind === 'client' && to?.id === lbNode?.id && lbNode) {
      const flow = num(msg.clients[from.id]?.rates.attempts);
      edgeFlow[e.id] = flow;
      edgeState[e.id] = flow > 0.05 ? 'live' : 'idle';
    } else if (from?.id === lbNode?.id && lbNode && to?.kind === 'service') {
      const [flow, state] = backendEdge(msg.backends[to.id]);
      edgeFlow[e.id] = flow;
      edgeState[e.id] = state;
    } else {
      edgeFlow[e.id] = 0;
      edgeState[e.id] = 'blocked';
    }
  }

  for (const n of topology.nodes) {
    const f = n.kind === 'service' ? msg.backends[n.id]?.fault : null;
    if (!f) continue;
    const cut = topology.edges
      .filter((e) => e.to === n.id && e.from === lbNode?.id)
      .map((e) => e.id);
    activeFailures.push({
      nodeId: n.id,
      kind: f.kind,
      sinceMs: f.sinceMs,
      ...(f.factor !== undefined ? { factor: f.factor } : {}),
      ...(f.rate !== undefined ? { rate: f.rate } : {}),
      ...(f.kind === 'partition' ? { edgeIds: cut } : {}),
    });
  }

  const returnEdges: ReturnEdge[] = [];
  const onCanvas = new Set(topology.nodes.map((n) => n.id));
  for (const [bid, b] of Object.entries(msg.backends)) {
    if (!onCanvas.has(bid) || (b.proc && !b.proc.alive)) continue;
    for (const [cid, flow] of Object.entries(b.respPsToClient ?? {})) {
      if (onCanvas.has(cid) && flow > 0.05) {
        returnEdges.push({ id: `dsr:${bid}->${cid}`, from: bid, to: cid, flow });
      }
    }
  }

  const sys = msg.system.latencyMs;
  const resolved = goodput + failedRate;
  const system = {
    timeMs: msg.tMs,
    offeredRps: offered,
    goodputRps: goodput,
    errorRate: ratio(failedRate, resolved),
    p50: num(sys.p50),
    p95: num(sys.p95),
    p99: num(sys.p99),
    totalRequests,
    totalFailed,
  };

  // A new session (reset, or a restarted bridge) or a clock that went
  // backwards starts the history over rather than splicing two runs together.
  // The same frame can be mapped twice (an edit re-maps the last frame against
  // the new canvas); that replaces its point rather than adding a second one.
  const last = prevHistory[prevHistory.length - 1];
  const fresh =
    prevSessionId !== msg.sessionId || (last !== undefined && msg.tMs < last.t);
  const kept = fresh
    ? []
    : last !== undefined && last.t === msg.tMs
      ? prevHistory.slice(-HISTORY_LEN, -1)
      : prevHistory.slice(-(HISTORY_LEN - 1));
  const history = kept.concat({
    t: msg.tMs,
    p50: system.p50,
    p95: system.p95,
    p99: system.p99,
    goodput,
    offered,
    errorRate: system.errorRate,
  });

  let trace: RequestTrace | null = null;
  for (const n of topology.nodes) {
    const t = n.kind === 'client' ? msg.clients[n.id]?.lastTrace : null;
    if (!t) continue;
    const reason = t.reason === null ? null : (CLIENT_REASON[t.reason] ?? null);
    const hops = [
      { nodeId: n.id, depth: 0, queuedMs: 0, serviceMs: 0 },
      ...(lbNode ? [{ nodeId: lbNode.id, depth: 1, queuedMs: 0, serviceMs: 0 }] : []),
      ...(t.backend && onCanvas.has(t.backend)
        ? [
            {
              nodeId: t.backend,
              depth: 2,
              queuedMs: t.queuedMs,
              serviceMs: t.serviceMs,
            },
          ]
        : []),
    ];
    trace = {
      startMs: msg.tMs - t.totalMs,
      totalMs: t.totalMs,
      ok: t.ok,
      reason,
      hops,
    };
    break;
  }

  return {
    snapshot: {
      system,
      nodes,
      history,
      edgeFlow,
      edgeState,
      failuresByReason: failures,
      activeFailures,
      trace,
    },
    view: {
      phase: msg.status.phase,
      loadEnabled: msg.status.loadEnabled,
      autoPaused: msg.status.autoPaused,
      errors: msg.status.errors,
      nodes: views,
      lb: lbNode
        ? {
            cpu: num(msg.lb.cpuDatapath),
            pps: num(msg.lb.rxPps),
            ceilingPps: msg.lb.config.measuredCeilingPps,
            activeFlows: num(msg.lb.conntrack.activeFlows),
            newFlowsPs: num(msg.lb.conntrack.missesPs),
          }
        : null,
      returnEdges,
      events: msg.events,
    },
  };
}
