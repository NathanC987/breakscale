import type { NodeKind } from '../sim/types';

/**
 * Live mode: the canvas drives the real l4-maglev-lb load balancer through its
 * bridge, instead of the simulator. Chosen at build time (`vite --mode live`,
 * which reads `.env.live`), never at runtime, so the hosted simulator can never
 * start talking to a local daemon.
 */
export const LIVE: boolean = import.meta.env.VITE_LIVE === '1';

/** The only kinds the real system has: traffic sources, the balancer, backends. */
export const LIVE_KINDS: readonly NodeKind[] = ['client', 'lb', 'service'];

/** Fields the real system does not have, per kind (see Inspector hiddenFields). */
export const LIVE_HIDDEN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // maglev-lb's own settings (health checks, table size) are fixed when it starts.
  lb: ['instances', 'capacity', 'serviceMs', 'queueLimit'],
  // A backend is one real process; it neither scales out nor calls anything.
  service: ['instances', 'timeoutMs', 'retries'],
};

/** Separate from the simulator's session, so neither overwrites the other. */
export const LIVE_SESSION_KEY = 'breakscale.live.session.v1';

const TOKEN_KEY = 'breakscale.live.token';

/**
 * Take the bridge's access token from `#token=...` and remove it from the URL.
 *
 * The bridge prints `http://127.0.0.1:8790/#token=...`. A fragment never
 * reaches a server or its logs; keeping it out of the address bar afterwards
 * means it is not copied along with the URL either. sessionStorage, not
 * localStorage: the token dies with the tab, and the bridge mints a new one
 * every run anyway.
 */
export function captureToken(): void {
  try {
    const m = /(?:^#|&)token=([A-Za-z0-9]+)/.exec(window.location.hash);
    if (!m) return;
    sessionStorage.setItem(TOKEN_KEY, m[1] ?? '');
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  } catch {
    // Storage blocked: liveToken() returns null and the UI says so.
  }
}

export function liveToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
