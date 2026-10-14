import { describe, expect, it, vi } from 'vitest';
import type { Topology } from '../sim/types';
import { LiveEngine } from './LiveEngine';
import { HISTORY_LEN, toSimSnapshot } from './mapping';
import { LIVE_PRESET } from './preset';
import { connectionProblem, desiredFromTopology, liveProblems } from './validate';
import { backend, client, frame } from './fixture.test-data';

const T: Topology = LIVE_PRESET;

const REQUIRED_STATS = [
  'inFlight',
  'queued',
  'throughput',
  'arrivalRate',
  'utilization',
  'p50',
  'p95',
  'p99',
  'errorRate',
  'shedRate',
  'timeoutRate',
  'hitRate',
  'totalCompleted',
  'totalFailed',
  'queueLimit',
  'staleReadRate',
  'maxShardUtilization',
  'minShardUtilization',
] as const;

describe('toSimSnapshot', () => {
  it('fills every required NodeStats field with a finite number', () => {
    const { snapshot } = toSimSnapshot(frame(), T, [], null);
    for (const n of T.nodes) {
      const s = snapshot.nodes[n.id];
      expect(s, n.id).toBeDefined();
      for (const k of REQUIRED_STATS)
        expect(Number.isFinite(s![k]), `${n.id}.${k}`).toBe(true);
      expect(Array.isArray(s!.shardUtilization)).toBe(true);
    }
  });

  it('gives every edge a state and a flow, and all 15 failure reasons', () => {
    const { snapshot } = toSimSnapshot(frame(), T, [], null);
    for (const e of T.edges) {
      expect(snapshot.edgeState[e.id]).toBeDefined();
      expect(Number.isFinite(snapshot.edgeFlow[e.id])).toBe(true);
    }
    expect(Object.keys(snapshot.failuresByReason)).toHaveLength(15);
    expect(snapshot.failuresByReason.timeout).toBe(200);
    expect(snapshot.failuresByReason.partitioned).toBe(0);
  });

  it('draws a dead backend process idle, even if a frame still carries its last numbers', () => {
    const f = frame();
    f.backends['service-1'] = backend({
      phase: 'crashed',
      proc: { alive: false, pid: null },
    });
    const { snapshot, view } = toSimSnapshot(f, T, [], null);
    const s = snapshot.nodes['service-1']!;
    expect([s.utilization, s.throughput, s.inFlight, s.p99]).toEqual([0, 0, 0, 0]);
    expect(view.returnEdges.some((e) => e.from === 'service-1')).toBe(false);
  });

  it('counts a removed backend that is still draining in what the LB serves', () => {
    const f = frame();
    const before = toSimSnapshot(f, T, [], null).snapshot.nodes['lb-1']!.throughput;
    f.retiring = [
      { slot: 4, formerId: 'service-9', phase: 'draining', arrivalsPs: 24, okPs: 24 },
    ];
    const { snapshot, view } = toSimSnapshot(f, T, [], null);
    expect(snapshot.nodes['lb-1']!.throughput).toBe(before + 24);
    expect(view.nodes['lb-1']!.facts).toContainEqual([
      'Removed, still draining',
      '1 (24.0 req/s)',
    ]);
  });

  it('uses the real datapath CPU as the load balancer utilisation', () => {
    const { snapshot, view } = toSimSnapshot(frame(), T, [], null);
    expect(snapshot.nodes['lb-1']!.utilization).toBeCloseTo(0.013);
    expect(snapshot.nodes['lb-1']!.throughput).toBe(99);
    expect(view.lb?.cpu).toBeCloseTo(0.013);
  });

  it('after a crash, the wire shows what the LB is still sending there', () => {
    const f = frame();
    f.backends['service-1'] = backend({
      phase: 'crashed',
      proc: { alive: false, pid: null },
      fault: { kind: 'crash', sinceMs: 4000 },
      lb: { ...backend().lb!, up: true, flowsAssignedPs: 30 },
    });
    const { snapshot } = toSimSnapshot(f, T, [], null);
    expect(snapshot.edgeFlow['lb-1->service-1']).toBe(30);
    expect(snapshot.edgeState['lb-1->service-1']).toBe('live');
    expect(snapshot.activeFailures).toEqual([
      { nodeId: 'service-1', kind: 'crash', sinceMs: 4000 },
    ]);
  });

  it('a partition cuts the wire but the backend stays up in the LB', () => {
    const f = frame();
    f.backends['service-2'] = backend({ fault: { kind: 'partition', sinceMs: 1 } });
    const { snapshot, view } = toSimSnapshot(f, T, [], null);
    expect(snapshot.edgeState['lb-1->service-2']).toBe('cut');
    expect(snapshot.activeFailures[0]!.edgeIds).toEqual(['lb-1->service-2']);
    expect(view.nodes['service-2']!.badge).toBe('cut off');
  });

  it('draining with no new flows is standby, not idle', () => {
    const f = frame();
    f.backends['service-3'] = backend({
      phase: 'draining',
      rates: { ...backend().rates!, arrivals: 0 },
    });
    expect(toSimSnapshot(f, T, [], null).snapshot.edgeState['lb-1->service-3']).toBe(
      'standby',
    );
  });

  it('derives DSR return edges only for flowing replies', () => {
    const { view } = toSimSnapshot(frame(), T, [], null);
    expect(view.returnEdges.map((e) => e.id).sort()).toEqual([
      'dsr:service-1->client-1',
      'dsr:service-2->client-1',
      'dsr:service-3->client-1',
    ]);
  });

  it('keeps generator overload out of lost requests but warns', () => {
    const f = frame({
      clients: {
        'client-1': client({
          totals: {
            requests: 10,
            ok: 5,
            failed: 5,
            failedByReason: { 'client-overload': 5 },
          },
        }),
      },
    });
    const { snapshot, view } = toSimSnapshot(f, T, [], null);
    expect(snapshot.system.totalFailed).toBe(0);
    expect(view.nodes['client-1']!.badge).toBe('saturated');
  });

  it('history appends, dedupes a re-mapped frame, caps, and resets on a new session', () => {
    let h = toSimSnapshot(frame({ tMs: 0 }), T, [], null).snapshot.history;
    for (let i = 1; i < 300; i++)
      h = toSimSnapshot(frame({ tMs: i * 250 }), T, h, 'abc').snapshot.history;
    expect(h).toHaveLength(HISTORY_LEN);
    const again = toSimSnapshot(frame({ tMs: 299 * 250 }), T, h, 'abc').snapshot
      .history;
    expect(again).toHaveLength(HISTORY_LEN);
    expect(again[again.length - 1]!.t).toBe(299 * 250);
    expect(
      toSimSnapshot(frame({ tMs: 100, sessionId: 'new' }), T, h, 'abc').snapshot
        .history,
    ).toHaveLength(1);
  });

  it('traces a request hop by hop with real queue and service time', () => {
    const { snapshot } = toSimSnapshot(frame(), T, [], null);
    expect(snapshot.trace?.hops.map((h) => h.nodeId)).toEqual([
      'client-1',
      'lb-1',
      'service-1',
    ]);
    expect(snapshot.trace?.hops[2]).toMatchObject({ queuedMs: 4, serviceMs: 26 });
  });
});

