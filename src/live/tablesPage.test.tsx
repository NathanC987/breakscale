// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { useTablesPage } from './tablesPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Probe() {
  const { open, show, hide } = useTablesPage();
  return (
    <>
      <output>{open ? 'open' : 'closed'}</output>
      <button id="show" onClick={show} />
      <button id="hide" onClick={hide} />
    </>
  );
}

describe('the tables page', () => {
  it('opens with a history entry, so Back closes it', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    const state = () => host.querySelector('output')!.textContent;
    const click = (id: string) =>
      act(() => host.querySelector<HTMLElement>(`#${id}`)!.click());
    const before = window.history.length;

    click('show');
    expect(state()).toBe('open');
    expect(window.history.length).toBe(before + 1);

    // The page's own close button goes back too, rather than stacking entries.
    click('hide');
    await vi.waitFor(() => expect(state()).toBe('closed'));

    // Forward reopens it, like any page.
    act(() => window.history.forward());
    await vi.waitFor(() => expect(state()).toBe('open'));
    act(() => window.history.back());
    await vi.waitFor(() => expect(state()).toBe('closed'));
    act(() => root.unmount());
  });
});
