import assert from 'node:assert/strict';
import test from 'node:test';

import type { Connector, DiagramState, Shape } from '../src/store/types';

/** Randomised round-trip check of the history stack.
 *
 *  For each seed: apply a random sequence of store operations (atomic
 *  edits, live gestures, history batches, coalesced nudges, adds, deletes,
 *  paste, group/ungroup, flip, z-order, replace, title), asserting after
 *  every one that it recorded EXACTLY one entry if it changed the document
 *  and NONE if it didn't. Then undo all the way back and redo all the way
 *  forward, asserting the document is byte-identical to the recorded state
 *  at every step. Undo/redo pairs are also thrown in mid-sequence.
 *
 *  Failures print the seed and the operation log so they can be replayed. */
const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => {
      mem.set(k, String(v));
    },
    removeItem: (k: string) => {
      mem.delete(k);
    },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() {
      return mem.size;
    },
  },
});
const { useEditor } = await import('../src/store/editor');
const st = () => useEditor.getState();

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rnd = () => number;
const int = (rnd: Rnd, n: number) => Math.floor(rnd() * n);
const pick = <T,>(rnd: Rnd, xs: readonly T[]): T => xs[int(rnd, xs.length)];

let seq = 0;
function rect(id: string, extra: Partial<Shape> = {}): Shape {
  return {
    id,
    kind: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 60,
    layer: 'blueprint',
    ...extra,
  } as Shape;
}
function line(id: string, from: { x: number; y: number }, to: { x: number; y: number }): Connector {
  return { id, kind: 'line', from, to, layer: 'blueprint' } as Connector;
}

function fresh() {
  seq = 0;
  const d = {
    version: '1.0',
    meta: { title: 'fuzz' },
    shapes: [
      rect('a', { x: 0, y: 0 }),
      rect('b', { x: 200, y: 0 }),
      rect('c', { x: 400, y: 0 }),
      rect('d', { x: 0, y: 200 }),
    ],
    connectors: [line('k', { x: 50, y: 300 }, { x: 250, y: 300 })],
    annotations: [],
  } as unknown as DiagramState;
  st().loadDiagram(d, null);
}

const snap = () =>
  JSON.stringify({
    shapes: st().diagram.shapes,
    connectors: st().diagram.connectors,
    title: st().diagram.meta?.title,
  });

const plainIds = () =>
  st()
    .diagram.shapes.filter((s) => s.kind !== 'group')
    .map((s) => s.id);
const groupIds = () =>
  st()
    .diagram.shapes.filter((s) => s.kind === 'group')
    .map((s) => s.id);
const connIds = () => st().diagram.connectors.map((c) => c.id);

/** Each op returns a label, or null when it had no valid target and did
 *  nothing at all. */
