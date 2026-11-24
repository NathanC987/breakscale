import { describe, expect, it, vi } from 'vitest';
import { LiveEngine } from './LiveEngine';
import { LIVE_PRESET } from './preset';
import {
  decodeTable,
  describeChange,
  diffTables,
  gridRows,
  moduloMoved,
  ownerOf,
} from './tables';

const enc = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
const name = (id: number) => `b${id + 1}`;

describe('the Maglev table', () => {
  it('decodes one byte per slot: backend id + 1, 0 for empty', () => {
    const t = decodeTable(enc([1, 2, 0, 3]));
    expect([...t]).toEqual([1, 2, 0, 3]);
    expect([0, 1, 2, 3].map((s) => ownerOf(t, s))).toEqual([0, 1, null, 2]);
    expect(ownerOf(t, 99)).toBeNull();
    expect(gridRows(65537)).toBe(257);
  });

  it('a removal moves only the removed backend’s slots', () => {
    const before = Uint8Array.from([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    const after = Uint8Array.from([1, 2, 1, 1, 2, 2, 1, 2, 1]);
    const c = diffTables(before, after, 4, 5)!;
    expect(c.movedCount).toBe(3);
    expect(c.removed).toEqual([2]);
    expect(c.added).toEqual([]);
    expect(c.movedBetweenSurvivors).toBe(0);
    expect([...c.moved]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const text = describeChange(
      { ...c, m: 9, modulo: moduloMoved([0, 1, 2], [0, 1], 9) },
      name,
    );
    expect(text).toContain('b3 left. 3 of 9 slots (33.3%) changed owner');
    expect(text).toContain('No other slot moved.');
    expect(text).toContain('hash mod N instead would have moved 55.6%');
  });

  it('an addition names the newcomer and counts collateral moves', () => {
    const before = Uint8Array.from([1, 2, 1, 2]);
    const after = Uint8Array.from([3, 2, 2, 1]);
    const c = diffTables(before, after, 1, 2)!;
    expect(c.added).toEqual([2]);
    expect(c.movedBetweenSurvivors).toBe(2); // slot 2: b1 -> b2, slot 3: b2 -> b1
    expect(describeChange({ ...c, m: 4, modulo: 0 }, name)).toContain(
      'b3 joined. 3 of 4 slots (75.0%) changed owner',
    );
  });

  it('tables of different sizes are not compared', () => {
    expect(diffTables(new Uint8Array(3), new Uint8Array(4), 1, 2)).toBeNull();
  });
});

describe('fetchTables', () => {
  const doc = { generation: 2, m: 4, backends: [], conntrack: {}, run: 7 };

  it('names the held generation and tells pending, tables and errors apart', async () => {
    const answers = [
      new Response(JSON.stringify({ pending: true })),
      new Response(JSON.stringify(doc)),
      new Response(JSON.stringify({ error: 'maglev-lb is not running' }), {
        status: 503,
      }),
    ];
    const fn = vi.fn(async () => answers.shift()!);
    const e = new LiveEngine(LIVE_PRESET, fn as unknown as typeof fetch);
    expect(await e.fetchTables(null)).toEqual({ kind: 'pending' });
    expect(await e.fetchTables(2)).toEqual({ kind: 'tables', doc });
    expect(await e.fetchTables(2)).toEqual({
      kind: 'error',
      message: 'maglev-lb is not running',
    });
    const urls = fn.mock.calls.map((c) => String((c as unknown[])[0]));
    expect(urls).toEqual([
      '/api/v1/lb/tables',
      '/api/v1/lb/tables?gen=2',
      '/api/v1/lb/tables?gen=2',
    ]);
  });

  it('reports an unreachable bridge', async () => {
    const e = new LiveEngine(LIVE_PRESET, (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch);
    expect(await e.fetchTables(null)).toEqual({
      kind: 'error',
      message: 'The bridge is not reachable.',
    });
  });
});
