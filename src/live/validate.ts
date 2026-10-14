import type { SimNode, Topology } from '../sim/types';
import { BRIDGE_SCHEMA, type DesiredDoc } from './bridge';
import { LIVE_KINDS } from './mode';

/** Limits the bridge enforces (bridge/schema.py). Clamping here first means a
 * slider at its end sends a value the bridge accepts, rather than a 422. */
export const LIVE_LIMITS = {
  maxClients: 4,
  maxBackends: 16,
  maxTotalRps: 4000,
  rps: [0, 2000],
  timeoutMs: [50, 10000],
  retries: [0, 5],
  poolSize: [0, 64],
  maxConnAgeMs: [1000, 60000],
  capacity: [1, 256],
  serviceMs: [1, 2000],
  serviceCv: [0, 3],
  queueLimit: [0, 4096],
  errorRate: [0, 1],
} as const;

export interface LiveProblem {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

function clampTo(
  v: number | undefined,
  [lo, hi]: readonly [number, number],
  fallback: number,
) {
  const x = Number.isFinite(v) ? (v as number) : fallback;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Why a wire may not be drawn in live mode, or null if it may.
 *
 * The real topology has exactly two kinds of link: a client sends to the
 * load balancer's virtual IP, and the load balancer forwards to a backend.
 * Nothing else exists on the wire, so nothing else can be drawn.
 */
export function connectionProblem(
  t: Topology,
  fromId: string,
  toId: string,
): string | null {
  const from = t.nodes.find((n) => n.id === fromId);
  const to = t.nodes.find((n) => n.id === toId);
  if (!from || !to) return 'unknown node';
  if (from.kind === 'client' && to.kind === 'lb') return null;
  if (from.kind === 'lb' && to.kind === 'service') return null;
  if (from.kind === 'client' && to.kind === 'service') {
    return 'A client only knows the load balancer’s address. Connect it to the load balancer instead.';
  }
  if (from.kind === 'service') {
    return 'Backends reply straight to the client on their own (Direct Server Return), so they have no outgoing wire to draw.';
  }
  return 'Live mode only has two kinds of link: client to load balancer, and load balancer to backend.';
}

/** Everything about this topology the live system cannot run, for the UI. */
export function liveProblems(t: Topology): LiveProblem[] {
  const problems: LiveProblem[] = [];
  const lbs = t.nodes.filter((n) => n.kind === 'lb');
  if (lbs.length === 0) {
    problems.push({
      message: 'Add a load balancer: without one, no client can reach a backend.',
    });
  } else if (lbs.length > 1) {
    for (const extra of lbs.slice(1)) {
      problems.push({
        nodeId: extra.id,
        message:
          'Only one load balancer is real (one virtual IP). This one is ignored.',
      });
    }
  }
  for (const n of t.nodes) {
    if (!LIVE_KINDS.includes(n.kind)) {
      problems.push({
        nodeId: n.id,
        message: `A ${n.kind} does not exist in the live system and is ignored.`,
      });
    }
  }
  const clients = t.nodes.filter((n) => n.kind === 'client');
  const backends = t.nodes.filter((n) => n.kind === 'service');
  for (const c of clients.slice(LIVE_LIMITS.maxClients)) {
    problems.push({
      nodeId: c.id,
      message: `At most ${LIVE_LIMITS.maxClients} clients; this one is ignored.`,
    });
  }
  for (const b of backends.slice(LIVE_LIMITS.maxBackends)) {
    problems.push({
      nodeId: b.id,
      message: `At most ${LIVE_LIMITS.maxBackends} backends; this one is ignored.`,
    });
  }
  for (const e of t.edges) {
    const why = connectionProblem(t, e.from, e.to);
    if (why) problems.push({ edgeId: e.id, message: why });
  }
  const total = clients
    .slice(0, LIVE_LIMITS.maxClients)
    .reduce((s, c) => s + clampTo(c.config.rps, LIVE_LIMITS.rps, 0), 0);
  if (total > LIVE_LIMITS.maxTotalRps) {
    problems.push({
      message: `Total offered load is capped at ${LIVE_LIMITS.maxTotalRps} requests per second; every client is scaled down to fit.`,
    });
  }
  return problems;
}

function clientDoc(n: SimNode, scale: number): DesiredDoc['nodes']['clients'][number] {
  const c = n.config;
  const age = Math.round(c.maxConnAgeMs ?? 0);
  return {
    id: n.id,
    rps: clampTo(c.rps, LIVE_LIMITS.rps, 0) * scale,
    // The simulator reads 0 as "never time out". A real client that never
    // gives up grows without bound behind a black-holed backend, so live mode
    // treats 0 as the longest timeout it allows.
    timeoutMs:
      c.timeoutMs > 0
        ? clampTo(c.timeoutMs, LIVE_LIMITS.timeoutMs, 1000)
        : LIVE_LIMITS.timeoutMs[1],
    retries: Math.round(clampTo(c.retries, LIVE_LIMITS.retries, 0)),
    poolSize: Math.round(clampTo(c.poolSize, LIVE_LIMITS.poolSize, 0)),
    maxConnAgeMs: age <= 0 ? 0 : Math.round(clampTo(age, LIVE_LIMITS.maxConnAgeMs, 0)),
  };
}

function backendDoc(n: SimNode): DesiredDoc['nodes']['backends'][number] {
  const c = n.config;
  return {
    id: n.id,
    capacity: Math.round(clampTo(c.capacity, LIVE_LIMITS.capacity, 8)),
    serviceMs: clampTo(c.serviceMs, LIVE_LIMITS.serviceMs, 25),
    serviceCv: clampTo(c.serviceCv, LIVE_LIMITS.serviceCv, 0.6),
    queueLimit: Math.round(clampTo(c.queueLimit, LIVE_LIMITS.queueLimit, 64)),
    errorRate: clampTo(c.errorRate, LIVE_LIMITS.errorRate, 0),
  };
}

/**
 * The canvas as the bridge's desired state. Always produces a document the
 * bridge accepts: whatever the live system cannot run (extra load
 * balancers, other kinds, wires it does not have) is left out here and
 * reported by liveProblems() instead. With no load balancer every client is
 * disconnected and every backend detached, which is exactly what happens to
 * real traffic with no balancer in the path.
 */
export function desiredFromTopology(t: Topology, loadEnabled: boolean): DesiredDoc {
  const lb = t.nodes.find((n) => n.kind === 'lb');
  const lbId = lb?.id ?? 'no-lb';
  const clients = t.nodes
    .filter((n) => n.kind === 'client')
    .slice(0, LIVE_LIMITS.maxClients);
  const backends = t.nodes
    .filter((n) => n.kind === 'service')
    .slice(0, LIVE_LIMITS.maxBackends);
  const total = clients.reduce(
    (s, c) => s + clampTo(c.config.rps, LIVE_LIMITS.rps, 0),
    0,
  );
  const scale = total > LIVE_LIMITS.maxTotalRps ? LIVE_LIMITS.maxTotalRps / total : 1;
  const clientIds = new Set(clients.map((c) => c.id));
  const backendIds = new Set(backends.map((b) => b.id));
  const edges: DesiredDoc['edges'] = [];
  const seen = new Set<string>();
  if (lb) {
    for (const e of t.edges) {
      const ok =
        (clientIds.has(e.from) && e.to === lb.id) ||
        (e.from === lb.id && backendIds.has(e.to));
      const key = `${e.from}->${e.to}`;
      if (ok && !seen.has(key)) {
        seen.add(key);
        edges.push({ from: e.from, to: e.to });
      }
    }
  }
  return {
    schema: BRIDGE_SCHEMA,
    nodes: {
      lb: lbId,
      clients: clients.map((c) => clientDoc(c, scale)),
      backends: backends.map(backendDoc),
    },
    edges,
    load: { enabled: loadEnabled },
  };
}
