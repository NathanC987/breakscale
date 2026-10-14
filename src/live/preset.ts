import { defaultConfig } from '../sim/presets';
import type { NodeConfig, NodeKind, SimNode, Topology } from '../sim/types';

function node(
  id: string,
  kind: NodeKind,
  label: string,
  x: number,
  y: number,
  overrides: Partial<NodeConfig> = {},
): SimNode {
  return { id, kind, label, x, y, config: { ...defaultConfig(kind), ...overrides } };
}

/**
 * The starting design in live mode: one client population, the real
 * maglev-lb, and three backends. At the default 100 requests per second each
 * backend sees about 33, well under its ceiling of
 * capacity 8 * (1000 / 25ms) = 320, so it starts healthy and has room to
 * overload as the load is raised.
 */
export const LIVE_PRESET: Topology = {
  nodes: [
    node('client-1', 'client', 'Clients', 40, 200, {
      rps: 100,
      timeoutMs: 1000,
      poolSize: 0,
    }),
    node('lb-1', 'lb', 'maglev-lb', 320, 200),
    node('service-1', 'service', 'Backend 1', 600, 60),
    node('service-2', 'service', 'Backend 2', 600, 200),
    node('service-3', 'service', 'Backend 3', 600, 340),
  ],
  edges: [
    { id: 'client-1->lb-1', from: 'client-1', to: 'lb-1', weight: 1 },
    { id: 'lb-1->service-1', from: 'lb-1', to: 'service-1', weight: 1 },
    { id: 'lb-1->service-2', from: 'lb-1', to: 'service-2', weight: 1 },
    { id: 'lb-1->service-3', from: 'lb-1', to: 'service-3', weight: 1 },
  ],
};
