import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the "Inside maglev-lb" page (LiveTables.tsx) is open.
 *
 * It covers the whole window, so it behaves like a page: opening it adds a
 * history entry (same URL), and the browser's Back button closes it rather
 * than leaving the app.
 */
const KEY = 'breakscaleTablesPage';

function isOurs(state: unknown): boolean {
  return typeof state === 'object' && state !== null && KEY in state;
}

export function useTablesPage() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // A reload keeps history.state but not the open page: forget the entry is ours.
    if (isOurs(window.history.state)) {
      const { [KEY]: _drop, ...rest } = window.history.state as Record<string, unknown>;
      window.history.replaceState(Object.keys(rest).length ? rest : null, '');
    }
    const onPop = (e: PopStateEvent) => setOpen(isOurs(e.state));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const show = useCallback(() => {
    if (!isOurs(window.history.state)) {
      const prev = window.history.state as Record<string, unknown> | null;
      window.history.pushState({ ...(prev ?? {}), [KEY]: true }, '');
    }
    setOpen(true);
  }, []);

  const hide = useCallback(() => {
    // Going back fires popstate, which closes the page.
    if (isOurs(window.history.state)) window.history.back();
    else setOpen(false);
  }, []);

  return { open, show, hide };
}
