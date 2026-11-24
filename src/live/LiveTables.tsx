import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BridgeFlowRow, BridgeTables, TablesResult } from './bridge';
import type { LiveEngine } from './LiveEngine';
import {
  type DescribedChange,
  GRID_COLS,
  decodeTable,
  describeChange,
  diffTables,
  fmt,
  gridRows,
  moduloMoved,
  ownerOf,
  pct,
} from './tables';
import './live.css';

/* ==========================================================================
   Inside maglev-lb: its live Maglev lookup table and conntrack table.

   A side sheet with no scrim, unlike the glossary: the point is to change the
   design on the canvas (remove a backend, drain one) and watch both tables
   react, so the canvas must stay usable behind it.

   The data is maglev-lb's own (src/ui/inspector.c), read once a second while
   this is open; maglev-lb copies its tables only while someone is asking.

   Five backends cannot all be told apart by hue alone on a grid where any two
   may touch (checked with the palette validator), so hue is never the only
   cue: pointing at a backend in the table fades every other backend's slots,
   and pointing at a slot names its owner.
   ========================================================================== */

const POLL_MS = 1000;
const MOVED_SHOW_MS = 6000;
const SERIES = 5;

interface Held {
  run: number | null;
  gen: number;
  table: Uint8Array;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
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
  /** The table being shown. The poller reads it through heldRef (no re-subscribe per poll). */
  const [held, setHeldState] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const setHeld = (h: Held | null) => {
    heldRef.current = h;
    setHeldState(h);
  };
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sheetRef = useRef<HTMLElement | null>(null);

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

  useEffect(() => {
    if (!showMoved) return;
    const t = setTimeout(() => setShowMoved(false), MOVED_SHOW_MS);
    return () => clearTimeout(t);
  }, [showMoved, change]);

