// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeTables, TablesResult } from './bridge';
import type { LiveEngine } from './LiveEngine';
import { LiveTables } from './LiveTables';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enc = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

function doc(
  generation: number,
  table: number[] | null,
  extra: Partial<BridgeTables> = {},
) {
  const ids = [...new Set((table ?? []).filter((v) => v > 0).map((v) => v - 1))];
  return {
    generation,
    ageMs: 10,
    m: 6,
    backends: ids.map((id) => ({
      lbId: id,
      node: `s${id + 1}`,
      addr: `10.99.1.${31 + id}`,
      slots: table!.filter((v) => v === id + 1).length,
    })),
    ...(table ? { table: enc(table) } : {}),
    conntrack: {
      active: 3,
      scanUs: 900,
      rowsPerBackend: 16,
      flows: [
        { lbId: 0, node: 's1', n: 2 },
        { lbId: 2, node: null, n: 1 },
      ],
      rows: [
        {
          client: 'c1',
          src: '10.99.1.10',
          sport: 40001,
          dport: 8080,
          proto: 'tcp',
          lbId: 2,
          node: null,
          slot: 2,
          idleMs: 1500,
        },
      ],
    },
    source: { where: 'aws', instance: 'i-0abc', type: 'c7i-flex.large' },
    ctTimeoutMs: 15000,
    run: 7,
    ...extra,
  } as BridgeTables;
}

describe('LiveTables', () => {
  it('shows the real tables and explains a rebuild', async () => {
    const answers: TablesResult[] = [
      { kind: 'pending' },
      { kind: 'tables', doc: doc(1, [1, 2, 3, 1, 2, 3]) },
      { kind: 'tables', doc: doc(2, [1, 2, 1, 1, 2, 2]) },
    ];
    const fetchTables = vi.fn(
      async () => answers.shift() ?? answers.at(-1) ?? { kind: 'pending' },
    );
    const engine = { fetchTables } as unknown as LiveEngine;
    const names: Record<string, string> = {
      s1: 'Alpha',
      s2: 'Beta',
      s3: 'Gamma',
      c1: 'Phones',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClose = vi.fn();
    act(() => {
      root.render(
        <LiveTables
          open
          onClose={onClose}
          engine={engine}
          labelOf={(id) => names[id]}
        />,
      );
    });
    expect(host.textContent).toContain('Asking maglev-lb');

    await vi.waitFor(() => expect(host.textContent).toContain('Gamma'), {
      timeout: 3000,
    });
    expect(host.textContent).toContain('EC2 instance i-0abc (c7i-flex.large)');
    expect(host.textContent).toContain('Generation 1');
    expect(fetchTables).toHaveBeenLastCalledWith(null);
    expect(host.textContent).toContain('No rebuild yet');
    const toggle = () =>
      [...host.querySelectorAll('button')].find((b) =>
        /moved slots/.test(b.textContent ?? ''),
      )!;
    expect(toggle().disabled).toBe(true);

    await vi.waitFor(() => expect(host.textContent).toContain('Generation 1 → 2'), {
      timeout: 3000,
    });
    // The canvas sent the generation it held, so the table only travels on change.
    expect(fetchTables).toHaveBeenLastCalledWith(1);
    expect(host.textContent).toContain(
      'Removed backend (slot 3) left. 2 of 6 slots (33.3%)',
    );
    expect(host.textContent).toContain('No other slot moved.');
    // The flow still pinned to the removed backend, and where its slot points now.
    const differs = host.querySelector('tr.is-differs')?.textContent ?? '';
    expect(differs).toContain('Removed backend (slot 3)');
    expect(differs).toContain('Alpha · the pin wins');
    // The moved slots are marked until hidden.
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    act(() => toggle().click());
    expect(toggle().textContent).toContain('Show moved slots');

    // Keys stop at the page, so the canvas underneath never sees Delete; Escape closes it.
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    window.removeEventListener('keydown', seen);
    expect(seen).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
