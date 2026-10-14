import type { Engine } from '../sim/engine';
import type {
  FailureKind,
  FailureOpts,
  NodeConfig,
  SimSnapshot,
  Topology,
} from '../sim/types';
import {
  type BridgeEvent,
  type BridgeSnapshot,
  type LiveAction,
  isBridgeSnapshot,
} from './bridge';
import { type ConnState, type LiveView, emptySnapshot, toSimSnapshot } from './mapping';
import { liveToken } from './mode';
import { desiredFromTopology, liveProblems } from './validate';

/** The part of the simulator App drives. LiveEngine stands in for all of it. */
export type AppEngine = Pick<
  Engine,
  'advance' | 'snapshot' | 'setTopology' | 'updateNodeConfig' | 'reset'
>;

const API = '/api/v1';
const PUT_DEBOUNCE_MS = 150;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const EVENT_LOG_LEN = 30;

type Fetch = typeof fetch;

/**
 * The real system behind the simulator's interface.
 *
 * `advance()` does nothing: time is real. `snapshot()` returns the latest
 * frame the bridge streamed, already mapped to the simulator's shape.
 * Topology and config edits become a desired-state document that is PUT to
 * the bridge (debounced, and always the whole state, so a lost request or a
 * restarted bridge converges on the next one).
 *
 * The constructor does no I/O. React StrictMode runs useState initialisers
 * twice in development; network work starts in connect(), called from an
 * effect whose cleanup is dispose().
 */
export class LiveEngine implements AppEngine {
  private topology: Topology;
  private snap: SimSnapshot;
  private view: LiveView;
  private last: BridgeSnapshot | null = null;
  private sessionId: string | null = null;
  private loadEnabled = true;
  private conn: ConnState = 'connecting';
  private putTimer: ReturnType<typeof setTimeout> | null = null;
  private putInFlight = false;
  private putDirty = false;
  private abort: AbortController | null = null;
  /**
   * Bumped by every connect() and dispose(). A stream loop runs only while
   * the generation it started in is current. `stopped` alone is not enough:
   * StrictMode's connect, dispose, connect clears it again before the first
   * loop has noticed its fetch was aborted, and that loop then carried on
   * beside the new one, holding a second stream open for good.
   */
  private generation = 0;
  private stopped = true;
  private backoff = RECONNECT_MIN_MS;
  private lastError: string | null = null;
  private eventLog: BridgeEvent[] = [];
  private readonly fetchImpl: Fetch;

  constructor(topology: Topology, fetchImpl?: Fetch) {
    this.topology = topology;
    this.snap = emptySnapshot(topology);
    this.fetchImpl = fetchImpl ?? ((...a) => fetch(...a));
    this.view = this.baseView();
  }

  /* ---- the simulator's interface ---------------------------------------- */

  advance(_deltaMs: number): void {
    // Real time needs no advancing.
  }

  snapshot(): SimSnapshot {
    return this.snap;
  }

  setTopology(t: Topology): void {
    this.topology = t;
    this.remap();
    this.schedulePut();
  }

  updateNodeConfig(id: string, patch: Partial<NodeConfig>): void {
    this.topology = {
      ...this.topology,
      nodes: this.topology.nodes.map((n) =>
        n.id === id ? { ...n, config: { ...n.config, ...patch } } : n,
      ),
    };
    this.schedulePut();
  }

  /** A new measurement session: counters and history start over, faults clear. */
  reset(): void {
    void this.post('/session/reset', {});
  }

  injectFailure(nodeId: string, kind: FailureKind, opts: FailureOpts = {}): void {
    if (kind === 'slow') {
      this.act({ action: 'slow', target: nodeId, factor: opts.factor ?? 4 });
    } else if (kind === 'errors') {
      this.act({ action: 'errors', target: nodeId, rate: opts.rate ?? 0.3 });
    } else {
      this.act({ action: kind, target: nodeId });
    }
  }

  clearFailure(nodeId: string): void {
    this.act({ action: 'clear', target: nodeId });
  }

  /* ---- live-only controls ----------------------------------------------- */

  restart(nodeId: string): void {
    this.act({ action: 'restart', target: nodeId });
  }

  drain(nodeId: string): void {
    this.act({ action: 'drain', target: nodeId });
  }

  undrain(nodeId: string): void {
    this.act({ action: 'undrain', target: nodeId });
  }

  /** Pause and play: the real clients stop and start sending. */
  setLoadEnabled(on: boolean): void {
    if (on === this.loadEnabled) return;
    this.loadEnabled = on;
    this.schedulePut();
  }

  liveView(): LiveView {
    return this.view;
  }

  /* ---- connection ------------------------------------------------------- */

  connect(): () => void {
    this.stopped = false;
    void this.streamLoop(++this.generation);
    return () => this.dispose();
  }

