import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { BridgeFlowRow, BridgeTables, TablesResult } from './bridge';
import type { LiveEngine } from './LiveEngine';
import {
  type DescribedChange,
  type GridShape,
  decodeTable,
  describeChange,
  diffTables,
  fmt,
  gridShape,
  moduloMoved,
  ownerOf,
  pct,
} from './tables';
import './live.css';

/* ==========================================================================
   Inside maglev-lb: its live Maglev lookup table and conntrack table.

   A page of its own over the whole window (useTablesPage in tablesPage.ts
   opens and closes it, and the browser's Back button closes it too). The
   Maglev grid gets most of the window, sized to fit it in whole device
   pixels per slot; the facts, the moved-slot toggle and the backends sit in
   a narrow column to its right, and the conntrack table runs underneath.

   The data is maglev-lb's own (src/ui/inspector.c), read once a second while
   this is open; maglev-lb copies its tables only while someone is asking.
   The last table seen is kept while the page is closed, so going back to the
   canvas, removing a backend and coming back shows what that rebuild moved.

   Five backends cannot all be told apart by hue alone on a grid where any two
   may touch (checked with the palette validator), so hue is never the only
   cue: pointing at a backend fades every other backend's slots, and pointing
   at a slot names its owner.
   ========================================================================== */

const POLL_MS = 1000;
const SERIES = 5;
/** The grid never shrinks below this height to fit a short window. */
const MIN_GRID_H = 240;
/** Room left under the grid, in CSS px, so its bottom edge is not flush with the window. */
const GRID_BOTTOM_GAP = 16;

interface Held {
  run: number | null;
  gen: number;
  table: Uint8Array;
}

type Shape = GridShape & { dpr: number };

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable === true
  );
}