describe('validate', () => {
  it('allows only client->lb and lb->backend', () => {
    expect(connectionProblem(T, 'client-1', 'lb-1')).toBeNull();
    expect(connectionProblem(T, 'lb-1', 'service-1')).toBeNull();
    expect(connectionProblem(T, 'client-1', 'service-1')).toMatch(/load balancer/);
    expect(connectionProblem(T, 'service-1', 'client-1')).toMatch(
      /Direct Server Return/,
    );
  });

  it('builds a document the bridge accepts, clamped to its limits', () => {
    const t: Topology = {
      ...T,
      nodes: T.nodes.map((n) =>
        n.id === 'client-1'
          ? { ...n, config: { ...n.config, rps: 9000, timeoutMs: 0, maxConnAgeMs: 10 } }
          : n,
      ),
    };
    const d = desiredFromTopology(t, true);
    expect(d.nodes.lb).toBe('lb-1');
    expect(d.nodes.clients[0]).toMatchObject({
      rps: 2000,
      timeoutMs: 10000,
      maxConnAgeMs: 1000,
    });
    expect(d.edges).toHaveLength(4);
    expect(d.nodes.backends).toHaveLength(3);
  });

  it('drops wires the live system does not have, and reports them', () => {
    const t: Topology = {
      ...T,
      edges: [...T.edges, { id: 'x', from: 'client-1', to: 'service-1', weight: 1 }],
    };
    expect(desiredFromTopology(t, true).edges).toHaveLength(4);
    expect(liveProblems(t).some((p) => p.edgeId === 'x')).toBe(true);
  });

  it('without a load balancer, nothing is connected', () => {
    const t: Topology = { nodes: T.nodes.filter((n) => n.kind !== 'lb'), edges: [] };
    const d = desiredFromTopology(t, true);
    expect(d.edges).toEqual([]);
    expect(liveProblems(t)[0]!.message).toMatch(/load balancer/);
  });
});

