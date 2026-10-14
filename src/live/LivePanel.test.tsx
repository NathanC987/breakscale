// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { LivePanel } from './LivePanel';
import { toSimSnapshot } from './mapping';
import { LIVE_PRESET } from './preset';
import { frame } from './fixture.test-data';
import type { LiveEngine } from './LiveEngine';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(phase: 'serving' | 'detached') {
  const f = frame();
  f.backends['service-1'] = { ...f.backends['service-1']!, phase };
  const { view } = toSimSnapshot(f, LIVE_PRESET, [], null);
  const engine = {
    injectFailure: vi.fn(),
    clearFailure: vi.fn(),
    restart: vi.fn(),
    drain: vi.fn(),
    undrain: vi.fn(),
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <LivePanel
        node={LIVE_PRESET.nodes.find((n) => n.id === 'service-1')!}
        view={{ ...view, connection: 'live', problems: [] }}
        engine={engine as unknown as LiveEngine}
        onChange={() => {}}
      />,
    );
  });
  return { host, engine, root };
}

describe('LivePanel', () => {
  it('one click is one action', () => {
    const { host, engine, root } = render('serving');
    const crash = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Crash the process',
    )!;
    act(() => crash.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(engine.injectFailure).toHaveBeenCalledTimes(1);
    expect(engine.injectFailure).toHaveBeenCalledWith('service-1', 'crash');
    act(() => root.unmount());
  });

  it('offers no fault or drain controls for a backend with no process', () => {
    const { host, root } = render('detached');
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Crash the process');
    expect(labels).not.toContain('Stop new connections');
    expect(host.textContent).toMatch(/draw a wire from the load balancer/);
    act(() => root.unmount());
  });
});
