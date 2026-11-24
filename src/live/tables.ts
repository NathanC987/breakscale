/**
 * Pure helpers for the live tables view (LiveTables.tsx): decoding maglev-lb's
 * Maglev table and describing what a rebuild changed.
 */

/** Slot -> backend id + 1 (0 = empty), as maglev-lb sends it. */
export function decodeTable(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The backend id owning a slot, or null for an empty slot. */
export function ownerOf(table: Uint8Array, slot: number): number | null {
  const v = table[slot];
  return v === undefined || v === 0 ? null : v - 1;
}

export interface TableChange {
  fromGeneration: number;
  toGeneration: number;
  /** Slots whose owner changed, one byte per slot (1 = moved). */
  moved: Uint8Array;
  movedCount: number;
  /** Backend ids that own slots now and did not before, and the reverse. */
  added: number[];
  removed: number[];
  /** Moved slots that belonged to a backend still in the table: Maglev keeps these few. */
  movedBetweenSurvivors: number;
}

/** What one table rebuild did. null if the sizes differ (maglev-lb restarted with another M). */
export function diffTables(
  before: Uint8Array,
  after: Uint8Array,
  fromGeneration: number,
  toGeneration: number,
): TableChange | null {
  if (before.length !== after.length) return null;
  const owners = (t: Uint8Array) => {
    const s = new Set<number>();
    for (const v of t) if (v) s.add(v - 1);
    return s;
  };
  const was = owners(before);
  const now = owners(after);
  const moved = new Uint8Array(after.length);
  let movedCount = 0;
  let between = 0;
  for (let i = 0; i < after.length; i++) {
    const a = before[i]!;
    const b = after[i]!;
    if (a !== b) {
      moved[i] = 1;
      movedCount++;
      if (a && b && now.has(a - 1) && was.has(b - 1)) between++;
    }
  }
  return {
    fromGeneration,
    toGeneration,
    moved,
    movedCount,
    added: [...now].filter((id) => !was.has(id)).sort((x, y) => x - y),
    removed: [...was].filter((id) => !now.has(id)).sort((x, y) => x - y),
    movedBetweenSurvivors: between,
  };
}

/** Columns of the grid; the table is drawn row by row, slot 0 top left. */
export const GRID_COLS = 256;

export function gridRows(m: number): number {
  return Math.ceil(m / GRID_COLS);
}

export const fmt = (n: number) => n.toLocaleString('en-US');
export const pct = (n: number, of: number) =>
  of > 0 ? `${((100 * n) / of).toFixed(1)}%` : '0%';

/** A rebuild, with the slot count and what mod-N hashing would have moved. */
export type DescribedChange = TableChange & { modulo: number; m: number };

/** If the backends were picked by hash mod N instead: how many slots that rebuild would have moved. */
export function moduloMoved(before: number[], after: number[], m: number): number {
  if (before.length === 0 || after.length === 0) return m;
  let moved = 0;
  for (let i = 0; i < m; i++) {
    if (before[i % before.length] !== after[i % after.length]) moved++;
  }
  return moved;
}

function names(ids: number[], nameOf: (id: number) => string): string {
  return ids.map(nameOf).join(' and ');
}

export function describeChange(
  c: DescribedChange,
  nameOf: (id: number) => string,
): string {
  const head = `Generation ${fmt(c.fromGeneration)} → ${fmt(c.toGeneration)}: `;
  const share = `${fmt(c.movedCount)} of ${fmt(c.m)} slots (${pct(c.movedCount, c.m)}) changed owner`;
  const mod = ` Picking a backend by hash mod N instead would have moved ${pct(c.modulo, c.m)}.`;
  if (c.removed.length && !c.added.length) {
    return (
      `${head}${names(c.removed, nameOf)} left. ${share}: the slots ${
        c.removed.length === 1 ? 'it' : 'they'
      } had, handed to the others` +
      (c.movedBetweenSurvivors
        ? `, plus ${fmt(c.movedBetweenSurvivors)} that moved between backends that stayed.`
        : '. No other slot moved.') +
      mod
    );
  }
  if (c.added.length && !c.removed.length) {
    return (
      `${head}${names(c.added, nameOf)} joined. ${share}: the share it took from the others` +
      (c.movedBetweenSurvivors
        ? `, plus ${fmt(c.movedBetweenSurvivors)} that moved between the others.`
        : '. No other slot moved.') +
      mod
    );
  }
  return `${head}${share}.${mod}`;
}