  /* Draw the grid: one pixel per slot, scaled up by CSS. */
  useEffect(() => {
    const canvas = canvasRef.current;
    const h = held;
    if (!open || !canvas || !h || !doc) return;
    const css = getComputedStyle(sheetRef.current ?? canvas);
    const colors = Array.from({ length: SERIES }, (_, i) =>
      rgb(css.getPropertyValue(`--lt-be-${i + 1}`)),
    );
    const track = rgb(css.getPropertyValue('--lt-empty'));
    const faint = rgb(css.getPropertyValue('--lt-faded'));
    const ink = rgb(css.getPropertyValue('--lt-moved'));
    const rows = gridRows(h.table.length);
    canvas.width = GRID_COLS;
    canvas.height = rows;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(GRID_COLS, rows);
    const moved = showMoved && change?.toGeneration === h.gen ? change.moved : null;
    for (let i = 0; i < GRID_COLS * rows; i++) {
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
  }, [open, doc, held, focus, showMoved, change]);

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sheetRef.current?.contains(document.activeElement))
        onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const h = held;
  const m = doc?.m ?? 0;
  const rows = gridRows(m || 1);
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
    left: `${((slot % GRID_COLS) + 0.5) * (100 / GRID_COLS)}%`,
    top: `${(Math.floor(slot / GRID_COLS) + 0.5) * (100 / rows)}%`,
  });

  const onGridMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const col = Math.floor(((e.clientX - r.left) / r.width) * GRID_COLS);
    const row = Math.floor(((e.clientY - r.top) / r.height) * rows);
    const slot = row * GRID_COLS + col;
    setHoverSlot(col >= 0 && col < GRID_COLS && slot >= 0 && slot < m ? slot : null);
  };

  return (
    <aside
      ref={sheetRef}
      className="lt-sheet"
      aria-label="Inside maglev-lb: its Maglev and conntrack tables"
      data-chrome=""
    >
      <header className="lt-head">
        <div>
          <h2 className="lt-title">Inside maglev-lb</h2>
          <p className="lt-source">
            {doc?.source.where === 'aws'
              ? `Read from maglev-lb on EC2 instance ${doc.source.instance ?? '?'}${
                  doc.source.type ? ` (${doc.source.type})` : ''
                }, every second.`
              : 'Read from maglev-lb on this machine, every second.'}
          </p>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="lt-body">
        {status?.kind === 'error' && <p className="lt-alert">{status.message}</p>}
        {!doc && status?.kind !== 'error' && (
          <p className="ins-hint">Asking maglev-lb for a copy of its tables…</p>
        )}

        {doc && h && (
          <>
            <section className="lt-section">
              <h3 className="lt-h">Maglev lookup table</h3>
              <p className="lt-prose">
                {fmt(m)} slots, one pixel each. A new connection’s addresses and ports
                hash to one slot, and the slot’s backend gets it. Generation{' '}
                {fmt(doc.generation)}: rebuilt each time a backend joins, leaves, fails
                or drains.
              </p>

              <div className="lt-grid-wrap">
                <canvas
                  ref={canvasRef}
                  className="lt-grid"
                  style={{ aspectRatio: `${GRID_COLS} / ${rows}` }}
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
              <p className="lt-readout" aria-live="off">
                {hover && hoverSlot !== null
                  ? `Slot ${fmt(hoverSlot)} → ${hover.name}${hover.addr ? ` (${hover.addr})` : ''}`
                  : 'Point at the grid to read a slot.'}
              </p>

              {change && change.toGeneration === doc.generation && (
                <div className="lt-change">
                  <p>
                    {describeChange(change, (id: number) =>
                      nameOf(id, nodeOfId(doc, id)),
                    )}
                    {showMoved && (
                      <span className="lt-key">
                        <span
                          className="lt-swatch"
                          style={{ background: 'var(--lt-moved)' }}
                          aria-hidden="true"
                        />
                        marks them on the grid.
                      </span>
                    )}
                  </p>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setShowMoved((s) => !s)}
                  >
                    {showMoved ? 'Hide the moved slots' : 'Show the moved slots'}
                  </button>
                </div>
              )}
            </section>

            <section className="lt-section">
              <h3 className="lt-h">Backends</h3>
              <table className="lt-table">
                <thead>
                  <tr>
                    <th scope="col">Backend</th>
                    <th scope="col" className="num">
                      Slots
                    </th>
                    <th scope="col" className="num">
                      Pinned connections
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {backends.map((b) => (
                    <tr
                      key={b.lbId}
                      className={focus === b.lbId ? 'is-focus' : undefined}
                      onPointerEnter={() => setFocus(b.lbId)}
                      onPointerLeave={() => setFocus(null)}
                      onFocus={() => setFocus(b.lbId)}
                      onBlur={() => setFocus(null)}
                      tabIndex={0}
                    >
                      <td>
                        <span
                          className="lt-swatch"
                          style={{
                            background: `var(--lt-be-${(b.lbId % SERIES) + 1})`,
                          }}
                          aria-hidden="true"
                        />
                        {nameOf(b.lbId, b.node)}
                        <span className="lt-dim">
                          {' '}
                          {b.addr ??
                            `left the table; its pins expire after ${fmt(
                              Math.round(doc.ctTimeoutMs / 1000),
                            )} s idle`}
                          {b.inTable && b.slots === 0
                            ? ' · draining: no new connections'
                            : ''}
                        </span>
                      </td>
                      <td className="num">
                        {fmt(b.slots)} <span className="lt-dim">{pct(b.slots, m)}</span>
                      </td>
                      <td className="num">{fmt(b.flows)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="lt-hint">Point at a backend to see only its slots.</p>
            </section>

            <section className="lt-section">
              <h3 className="lt-h">Connection tracking table</h3>
              <p className="lt-prose">
                {fmt(doc.conntrack.active)} connections pinned. A connection’s first
                packet reads the Maglev table once and is pinned to that backend; every
                later packet follows the pin, so a rebuild never moves a live
                connection. A pin expires after{' '}
                {fmt(Math.round(doc.ctTimeoutMs / 1000))} s without packets.
              </p>
              {flowRows.length > 0 ? (
                <div className="lt-flows scroll">
                  <table className="lt-table">
                    <thead>
                      <tr>
                        <th scope="col">Client</th>
                        <th scope="col" className="num">
                          Slot
                        </th>
                        <th scope="col">Pinned to</th>
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
              <p className="lt-hint">
                The counts are exact. The rows are the {doc.conntrack.rowsPerBackend}{' '}
                most recently active connections per backend; point at one to find its
                slot. Copying the table took {(doc.conntrack.scanUs / 1000).toFixed(1)}{' '}
                ms.
              </p>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function nodeOfId(doc: BridgeTables, lbId: number): string | null {
  return (
    doc.backends.find((b) => b.lbId === lbId)?.node ??
    doc.conntrack.flows.find((f) => f.lbId === lbId)?.node ??
    null
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
      <td
        className="lt-nowrap"
        title={`${row.src}:${row.sport} → port ${row.dport}, ${row.proto}`}
      >
        {clientName}
        <span className="lt-dim">
          :{row.sport}
          {row.proto === 'tcp' ? '' : ` ${row.proto}`}
        </span>
      </td>
      <td className="num">{fmt(row.slot)}</td>
      <td>
        <span
          className="lt-swatch"
          style={{ background: `var(--lt-be-${(row.lbId % SERIES) + 1})` }}
          aria-hidden="true"
        />
        {pinnedName}
        {differs && (
          <span className="lt-differs">
            {' '}
            · table now:{' '}
            {tableOwner === null ? 'no backend' : tableOwnerName(tableOwner)}
          </span>
        )}
      </td>
      <td className="num">{(row.idleMs / 1000).toFixed(1)} s</td>
    </tr>
  );
}
