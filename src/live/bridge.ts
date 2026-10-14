/**
 * Wire format of the l4-maglev-lb live bridge (`bridge/live_bridge.py` in that
 * repository). The bridge streams one of these four times a second; every
 * number in it is measured on the real system, never simulated.
 *
 * Kept deliberately separate from `SimSnapshot`: the bridge knows nothing about
 * breakscale, and `mapping.ts` is the one place that decides which real
 * measurement fills which simulator field.
 */

export const BRIDGE_SCHEMA = 'l4mlb-live/1';

export interface Latency {
  p50: number;
  p95: number;
  p99: number;
  /** Samples in the window. 0 means the percentiles are not measurements. */
  n: number;
}

export type BridgeFaultKind = 'crash' | 'slow' | 'errors' | 'partition';

export interface BridgeFault {
  kind: BridgeFaultKind;
  /** Session-relative ms. */
  sinceMs: number;
  factor?: number;
  rate?: number;
}

export type BackendPhase =
  | 'starting'
  | 'serving'
  | 'unhealthy'
  | 'crashed'
  | 'draining'
  | 'stopping'
  | 'pending'
  | 'detached';

export interface BridgeBackend {
  slot: number | null;
  lbId: number | null;
  addr: string | null;
  phase: BackendPhase;
  config: {
    capacity: number;
    serviceMs: number;
    serviceCv: number;
    queueLimit: number;
    errorRate: number;
  };
  fault: BridgeFault | null;
  /** maglev-lb's own view of this backend. Absent until a slot is assigned. */
  lb?: {
    up: boolean;
    adminEnabled: boolean;
    draining: boolean;
    activeFlows: number;
    flowsAssignedPs: number;
    pps: number;
    /** Failed health-check probes per second (a rate, not a lifetime total). */
    hcFailuresPs: number;
  };
  proc?: { alive: boolean; pid: number | null };
  rates?: {
    arrivals: number;
    ok: number;
    errors: number;
    shed: number;
    probes: number;
    accepts: number;
  };
  totals?: { arrivals: number; ok: number; errors: number; shed: number };
  inFlight?: number;
  queued?: number;
  utilization?: number;
  openConns?: number;
  /** Time at the backend: queueing plus service. */
  latencyMs?: Latency;
  serviceMs?: Latency;
  /** Direct Server Return replies per second, keyed by client node id. */
  respPsToClient?: Record<string, number>;
}

export interface BridgeTrace {
  totalMs: number;
  ok: boolean;
  reason: string | null;
  slot: number | null;
  backend: string | null;
  queuedMs: number;
  serviceMs: number;
}

export interface BridgeClient {
  ip: string | null;
  state: 'running' | 'paused' | 'disconnected' | 'exited';
  config: {
    rps: number;
    timeoutMs: number;
    retries: number;
    poolSize: number;
    maxConnAgeMs: number;
  };
  rates: {
    scheduled: number;
    attempts: number;
    ok: number;
    failed: number;
    retries: number;
  };
  failedPsByReason: Record<string, number>;
  totals: {
    requests: number;
    ok: number;
    failed: number;
    failedByReason: Record<string, number>;
  };
  latencyMs: Latency;
  inFlight: number;
  lagMs: number;
  /** The generator fell behind its own schedule: its numbers are unreliable. */
  behind: boolean;
  openConns: number;
  respPsByBackend: Record<string, number>;
  lastTrace: BridgeTrace | null;
}

export interface BridgeLb {
  id: string | null;
  state: 'running' | 'stopped';
  pid: number | null;
  /** Fraction of one core used by the datapath thread. */
  cpuDatapath: number;
  cpuProcess: number;
  rxPps: number;
  txPps: number;
  rxBps: number;
  txBps: number;
  dropsPps: Record<string, number>;
  dropsTotal: Record<string, number>;
  conntrack: {
    activeFlows: number;
    hitsPs: number;
    missesPs: number;
    evictionsPs: number;
  };
  tableGeneration: number;
  regenLastUs: number;
  backendsEligible: number;
  config: {
    slots: number;
    hcIntervalMs: number;
    hcTimeoutMs: number;
    hcRise: number;
    hcFall: number;
    ctTcpTimeoutMs: number;
    ctUdpTimeoutMs: number;
    tableSize: number;
    measuredCeilingPps: number;
  };
}

export interface BridgeEvent {
  tMs: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface BridgeSnapshot {
  schema: typeof BRIDGE_SCHEMA;
  sessionId: string;
  seq: number;
  /** Session-relative ms; goes back to ~0 on a session reset. */
  tMs: number;
  status: {
    phase: 'starting' | 'converging' | 'ready' | 'degraded' | 'stopping';
    loadEnabled: boolean;
    autoPaused: boolean;
    errors: string[];
  };
  lb: BridgeLb;
  clients: Record<string, BridgeClient>;
  backends: Record<string, BridgeBackend>;
  /** Backends removed from the canvas that are still finishing pinned connections. */
  retiring: {
    slot: number;
    formerId: string;
    phase: string;
    arrivalsPs?: number;
    okPs?: number;
  }[];
  system: { latencyMs: Latency };
  events: BridgeEvent[];
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Structural check at the trust boundary. Deliberately shallow: the bridge is
 * ours and local, so this guards against a version mismatch or a truncated
 * frame, not against a hostile peer.
 */
export function isBridgeSnapshot(x: unknown): x is BridgeSnapshot {
  return (
    isObj(x) &&
    x.schema === BRIDGE_SCHEMA &&
    typeof x.sessionId === 'string' &&
    typeof x.tMs === 'number' &&
    isObj(x.status) &&
    isObj(x.lb) &&
    isObj(x.clients) &&
    isObj(x.backends) &&
    isObj(x.system) &&
    Array.isArray(x.events)
  );
}

/** The desired-state document the bridge accepts on PUT /api/v1/desired. */
export interface DesiredDoc {
  schema: typeof BRIDGE_SCHEMA;
  nodes: {
    lb: string;
    clients: {
      id: string;
      rps: number;
      timeoutMs: number;
      retries: number;
      poolSize: number;
      maxConnAgeMs: number;
    }[];
    backends: {
      id: string;
      capacity: number;
      serviceMs: number;
      serviceCv: number;
      queueLimit: number;
      errorRate: number;
    }[];
  };
  edges: { from: string; to: string }[];
  load: { enabled: boolean };
}

export type LiveAction =
  | {
      action: 'crash' | 'restart' | 'partition' | 'clear' | 'drain' | 'undrain';
      target: string;
    }
  | { action: 'slow'; target: string; factor: number }
  | { action: 'errors'; target: string; rate: number };
