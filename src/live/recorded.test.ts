/**
 * The mapping against frames RECORDED from the real l4-maglev-lb bridge
 * (`live_bridge.py --record`), driven through a scripted scenario on the
 * LIVE_PRESET topology: start-up, steady load, a crash, a partition, a drain,
 * 1000 requests per second, and pooled connections. Hand-written fixtures
 * prove the mapping does what was intended; these prove the intention matches
 * what the real system actually sends.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isBridgeSnapshot, type BridgeSnapshot } from './bridge';
import { toSimSnapshot } from './mapping';
import { LIVE_PRESET } from './preset';

const FRAMES = JSON.parse(
  readFileSync(new URL('./fixtures/recorded-frames.json', import.meta.url), 'utf8'),
) as Record<string, BridgeSnapshot>;

const map = (name: string) => {
  const f = FRAMES[name];
  if (!f) throw new Error(`no recorded frame ${name}`);
  return { frame: f, ...toSimSnapshot(f, LIVE_PRESET, [], null) };
};

describe('recorded bridge frames', () => {
  it('are all valid bridge snapshots and map to complete, finite SimSnapshots', () => {
    expect(Object.keys(FRAMES).length).toBeGreaterThanOrEqual(8);
    for (const [name, f] of Object.entries(FRAMES)) {
      expect(isBridgeSnapshot(f), name).toBe(true);
      const { snapshot } = toSimSnapshot(f, LIVE_PRESET, [], null);
      for (const n of LIVE_PRESET.nodes) {
        const s = snapshot.nodes[n.id];
        expect(s, `${name}: ${n.id}`).toBeDefined();
        for (const [k, v] of Object.entries(s!)) {
          if (typeof v === 'number')
            expect(Number.isFinite(v), `${name}: ${n.id}.${k}`).toBe(true);
        }
      }
      for (const e of LIVE_PRESET.edges) {
        expect(snapshot.edgeState[e.id], `${name}: ${e.id}`).toBeDefined();
      }
      expect(Object.keys(snapshot.failuresByReason)).toHaveLength(15);
      expect(Number.isFinite(snapshot.system.p99)).toBe(true);
    }
  });

  it('while backends start, the wires to them carry nothing', () => {
    const { snapshot } = map('starting');
    expect(snapshot.edgeState['lb-1->service-1']).toBe('blocked');
  });

  it('steady load: what clients send arrives at the backends, and replies come back directly', () => {
    const { snapshot, view } = map('baseline');
    const toBackends = ['service-1', 'service-2', 'service-3'].reduce(
      (s, id) => s + (snapshot.edgeFlow[`lb-1->${id}`] ?? 0),
      0,
    );
    const sent = snapshot.edgeFlow['client-1->lb-1']!;
    expect(sent).toBeGreaterThan(100);
    expect(Math.abs(toBackends - sent) / sent).toBeLessThan(0.25);
    expect(view.returnEdges).toHaveLength(3);
    expect(snapshot.trace?.hops.map((h) => h.nodeId).slice(0, 2)).toEqual([
      'client-1',
      'lb-1',
    ]);
  });

  it('crash: the LB keeps routing to the dead backend until health checks catch up', () => {
    const before = map('crashed-lb-still-up');
    expect(before.frame.backends['service-1']!.lb!.up).toBe(true);
    expect(before.snapshot.activeFailures.some((f) => f.kind === 'crash')).toBe(true);
    // The dead process itself reports nothing: no work, no replies.
    expect(before.snapshot.nodes['service-1']!.utilization).toBe(0);
    expect(before.snapshot.nodes['service-1']!.throughput).toBe(0);
    expect(before.view.returnEdges.some((e) => e.from === 'service-1')).toBe(false);
    // ...while the LB's probes against it are failing right now.
    expect(before.frame.backends['service-1']!.lb!.hcFailuresPs).toBeGreaterThan(0);
    const after = map('crashed-lb-down');
    expect(after.snapshot.edgeState['lb-1->service-1']).toBe('blocked');
  });

  it('partition: the wire is cut while the LB still reports the backend healthy', () => {
    const { frame, snapshot } = map('partitioned');
    expect(frame.backends['service-2']!.lb!.up).toBe(true);
    expect(snapshot.edgeState['lb-1->service-2']).toBe('cut');
    expect(snapshot.failuresByReason.timeout).toBeGreaterThan(0);
    expect(snapshot.failuresByReason.partitioned).toBe(0);
  });

  it('drain: the backend is held out of rotation without failing anything', () => {
    const { frame, snapshot, view } = map('draining');
    expect(frame.backends['service-3']!.lb!.draining).toBe(true);
    expect(['standby', 'live']).toContain(snapshot.edgeState['lb-1->service-3']);
    expect(view.nodes['service-3']!.draining).toBe(true);
  });

  it('1000 requests per second through the real LB', () => {
    const { snapshot } = map('high-load');
    expect(snapshot.system.goodputRps).toBeGreaterThan(800);
  });

  it('pooled connections: no new flows at the LB, and an uneven split it cannot fix', () => {
    const { frame, view } = map('pooled');
    const newFlows = Object.values(frame.backends).reduce(
      (s, b) => s + (b.lb?.flowsAssignedPs ?? 0),
      0,
    );
    expect(newFlows).toBeLessThan(1);
    // Four connections over three backends cannot split evenly (at best
    // 2/1/1), so one backend carries at least half as much again as another.
    // Counted over ALL backends: one holding no connection gets no reply wire.
    const replies = ['service-1', 'service-2', 'service-3'].map((id) =>
      view.returnEdges.filter((e) => e.from === id).reduce((s, e) => s + e.flow, 0),
    );
    expect(Math.max(...replies)).toBeGreaterThan(1.5 * Math.min(...replies));
  });
});