const OPS: Record<string, (rnd: Rnd) => string | null> = {
  updateShape(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    const field = pick(rnd, ['x', 'y', 'w', 'h', 'fill', 'cornerRadius', 'rotation', 'label'] as const);
    const value =
      field === 'fill'
        ? pick(rnd, ['#ff0000', '#00ff00', '#0000ff', undefined])
        : field === 'label'
          ? pick(rnd, ['hi', 'there', undefined])
          : field === 'w' || field === 'h'
            ? 40 + int(rnd, 200)
            : int(rnd, 300);
    st().updateShape(id, { [field]: value } as Partial<Shape>);
    return `updateShape(${id}, ${field}=${String(value)})`;
  },
  updateSelection(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const sel = rnd() < 0.5 ? [pick(rnd, ids)] : [pick(rnd, ids), pick(rnd, ids)];
    st().setSelected(sel);
    const field = pick(rnd, ['fill', 'stroke', 'cornerRadius', 'opacity', 'strokeWidth'] as const);
    const value =
      field === 'fill' || field === 'stroke'
        ? pick(rnd, ['#ff0000', '#00ff00', undefined])
        : field === 'opacity'
          ? pick(rnd, [0.25, 0.5, 1, undefined])
          : pick(rnd, [1, 2, 4, undefined]);
    st().updateSelection({ [field]: value } as Partial<Shape>);
    return `updateSelection(${sel}, ${field}=${String(value)})`;
  },
  addShape(rnd) {
    const id = `n${++seq}`;
    st().addShape(rect(id, { x: int(rnd, 500), y: int(rnd, 500) }));
    return `addShape(${id})`;
  },
  deleteSelection(rnd) {
    const ids = [...plainIds(), ...groupIds(), ...connIds()];
    if (ids.length < 2) return null;
    const sel = [pick(rnd, ids)];
    st().setSelected(sel);
    st().deleteSelection();
    return `delete(${sel})`;
  },
  liveDrag(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setSelected(id);
    const base = st().diagram.shapes.find((s) => s.id === id)!.x;
    const frames = 1 + int(rnd, 5);
    for (let i = 1; i <= frames; i++) st().updateShapeLive(id, { x: base + i * 7 });
    st().commitHistory();
    return `liveDrag(${id}, ${frames} frames)`;
  },
  batch(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setSelected(id);
    st().beginHistoryBatch();
    const frames = 1 + int(rnd, 6);
    for (let i = 1; i <= frames; i++) st().updateSelection({ cornerRadius: i + int(rnd, 3) });
    st().endHistoryBatch();
    return `batch(${id}, ${frames} frames)`;
  },
  nudge(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setSelected(id);
    st().nudgeSelection(1, 0, 'fixed');
    st().nudgeSelection(1, 0, 'fixed');
    st().nudgeSelection(0, 1, 'fixed');
    return `nudge×3(${id})`;
  },
  addConnector(rnd) {
    const id = `c${++seq}`;
    st().addConnector(line(id, { x: int(rnd, 400), y: 400 }, { x: int(rnd, 400), y: 450 }));
    return `addConnector(${id})`;
  },
  updateConnector(rnd) {
    const ids = connIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    const value = pick(rnd, [1, 2, 3, undefined]);
    st().updateConnector(id, { strokeWidth: value });
    return `updateConnector(${id}, strokeWidth=${String(value)})`;
  },
  liveConnector(rnd) {
    const ids = connIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    for (let i = 1; i <= 3; i++) {
      st().updateConnectorLive(id, { to: { x: 100 + i * 20 + int(rnd, 5), y: 500 } });
    }
    st().commitHistory();
    return `liveConnector(${id})`;
  },
  paste(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const srcId = pick(rnd, ids);
    const src = st().diagram.shapes.find((s) => s.id === srcId)!;
    useEditor.setState({
      clipboard: { shapes: [structuredClone(src)], connectors: [] },
    });
    st().paste({ x: int(rnd, 400), y: int(rnd, 400) });
    return `paste(${src.id})`;
  },
  duplicate(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setSelected(id);
    st().duplicateSelection();
    return `duplicate(${id})`;
  },
  flip(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const sel = [pick(rnd, ids), pick(rnd, ids)];
    st().setSelected(sel);
    st().flipSelection(pick(rnd, ['horizontal', 'vertical'] as const));
    return `flip(${sel})`;
  },
  group(rnd) {
    const ids = plainIds().filter(
      (id) => !st().diagram.shapes.find((s) => s.id === id)!.parent,
    );
    if (ids.length < 2) return null;
    const a = pick(rnd, ids);
    const b = pick(rnd, ids.filter((x) => x !== a));
    st().setSelected([a, b]);
    st().groupSelection();
    return `group(${a},${b})`;
  },
  ungroup(rnd) {
    const ids = groupIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setSelected(id);
    st().ungroupSelection();
    return `ungroup(${id})`;
  },
  zorder(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setSelected(id);
    const op = pick(rnd, ['bringToFront', 'sendToBack', 'bringForward', 'sendBackward'] as const);
    st()[op]();
    return `${op}(${id})`;
  },
  setShapeBox(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    st().setShapeBox(id, { x: int(rnd, 300), y: int(rnd, 300), w: 50 + int(rnd, 100), h: 40 + int(rnd, 60) });
    return `setShapeBox(${id})`;
  },
  replaceFragment(rnd) {
    const ids = plainIds();
    if (!ids.length) return null;
    const id = pick(rnd, ids);
    const nid = `r${++seq}`;
    st().replaceFragment([id], [rect(nid, { x: int(rnd, 300), y: int(rnd, 300) })], []);
    return `replaceFragment(${id}→${nid})`;
  },
  setTitle(rnd) {
    const t = `t${int(rnd, 5)}`;
    st().setTitle(t);
    return `setTitle(${t})`;
  },
  undoRedoPair() {
    const before = snap();
    const past = st().past.length;
    st().undo();
    st().redo();
    assert.equal(snap(), before, 'undo+redo must be a no-op');
    assert.equal(st().past.length, past, 'undo+redo must leave the stack depth alone');
    return 'undo+redo';
  },
};