  dispose(): void {
    this.stopped = true;
    this.generation += 1;
    this.abort?.abort();
    if (this.putTimer) clearTimeout(this.putTimer);
    this.putTimer = null;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${liveToken() ?? ''}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  private setConn(c: ConnState): void {
    if (this.conn === c) return;
    this.conn = c;
    this.view = { ...this.view, connection: c };
  }

  private async streamLoop(gen: number): Promise<void> {
    const current = () => gen === this.generation && !this.stopped;
    while (current()) {
      const abort = new AbortController();
      this.abort = abort;
      try {
        const res = await this.fetchImpl(`${API}/stream`, {
          headers: this.headers(false),
          signal: abort.signal,
        });
        if (!current()) {
          abort.abort();
          return;
        }
        if (res.status === 401) {
          this.setConn('unauthorized');
          return; // retrying cannot fix a missing token
        }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        this.backoff = RECONNECT_MIN_MS;
        this.setConn('live');
        // The bridge may have restarted and know nothing of this canvas.
        this.schedulePut(0);
        await this.readEvents(res.body);
      } catch {
        if (!current()) return;
      }
      if (!current()) return;
      this.setConn(this.last ? 'reconnecting' : 'offline');
      await new Promise((r) => setTimeout(r, this.backoff));
      this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
    }
  }

  /** Server-sent events, parsed by hand: EventSource cannot send a token. */
  private async readEvents(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let event = 'message';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trimStart();
        }
        if (event === 'snapshot' && data) this.onFrame(data);
      }
    }
  }

  onFrame(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isBridgeSnapshot(parsed)) return;
    // Each frame carries only the events new since the previous one.
    if (parsed.sessionId !== this.last?.sessionId) this.eventLog = [];
    this.eventLog = this.eventLog.concat(parsed.events).slice(-EVENT_LOG_LEN);
    this.last = parsed;
    this.remap();
  }

  private baseView(): LiveView {
    return {
      connection: this.conn,
      phase: null,
      loadEnabled: this.loadEnabled,
      autoPaused: false,
      errors: this.lastError ? [this.lastError] : [],
      problems: liveProblems(this.topology),
      nodes: {},
      lb: null,
      returnEdges: [],
      events: [],
    };
  }

  /** Re-derive the snapshot from the last frame against the current canvas. */
  private remap(): void {
    if (!this.last) {
      this.snap = emptySnapshot(this.topology);
      this.view = this.baseView();
      return;
    }
    const { snapshot, view } = toSimSnapshot(
      this.last,
      this.topology,
      this.snap.history,
      this.sessionId,
    );
    this.sessionId = this.last.sessionId;
    this.snap = snapshot;
    this.view = {
      ...view,
      connection: this.conn,
      problems: liveProblems(this.topology),
      errors: this.lastError ? [...view.errors, this.lastError] : view.errors,
      events: this.eventLog,
    };
  }

  /* ---- writes ----------------------------------------------------------- */

  private schedulePut(delay = PUT_DEBOUNCE_MS): void {
    if (this.stopped) return;
    if (this.putTimer) clearTimeout(this.putTimer);
    this.putTimer = setTimeout(() => {
      this.putTimer = null;
      void this.flushPut();
    }, delay);
  }

  private async flushPut(): Promise<void> {
    if (this.putInFlight) {
      this.putDirty = true;
      return;
    }
    this.putInFlight = true;
    try {
      const doc = desiredFromTopology(this.topology, this.loadEnabled);
      const res = await this.fetchImpl(`${API}/desired`, {
        method: 'PUT',
        headers: this.headers(true),
        body: JSON.stringify(doc),
      });
      if (res.status === 422) {
        const body = (await res.json()) as { errors?: { path: string; msg: string }[] };
        this.lastError = `The bridge rejected this design: ${
          body.errors?.map((e) => `${e.path} ${e.msg}`).join('; ') ?? 'unknown reason'
        }`;
      } else if (!res.ok) {
        this.lastError = `The bridge answered ${res.status} to a design update.`;
      } else {
        this.lastError = null;
      }
    } catch {
      // Offline: the stream loop re-sends the whole state on reconnect.
    } finally {
      this.putInFlight = false;
      this.remap();
      if (this.putDirty) {
        this.putDirty = false;
        this.schedulePut(0);
      }
    }
  }

  private act(a: LiveAction): void {
    void this.post('/actions', a);
  }

  private async post(path: string, body: object): Promise<void> {
    try {
      const res = await this.fetchImpl(`${API}${path}`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        this.lastError = b.error ?? `The bridge answered ${res.status}.`;
      } else {
        this.lastError = null;
      }
    } catch {
      this.lastError = 'The bridge is not reachable.';
    }
    this.remap();
  }
}
