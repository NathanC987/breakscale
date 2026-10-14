import type { BridgeBackend, BridgeClient, BridgeSnapshot } from './bridge';

/** A bridge frame in the exact shape bridge/live_bridge.py emits, for tests. */

export function backend(over: Partial<BridgeBackend> = {}): BridgeBackend {
  return {
    slot: 1,
    lbId: 0,
    addr: '10.98.0.11:9000',
    phase: 'serving',
    config: {
      capacity: 8,
      serviceMs: 25,
      serviceCv: 0.6,
      queueLimit: 64,
      errorRate: 0,
    },
    fault: null,
    lb: {
      up: true,
      adminEnabled: true,
      draining: false,
      activeFlows: 400,
      flowsAssignedPs: 33,
      pps: 200,
      hcFailuresPs: 0,
    },
    proc: { alive: true, pid: 4242 },
    rates: { arrivals: 33, ok: 32, errors: 0, shed: 1, probes: 2, accepts: 33 },
    totals: { arrivals: 3300, ok: 3200, errors: 0, shed: 100 },
    inFlight: 3,
    queued: 1,
    utilization: 0.4,
    openConns: 3,
    latencyMs: { p50: 24, p95: 50, p99: 80, n: 160 },
    serviceMs: { p50: 22, p95: 45, p99: 70, n: 160 },
    respPsToClient: { 'client-1': 33 },
    ...over,
  };
}

export function client(over: Partial<BridgeClient> = {}): BridgeClient {
  return {
    ip: '10.98.0.200',
    state: 'running',
    config: { rps: 100, timeoutMs: 1000, retries: 0, poolSize: 0, maxConnAgeMs: 0 },
    rates: { scheduled: 100, attempts: 101, ok: 97, failed: 3, retries: 1 },
    failedPsByReason: { timeout: 2, shed: 1 },
    totals: {
      requests: 10000,
      ok: 9700,
      failed: 300,
      failedByReason: { timeout: 200, shed: 100 },
    },
    latencyMs: { p50: 26, p95: 60, p99: 140, n: 500 },
    inFlight: 5,
    lagMs: 0.4,
    behind: false,
    openConns: 5,
    respPsByBackend: { 'service-1': 33, 'service-2': 33, 'service-3': 33 },
    lastTrace: {
      totalMs: 31,
      ok: true,
      reason: null,
      slot: 1,
      backend: 'service-1',
      queuedMs: 4,
      serviceMs: 26,
    },
    ...over,
  };
}

export function frame(over: Partial<BridgeSnapshot> = {}): BridgeSnapshot {
  return {
    schema: 'l4mlb-live/1',
    sessionId: 'abc',
    seq: 10,
    tMs: 5000,
    status: { phase: 'ready', loadEnabled: true, autoPaused: false, errors: [] },
    lb: {
      id: 'lb-1',
      state: 'running',
      pid: 100,
      cpuDatapath: 0.013,
      cpuProcess: 0.02,
      rxPps: 600,
      txPps: 600,
      rxBps: 40000,
      txBps: 60000,
      dropsPps: {
        parse_error: 0,
        no_backend: 0,
        backend_unhealthy: 0,
        conntrack_full: 0,
      },
      dropsTotal: {
        parse_error: 0,
        no_backend: 0,
        backend_unhealthy: 3,
        conntrack_full: 0,
      },
      conntrack: { activeFlows: 1500, hitsPs: 500, missesPs: 100, evictionsPs: 99 },
      tableGeneration: 4,
      regenLastUs: 380,
      backendsEligible: 3,
      config: {
        slots: 16,
        hcIntervalMs: 500,
        hcTimeoutMs: 300,
        hcRise: 2,
        hcFall: 2,
        ctTcpTimeoutMs: 15000,
        ctUdpTimeoutMs: 15000,
        tableSize: 65537,
        measuredCeilingPps: 520000,
      },
    },
    clients: { 'client-1': client() },
    backends: {
      'service-1': backend(),
      'service-2': backend({ slot: 2, lbId: 1, addr: '10.98.0.12:9000' }),
      'service-3': backend({ slot: 3, lbId: 2, addr: '10.98.0.13:9000' }),
    },
    retiring: [],
    system: { latencyMs: { p50: 26, p95: 60, p99: 140, n: 500 } },
    events: [],
    ...over,
  };
}