const OP_NAMES = Object.keys(OPS);

function run(seed: number, steps: number) {
  const rnd = mulberry32(seed);
  fresh();
  const states = [snap()];
  const log: string[] = [];
  const ctx = () => `seed ${seed}, step ${log.length}\n  ${log.join('\n  ')}`;
  // Mirror of the store's nudge coalescing: a burst that moves the SAME
  // ids as the previous burst, with nothing pushed to history in between
  // (same `past` array identity), extends that burst's entry instead of
  // opening a new one. Everything here runs well inside the 400ms window.
  let lastNudge: { id: string; past: unknown } | null = null;
  for (let i = 0; i < steps; i++) {
    const before = snap();
    const pastBefore = st().past.length;
    const pastArrBefore = st().past;
    const name = pick(rnd, OP_NAMES);
    const label = OPS[name](rnd);
    if (!label) continue;
    const nudgeId = label.startsWith('nudge×3(') ? label.slice(8, -1) : null;
    const coalesced =
      nudgeId !== null &&
      lastNudge !== null &&
      lastNudge.id === nudgeId &&
      lastNudge.past === pastArrBefore;
    if (nudgeId !== null) lastNudge = { id: nudgeId, past: st().past };
    const after = snap();
    if (after === before) {
      assert.equal(
        st().past.length,
        pastBefore,
        `${label} changed nothing but recorded an entry (${ctx()})`,
      );
      continue;
    }
    if (coalesced) {
      assert.equal(
        st().past.length,
        pastBefore,
        `${label} should have extended the previous nudge's entry (${ctx()})`,
      );
      states[states.length - 1] = after;
      log[log.length - 1] = `${label} (coalesced)`;
      continue;
    }
    assert.equal(
      st().past.length,
      Math.min(pastBefore + 1, LIMIT),
      `${label} must record exactly one entry (${ctx()})`,
    );
    assert.equal(st().future.length, 0, `a new edit must clear redo (${ctx()})`);
    states.push(after);
    log.push(label);
  }
  // Walk all the way back (the stack keeps the newest LIMIT entries)…
  const undoable = Math.min(states.length - 1, LIMIT);
  const last = states.length - 1;
  for (let j = 1; j <= undoable; j++) {
    st().undo();
    assert.equal(snap(), states[last - j], `undo #${j} landed on the wrong state (${ctx()})`);
  }
  assert.equal(st().past.length, 0, `stack should be empty after undoing everything (${ctx()})`);
  const floor = snap();
  st().undo(); // one more must be a harmless no-op
  assert.equal(snap(), floor);
  // …and all the way forward.
  for (let j = undoable - 1; j >= 0; j--) {
    st().redo();
    assert.equal(snap(), states[last - j], `redo landed on the wrong state (${ctx()})`);
  }
  assert.equal(st().future.length, 0, `redo stack should be empty after redoing everything (${ctx()})`);
  st().redo();
  assert.equal(snap(), states[last]);
  return states.length - 1;
}

/** Mirrors HISTORY_LIMIT in src/store/editor.ts: past that many entries the
 *  oldest is dropped, so a long sequence can only be unwound that far. */
const LIMIT = 100;

// Defaults keep `npm test` fast; `FUZZ_SEEDS=500 FUZZ_STEPS=150 npm test`
// runs a much deeper sweep when the seam changes.
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 60);
const STEPS = Number(process.env.FUZZ_STEPS ?? 80);

test('random operation sequences undo and redo exactly, one entry per change', () => {
  let total = 0;
  for (let seed = 1; seed <= SEEDS; seed++) total += run(seed, STEPS);
  assert.ok(
    total > SEEDS * STEPS * 0.4,
    `expected a meaningful number of recorded edits, got ${total}`,
  );
});