describe('LiveEngine', () => {
  function fakeFetch() {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response('{}', { status: 200 });
    });
    return { fn: fn as unknown as typeof fetch, calls };
  }

  it('does no I/O until connected, and batches a burst of edits into one PUT', async () => {
    vi.useFakeTimers();
    const { fn, calls } = fakeFetch();
    const e = new LiveEngine(T, fn);
    e.updateNodeConfig('client-1', { rps: 200 });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toHaveLength(0);
    (e as unknown as { stopped: boolean }).stopped = false; // connected, without a stream
    for (let i = 0; i < 10; i++) e.updateNodeConfig('client-1', { rps: 200 + i });
    await vi.advanceTimersByTimeAsync(500);
    const puts = calls.filter((c) => c.init?.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]!.init!.body)).nodes.clients[0].rps).toBe(209);
    vi.useRealTimers();
  });

  it('keeps exactly one stream open across a StrictMode connect, dispose, connect', async () => {
    vi.useFakeTimers();
    // A stream that stays open until its request is aborted.
    const open = new Set<AbortSignal>();
    const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).endsWith('/stream')) return new Response('{}', { status: 200 });
      const signal = init!.signal!;
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      open.add(signal);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => {
            open.delete(signal);
            controller.error(new DOMException('aborted', 'AbortError'));
          });
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const e = new LiveEngine(T, fn);
    const dispose1 = e.connect();
    dispose1();
    const dispose2 = e.connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(open.size).toBe(1);
    dispose2();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(open.size).toBe(0);
    vi.useRealTimers();
  });

  it('maps a streamed frame and ignores malformed ones', () => {
    const e = new LiveEngine(T, fakeFetch().fn);
    e.onFrame('not json');
    e.onFrame(JSON.stringify({ schema: 'other' }));
    expect(e.snapshot().system.timeMs).toBe(0);
    e.onFrame(JSON.stringify(frame()));
    expect(e.snapshot().system.goodputRps).toBe(97);
    expect(e.liveView().phase).toBe('ready');
  });

  it('turns failure injection into bridge actions', async () => {
    const { fn, calls } = fakeFetch();
    const e = new LiveEngine(T, fn);
    e.injectFailure('service-1', 'slow', { factor: 3 });
    e.drain('service-2');
    await Promise.resolve();
    const bodies = calls.map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies).toEqual([
      { action: 'slow', target: 'service-1', factor: 3 },
      { action: 'drain', target: 'service-2' },
    ]);
    expect(calls.every((c) => c.url.endsWith('/api/v1/actions'))).toBe(true);
  });
});