export function LiveTables({
  open,
  onClose,
  engine,
  labelOf,
}: {
  open: boolean;
  onClose: () => void;
  engine: LiveEngine;
  /** A canvas node's name, for backends and clients. */
  labelOf: (nodeId: string) => string | undefined;
}) {
  const [doc, setDoc] = useState<BridgeTables | null>(null);
  const [status, setStatus] = useState<TablesResult | null>(null);
  const [change, setChange] = useState<DescribedChange | null>(null);
  const [showMoved, setShowMoved] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [hoverSlot, setHoverSlot] = useState<number | null>(null);
  const [markSlot, setMarkSlot] = useState<number | null>(null);
  const [shape, setShape] = useState<Shape>(() => ({
    ...gridShape(0, 0, 0),
    dpr: 1,
  }));
  /** The table being shown. The poller reads it through heldRef (no re-subscribe per poll). */
  const [held, setHeldState] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const setHeld = (h: Held | null) => {
    heldRef.current = h;
    setHeldState(h);
  };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const gridBoxRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  /* Poll while open. Each request names the generation already held, so the
     table itself only travels when it changes. */
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const h = heldRef.current;
      const r = await engine.fetchTables(h ? h.gen : null);
      if (stopped) return;
      let again = POLL_MS;
      if (r.kind === 'tables') {
        const d = r.doc;
        const run = d.run;
        if (d.table) {
          const table = decodeTable(d.table);
          if (h && h.run === run && h.gen !== d.generation) {
            const ch = diffTables(h.table, table, h.gen, d.generation);
            if (ch) {
              const ids = (t: Uint8Array) =>
                [...new Set([...t].filter((v) => v > 0).map((v) => v - 1))].sort(
                  (a, b) => a - b,
                );
              setChange({
                ...ch,
                m: d.m,
                modulo: moduloMoved(ids(h.table), ids(table), d.m),
              });
              setShowMoved(true);
            }
          }
          setHeld({ run, gen: d.generation, table });
        } else if (!h || h.run !== run) {
          // A restarted maglev-lb reused this generation number: ask for its table.
          setHeld(null);
          again = 0;
        }
        setDoc(d);
        setStatus(null);
      } else {
        setStatus(r);
      }
      timer = setTimeout(() => void poll(), again);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, engine]);

  /* A page over the whole window: focus moves onto it and back to whatever
     opened it, and keys stop here, so Delete cannot remove the load balancer
     still selected on the canvas underneath. Escape closes it. */
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [open, onClose]);

  const m = doc?.m ?? 0;
  const ready = Boolean(doc && held);

  /* Fit the grid to the space it has: the width of its column, and the window
     height below the page header. */
  useLayoutEffect(() => {
    const box = gridBoxRef.current;
    const page = pageRef.current;
    if (!open || !ready || !box || !page || m <= 0) return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const top =
        box.getBoundingClientRect().top -
        page.getBoundingClientRect().top +
        page.scrollTop;
      const height = Math.max(MIN_GRID_H, page.clientHeight - top - GRID_BOTTOM_GAP);
      const next = gridShape(m, box.clientWidth * dpr, height * dpr);
      setShape((s) =>
        s.cols === next.cols &&
        s.rows === next.rows &&
        s.px === next.px &&
        s.dpr === dpr
          ? s
          : { ...next, dpr },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(page);
    return () => ro.disconnect();
  }, [open, ready, m]);

  /* Draw the grid: one canvas pixel per slot, scaled up by a whole number of
     device pixels. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const h = held;
    if (!open || !canvas || !h || !doc) return;
    const css = getComputedStyle(pageRef.current ?? canvas);
    const colors = Array.from({ length: SERIES }, (_, i) =>
      rgb(css.getPropertyValue(`--lt-be-${i + 1}`)),
    );
    const track = rgb(css.getPropertyValue('--lt-empty'));
    const faint = rgb(css.getPropertyValue('--lt-faded'));
    const ink = rgb(css.getPropertyValue('--lt-moved'));
    const { cols, rows } = shape;
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(cols, rows);
    const moved = showMoved && change?.toGeneration === h.gen ? change.moved : null;
    for (let i = 0; i < cols * rows; i++) {
      let c: [number, number, number];
      const v = i < h.table.length ? h.table[i]! : -1;
      if (v < 0) c = faint;
      else if (moved && moved[i]) c = ink;
      else if (v === 0) c = track;
      else if (focus !== null && v - 1 !== focus) c = faint;
      else c = colors[(v - 1) % SERIES]!;
      img.data.set([c[0], c[1], c[2], v < 0 ? 0 : 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
  }, [open, doc, held, focus, showMoved, change, shape]);

  const nameOf = useCallback(
    (lbId: number, node: string | null) =>
      (node && labelOf(node)) || `Removed backend (slot ${lbId + 1})`,
    [labelOf],
  );

  const backends = useMemo(() => {
    if (!doc) return [];
    const flows = new Map(doc.conntrack.flows.map((f) => [f.lbId, f]));
    const rows = doc.backends.map((b) => ({
      lbId: b.lbId,
      node: b.node,
      addr: b.addr as string | null,
      slots: b.slots,
      flows: flows.get(b.lbId)?.n ?? 0,
      inTable: true,
    }));
    // Pinned connections can outlive their backend's place in the table.
    for (const f of doc.conntrack.flows) {
      if (!doc.backends.some((b) => b.lbId === f.lbId)) {
        rows.push({
          lbId: f.lbId,
          node: f.node,
          addr: null,
          slots: 0,
          flows: f.n,
          inTable: false,
        });
      }
    }
    return rows.sort((a, b) => a.lbId - b.lbId);
  }, [doc]);

  const flowRows = useMemo(
    () => (doc ? [...doc.conntrack.rows].sort((a, b) => a.idleMs - b.idleMs) : []),
    [doc],
  );

  if (!open) return null;

  const h = held;
  const { cols, rows, px, dpr } = shape;
  const slotInfo = (slot: number) => {
    if (!h) return null;
    const id = ownerOf(h.table, slot);
    const b = id === null ? undefined : doc?.backends.find((x) => x.lbId === id);
    return {
      id,
      name: id === null ? 'no backend' : nameOf(id, b?.node ?? null),
      addr: b?.addr,
    };
  };
  const hover = hoverSlot === null ? null : slotInfo(hoverSlot);
  const markAt = (slot: number) => ({
    left: `${((slot % cols) + 0.5) * (100 / cols)}%`,
    top: `${(Math.floor(slot / cols) + 0.5) * (100 / rows)}%`,
  });
  const currentChange =
    change && doc && change.toGeneration === doc.generation ? change : null;
  const timeoutS = doc ? fmt(Math.round(doc.ctTimeoutMs / 1000)) : '';

  const onGridMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * cols);
    const row = Math.floor(((e.clientY - r.top) / r.height) * rows);
    const slot = row * cols + col;
    setHoverSlot(col >= 0 && col < cols && slot >= 0 && slot < m ? slot : null);
  };

  return (
    <div
      ref={pageRef}
      className="lt-page"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lt-title"
      data-chrome=""
    >
      <header className="lt-head">
        <button type="button" className="btn btn-sm" onClick={onClose}>
          <span aria-hidden="true">←</span> Back to the canvas
        </button>
        <div className="lt-head-text">
          <h2 id="lt-title" className="lt-title" ref={titleRef} tabIndex={-1}>
            Inside maglev-lb
          </h2>
          <p className="lt-source">
            {doc?.source.where === 'aws'
              ? `Read from maglev-lb on EC2 instance ${doc.source.instance ?? '?'}${
                  doc.source.type ? ` (${doc.source.type})` : ''
                }, every second.`
              : 'Read from maglev-lb on this machine, every second.'}
          </p>
        </div>
      </header>

      <div className="lt-body">
        {status?.kind === 'error' && <p className="lt-alert">{status.message}</p>}
        {!ready && status?.kind !== 'error' && (
          <p className="ins-hint">Asking maglev-lb for a copy of its tables…</p>
        )}

        {doc && h && (
          <>
            <section className="lt-maglev" aria-labelledby="lt-maglev-h">
              <div className="lt-grid-box" ref={gridBoxRef}>
                <div
                  className="lt-grid-wrap"
                  style={{ width: (cols * px) / dpr, height: (rows * px) / dpr }}
                >
                  <canvas
                    ref={canvasRef}
                    className="lt-grid"
                    role="img"
                    aria-label={`Maglev table, ${fmt(m)} slots: ${backends
                      .filter((b) => b.inTable && b.slots > 0)
                      .map((b) => `${nameOf(b.lbId, b.node)} ${pct(b.slots, m)}`)
                      .join(', ')}`}
                    onPointerMove={onGridMove}
                    onPointerLeave={() => setHoverSlot(null)}
                  />
                  {markSlot !== null && (
                    <span
                      className="lt-mark"
                      style={markAt(markSlot)}
                      aria-hidden="true"
                    />
                  )}
                </div>
              </div>

              <div className="lt-side">
                <h3 id="lt-maglev-h" className="lt-h">
                  Maglev lookup table
                </h3>
                <p className="lt-prose">
                  {fmt(m)} slots, one square each, numbered left to right and top to
                  bottom. A new connection’s addresses and ports hash to one slot, and
                  the slot’s backend gets it.
                </p>
                <p className="lt-gen">
                  Generation <strong>{fmt(doc.generation)}</strong>
                  <span className="lt-dim">
                    {' '}
                    · rebuilt when a backend joins, leaves, fails or drains
                  </span>
                </p>
                <p className="lt-readout" aria-live="off">
                  {hover && hoverSlot !== null
                    ? `Slot ${fmt(hoverSlot)} → ${hover.name}${hover.addr ? ` (${hover.addr})` : ''}`
                    : 'Point at the grid to read a slot.'}
                </p>

                <div className="lt-change">
                  <p>
                    {currentChange
                      ? describeChange(currentChange, (id: number) =>
                          nameOf(id, nodeOfId(doc, id)),
                        )
                      : 'No rebuild yet. Remove, drain or add a backend on the canvas and come back: the slots that changed owner are marked here.'}
                  </p>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={showMoved && currentChange !== null}
                    disabled={!currentChange}
                    onClick={() => setShowMoved((s) => !s)}
                  >
                    <span
                      className="lt-swatch"
                      style={{ background: 'var(--lt-moved)' }}
                      aria-hidden="true"
                    />
                    {showMoved && currentChange
                      ? 'Hide moved slots'
                      : 'Show moved slots'}
                  </button>
                </div>

                <h3 className="lt-h lt-h-gap">Backends</h3>
                <ul className="lt-legend">
                  {backends.map((b) => (
                    <li
                      key={b.lbId}
                      className={focus === b.lbId ? 'is-focus' : undefined}
                      onPointerEnter={() => setFocus(b.lbId)}
                      onPointerLeave={() => setFocus(null)}
                      onFocus={() => setFocus(b.lbId)}
                      onBlur={() => setFocus(null)}
                      tabIndex={0}
                    >
                      <Swatch lbId={b.lbId} />
                      <span className="lt-legend-name">
                        {nameOf(b.lbId, b.node)}
                        {b.addr && <span className="lt-legend-ip">{b.addr}</span>}
                      </span>
                      <span className="lt-legend-num">{pct(b.slots, m)}</span>
                      <span className="lt-legend-sub">
                        {fmt(b.slots)} slots · {fmt(b.flows)} pinned
                        {b.inTable && b.slots === 0
                          ? ' · draining: no new connections'
                          : ''}
                        {!b.inTable &&
                          ` · left the table; pins expire after ${timeoutS} s idle`}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="lt-hint">Point at a backend to see only its slots.</p>
              </div>
            </section>

            <section className="lt-ct" aria-labelledby="lt-ct-h">
              <h3 id="lt-ct-h" className="lt-h">
                Connection tracking table
              </h3>
              <dl className="lt-stats">
                <div>
                  <dt>Connections pinned</dt>
                  <dd>{fmt(doc.conntrack.active)}</dd>
                </div>
                <div>
                  <dt>A pin expires after</dt>
                  <dd>{timeoutS} s idle</dd>
                </div>
                <div>
                  <dt>Copying both tables took</dt>
                  <dd>{(doc.conntrack.scanUs / 1000).toFixed(1)} ms</dd>
                </div>
              </dl>
              <p className="lt-prose">
                A connection’s first packet reads the Maglev table once and is pinned to
                that backend; every later packet follows the pin, so a rebuild never
                moves a live connection. Highlighted rows are pinned somewhere other
                than where their slot points now. The counts are exact; the rows are the{' '}
                {doc.conntrack.rowsPerBackend} most recently active connections per
                backend. Point at a row to find its slot on the grid.
              </p>
              {flowRows.length > 0 ? (
                <div className="lt-flows">
                  <table className="lt-table">
                    <thead>
                      <tr>
                        <th scope="col">Client</th>
                        <th scope="col">From</th>
                        <th scope="col" className="num">
                          Slot
                        </th>
                        <th scope="col">Pinned to</th>
                        <th scope="col">Slot’s backend now</th>
                        <th scope="col" className="num">
                          Idle
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {flowRows.map((r) => (
                        <FlowRow
                          key={`${r.src}:${r.sport}:${r.proto}`}
                          row={r}
                          clientName={(r.client && labelOf(r.client)) || r.src}
                          pinnedName={nameOf(r.lbId, r.node)}
                          tableOwner={ownerOf(h.table, r.slot)}
                          tableOwnerName={(id) => nameOf(id, nodeOfId(doc, id))}
                          onMark={setMarkSlot}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="ins-hint">No connections yet. Turn the load up.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function nodeOfId(doc: BridgeTables, lbId: number): string | null {
  return (
    doc.backends.find((b) => b.lbId === lbId)?.node ??
    doc.conntrack.flows.find((f) => f.lbId === lbId)?.node ??
    null
  );
}

function Swatch({ lbId }: { lbId: number }) {
  return (
    <span
      className="lt-swatch"
      style={{ background: `var(--lt-be-${(lbId % SERIES) + 1})` }}
      aria-hidden="true"
    />
  );
}

function FlowRow({
  row,
  clientName,
  pinnedName,
  tableOwner,
  tableOwnerName,
  onMark,
}: {
  row: BridgeFlowRow;
  clientName: string;
  pinnedName: string;
  tableOwner: number | null;
  tableOwnerName: (id: number) => string;
  onMark: (slot: number | null) => void;
}) {
  // The pin outranks the table: after a rebuild these two can disagree, and the
  // connection stays where it is.
  const differs = tableOwner !== row.lbId;
  return (
    <tr
      className={differs ? 'is-differs' : undefined}
      onPointerEnter={() => onMark(row.slot)}
      onPointerLeave={() => onMark(null)}
      onFocus={() => onMark(row.slot)}
      onBlur={() => onMark(null)}
      tabIndex={0}
    >
      <td className="lt-nowrap">{clientName}</td>
      <td className="lt-nowrap lt-dim">
        {row.src}:{row.sport} → :{row.dport}
        {row.proto === 'tcp' ? '' : ` ${row.proto}`}
      </td>
      <td className="num">{fmt(row.slot)}</td>
      <td>
        <Swatch lbId={row.lbId} />
        {pinnedName}
      </td>
      <td>
        {differs ? (
          <span className="lt-differs">
            {tableOwner === null ? (
              'no backend'
            ) : (
              <>
                <Swatch lbId={tableOwner} />
                {tableOwnerName(tableOwner)}
              </>
            )}{' '}
            · the pin wins
          </span>
        ) : (
          <span className="lt-dim">same</span>
        )}
      </td>
      <td className="num">{(row.idleMs / 1000).toFixed(1)} s</td>
    </tr>
  );
}
