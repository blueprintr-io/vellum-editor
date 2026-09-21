/* The `graph:` section - a diagrams-as-code projection of the connectors.
 *
 * Serialized `.vellum` files lead with a terse edge list so "X talks to Y"
 * is readable (and editable) without decoding the detail arrays:
 *
 *   graph:
 *     - CloudFront -> API Gateway: HTTPS
 *     - API Gateway -> Cognito: verify
 *     - render-worker -- Redis cache?
 *
 * Grammar, one edge per entry:
 *
 *   <node> -> <node>     directed (to-side arrowhead)
 *   <node> -- <node>     bare line, no arrowheads
 *   <node> <-> <node>    double-headed
 *   <node> <- <node>     accepted on input, normalised to a reversed ->
 *
 * A labelled edge is emitted as a single-pair YAML map (`a -> b: label`),
 * which is exactly what a human typing `- a -> b: label` produces - no
 * quoting needed. An unlabelled edge is a plain string entry.
 *
 * Node references are a shape's readable NAME: its label, else the first line
 * of its body (the common body-bearing kinds store typed text in `body`, not
 * `label`), else its id. Names are made globally unique with a deterministic
 * `#<id-slice>` suffix on collisions (see buildNameMap), so two shapes called
 * "Worker" read as `Worker #a1b2` / `Worker #c3d4` rather than falling back to
 * opaque ids. Resolution on load runs the SAME buildNameMap, tries id first,
 * then exact name; a bare name matching several shapes raises a helpful
 * ambiguity error. A reference that resolves to nothing CREATES a new shape
 * next to its neighbour - so a whole diagram can be typed from scratch as a
 * graph section and nothing else.
 *
 * PROJECTION, NOT STATE: the section is derived from `connectors` at save
 * time and reconciled back at load time (see applyGraphSection). It is
 * stripped by the schema parser and never is in the Zustand store, so
 * the "in-memory state === serialised state" rule keeps a single source of
 * truth - the file just carries one derived, editable view on top.
 *
 * STALENESS GUARD: alongside `graph` we write `graphHash`, a digest of the
 * connector topology the section was derived from. If a file's connectors
 * are edited by a tool that doesn't regenerate the section (an older
 * Vellum round-tripping unknown keys through looseObject), the digest no
 * longer matches and the stale graph is IGNORED rather than allowed to
 * resurrect deleted connectors or delete new ones. Precedence, spelled
 * out:
 *   - hash present + matches   → graph is authoritative (full sync:
 *                                 create, relabel, and DELETE connectors)
 *   - hash present + mismatch  → connectors are fresher; graph ignored
 *   - hash absent              → hand-authored file; additive merge only
 *                                 (create, never delete)
 * If both sections were hand-edited in conflicting ways in one sitting,
 * the detail section wins - we never guess our way into deleting data. */

import type {
  Connector,
  ConnectorEndpoint,
  DiagramState,
  EndpointMarker,
  Shape,
} from './types';

type Glyph = '->' | '--' | '<->';

/** One parsed graph entry. Refs are raw (unresolved) node references. */
type GraphEdge = {
  fromRef: string;
  toRef: string;
  glyph: Glyph;
  label?: string;
};

/** Serialized entry shape: plain string when unlabelled, single-pair map
 *  (`{'a -> b': 'label'}`) when labelled - the map form is what YAML
 *  naturally parses `- a -> b: label` into, so hand-typing needs no quotes. */
export type GraphEntry = string | Record<string, string>;

const bound = (e: ConnectorEndpoint): e is { shape: string; anchor: never } =>
  typeof e === 'object' && e !== null && 'shape' in e;

const arrowish = (m: EndpointMarker) => m === 'arrow' || m === 'triangle' || m === 'hollow-triangle';

/** Collapse a connector's marker config to a display glyph, mirroring the
 *  renderer's defaults (Connector.tsx: `fromMarker ?? 'none'`,
 *  `toMarker ?? 'arrow'`) so the glyph matches what the canvas shows.
 *  Deliberately lossy: exotic marker mixes (dot→diamond, from-side-only
 *  arrow) collapse to `--`; the detail record keeps the truth.
 *  Reconciliation only rewrites markers when the user CHANGES the glyph,
 *  so a lossy glyph that round-trips unedited never touches the connector. */
function deriveGlyph(c: Connector): Glyph {
  const from = c.fromMarker ?? 'none';
  const to = c.toMarker ?? 'arrow';
  if (c.bidirectional || (arrowish(from) && arrowish(to))) return '<->';
  if (arrowish(to) && !arrowish(from)) return '->';
  return '--';
}

/** An edited glyph is an explicit instruction - overwrite both markers.
 *  (`bidirectional` is cleared too: the glyph axis subsumes it.) Note the
 *  renderer defaults a MISSING toMarker to 'arrow', so `--` must write
 *  `toMarker: 'none'` explicitly rather than deleting the field. */
function applyGlyph(c: Connector, glyph: Glyph) {
  delete c.bidirectional;
  if (glyph === '<->') {
    c.fromMarker = 'arrow';
    c.toMarker = 'arrow';
  } else if (glyph === '->') {
    delete c.fromMarker;
    c.toMarker = 'arrow';
  } else {
    delete c.fromMarker;
    c.toMarker = 'none';
  }
}

// ref naming
//
// Every shape gets ONE readable, globally-unique "graph name" - the token that
// appears in an edge line. The chain is: label → first line of body → id.
// Body matters because the common body-bearing kinds (rect / ellipse / diamond
// / polygon / note / service) store typed text in `body`, not `label` (see
// InlineLabelEditor's writesToBody), so without this a hand-drawn diagram would
// be almost all opaque ids.
//
// Uniqueness is enforced by `buildNameMap` with a deterministic `#<id-slice>`
// suffix on collisions - never a positional counter, which wouldn't survive a
// reorder and would churn the file / mis-resolve on load. Because emit AND
// load call the SAME buildNameMap over the SAME shapes array, every emitted
// name resolves back to exactly the shape it came from.

/** Longest a body-derived name may get before truncation (label refs are used
 *  whole - they're intentional short headings). */
const MAX_BODY_NAME = 40;

/** True when a ref can appear UNQUOTED in an edge line: no colon (the label
 *  separator), no newline, no double-quote, no op token, and no leading /
 *  trailing space. Internal spaces are fine - "API Gateway" is a valid bare
 *  ref because the op is always space-delimited. */
function refSyntaxSafe(ref: string): boolean {
  if (!ref) return false;
  if (/[:\n"]/.test(ref)) return false;
  if (/->|<-|--/.test(ref)) return false;
  if (ref !== ref.trim()) return false;
  return true;
}

/** Double-quote (with backslash-escaping) a ref the bare grammar can't carry.
 *  Mirrors readQuoted's un-escaping so the round-trip is exact. */
function quoteRef(ref: string): string {
  return `"${ref.replace(/[\\"]/g, '\\$&')}"`;
}

/** Emit a ref: bare when the grammar can carry it, quoted otherwise. */
function emitRef(name: string): string {
  return refSyntaxSafe(name) ? name : quoteRef(name);
}

/** The shape's UNSUFFIXED, unquoted logical name: label, else the first line
 *  of body (whitespace-collapsed, truncated), else the id. Deterministic given
 *  the shape alone - the shared basis for both emission and resolution. */
function baseNameFor(s: Shape): string {
  const label = s.label?.trim();
  if (label) return label;
  const body = s.body;
  if (body) {
    const firstLine = body.split('\n')[0].replace(/\s+/g, ' ').trim();
    if (firstLine) {
      return firstLine.length > MAX_BODY_NAME
        ? `${firstLine.slice(0, MAX_BODY_NAME - 1)}…`
        : firstLine;
    }
  }
  return s.id;
}

/** Last `len` chars of the id - the entropy of a `kind-<hex>` id is at the
 *  end. Falls back to the id when it's shorter than `len`. */
function idSlice(id: string, len: number): string {
  return id.length <= len ? id : id.slice(-len);
}

/** Assign every shape a unique graph name. A base name is used bare when it's
 *  unique AND doesn't shadow a DIFFERENT shape's id (ids resolve first, so a
 *  base equal to another shape's id must be suffixed or it would resolve to
 *  the wrong shape). Colliders get the shortest ` #<id-slice>` that makes the
 *  final name unique. Returns shapeId → logical (unquoted) name. */
export function buildNameMap(shapes: Shape[]): Map<string, string> {
  const base = new Map<string, string>();
  const baseCount = new Map<string, number>();
  const idSet = new Set(shapes.map((s) => s.id));
  for (const s of shapes) {
    const b = baseNameFor(s);
    base.set(s.id, b);
    baseCount.set(b, (baseCount.get(b) ?? 0) + 1);
  }

  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const s of shapes) {
    const b = base.get(s.id)!;
    // A base that IS this shape's own id is inherently unique - keep it.
    const shadowsOtherId = b !== s.id && idSet.has(b);
    // `used.has(b)` matters: a shape whose base is LITERALLY a name an earlier
    // shape was already handed (e.g. a user label "Worker #1a2b" that equals
    // another "Worker"'s auto-suffix) must be disambiguated too - otherwise
    // two shapes emit the same name and a round-trip mis-resolves / deletes a
    // connector.
    const collides =
      (baseCount.get(b) ?? 0) > 1 || shadowsOtherId || used.has(b);
    if (!collides) {
      out.set(s.id, b);
      used.add(b);
      continue;
    }
    let name = b;
    for (const len of [4, 6, 8, s.id.length]) {
      name = `${b} #${idSlice(s.id, len)}`;
      if (!used.has(name)) break;
    }
    // Absolute guarantee: every id-slice candidate can still be taken (short
    // ids collapse all four to the same string, or an adversarial label
    // already claimed the full-id form). Append a deterministic counter until
    // unique - order-deterministic, so emit and load agree.
    if (used.has(name)) {
      const stem = name;
      for (let n = 2; used.has(name); n++) name = `${stem} (${n})`;
    }
    out.set(s.id, name);
    used.add(name);
  }
  return out;
}

// parsing

/** Ops, longest first so `<->` wins over `<-` at the same index. Spaces are
 *  part of the token - `e2e--test` inside a label is not an op. Used only to
 *  locate the op after an UNQUOTED from-ref; quoted refs are consumed as
 *  whole tokens first so an op inside a quoted ref never mis-splits. */
const OP_RE = / (<->|<-|->|--) /;
const OP_AFTER_QUOTE_RE = /^\s*(<->|<-|->|--)\s*/;

/** Read a double-quoted token whose opening quote is at `s[start]`. Handles
 *  `\"` and `\\` escapes. Returns the unescaped value and the index just
 *  past the closing quote. Throws on an unterminated quote. */
function readQuoted(s: string, start: number): { value: string; end: number } {
  let out = '';
  let i = start + 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"') return { value: out, end: i + 1 };
    out += ch;
    i += 1;
  }
  throw new Error(`Invalid graph entry (unterminated quote): ${s}`);
}

function parseGraphEntry(entry: unknown): GraphEdge {
  let key: string;
  let mapLabel: string | undefined;
  if (typeof entry === 'string') {
    key = entry;
  } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const pairs = Object.entries(entry as Record<string, unknown>);
    if (pairs.length !== 1) {
      throw new Error(
        `Invalid graph entry: ${JSON.stringify(entry)} - one edge per line`,
      );
    }
    key = pairs[0][0];
    const v = pairs[0][1];
    // A nested map / list value means the label line was mis-indented (YAML
    // read the "label" as a child mapping). Reject it rather than coercing
    // to the string "[object Object]".
    if (v !== null && typeof v === 'object') {
      throw new Error(
        `Invalid graph entry: ${JSON.stringify(entry)} - the label must be a scalar ("a -> b: label"); check its indentation`,
      );
    }
    mapLabel = v == null ? undefined : String(v);
  } else {
    throw new Error(
      `Invalid graph entry: ${JSON.stringify(entry)} - expected "<node> -> <node>: label"`,
    );
  }
  const hasMapLabel = mapLabel !== undefined;

  // Tokenise the key as `<from> <op> <to>[: label]`. A quoted ref is consumed
  // as a whole token FIRST so an op or colon inside it never mis-splits.
  let i = 0;
  while (i < key.length && key[i] === ' ') i++;

  let fromRef: string;
  let op: string;
  if (key[i] === '"') {
    const q = readQuoted(key, i);
    fromRef = q.value;
    const om = OP_AFTER_QUOTE_RE.exec(key.slice(q.end));
    if (!om) {
      throw new Error(
        `Invalid graph entry: ${key} - expected an operator (->, --, <->) after the quoted reference`,
      );
    }
    op = om[1];
    i = q.end + om[0].length;
  } else {
    const m = OP_RE.exec(key.slice(i));
    if (!m) {
      throw new Error(
        `Invalid graph entry: ${key} - expected "<node> -> <node>" (also: --, <->, <-)`,
      );
    }
    fromRef = key.slice(i, i + m.index).trim();
    if (!fromRef) {
      throw new Error(
        `Invalid graph entry (missing node reference): ${key} - expected "<node> -> <node>: label"`,
      );
    }
    op = m[1];
    i = i + m.index + m[0].length;
  }

  while (i < key.length && key[i] === ' ') i++;
  let toRef: string;
  let inlineLabel: string | undefined;
  if (key[i] === '"') {
    const q = readQuoted(key, i);
    toRef = q.value;
    const trailing = key.slice(q.end);
    const lm = /^\s*:\s*(.*)$/.exec(trailing);
    if (lm) {
      inlineLabel = lm[1].trim() || undefined;
    } else if (trailing.trim() !== '') {
      throw new Error(
        `Invalid graph entry (unexpected text after quoted reference): ${key}`,
      );
    }
  } else {
    let rest = key.slice(i);
    // Inline label only for a string entry (a map entry carries its label as
    // the map value). Split at the first colon.
    if (!hasMapLabel) {
      const colon = rest.indexOf(':');
      if (colon !== -1) {
        inlineLabel = rest.slice(colon + 1).trim() || undefined;
        rest = rest.slice(0, colon);
      }
    }
    toRef = rest.trim();
    if (!toRef) {
      throw new Error(
        `Invalid graph entry (missing node reference): ${key} - expected "<node> -> <node>: label"`,
      );
    }
  }

  let label = hasMapLabel ? mapLabel : inlineLabel;
  if (label === '') label = undefined;

  let glyph: Glyph;
  if (op === '<-') {
    [fromRef, toRef] = [toRef, fromRef];
    glyph = '->';
  } else {
    glyph = op as Glyph;
  }
  return { fromRef, toRef, glyph, label };
}

// digest

/** FNV-1a over a string. Cheap, deterministic, dependency-free - the graph
 *  hash is a staleness tripwire, not a security boundary. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Connectors the graph section can express: both endpoints bound to shapes
 *  that actually exist. Free-floating and dangling connectors stay in the
 *  detail section only, and reconciliation never touches them. */
function eligibleConnectors(d: DiagramState): Connector[] {
  const ids = new Set(d.shapes.map((s) => s.id));
  return d.connectors.filter(
    (c) =>
      bound(c.from) && bound(c.to) && ids.has(c.from.shape) && ids.has(c.to.shape),
  );
}

/** Digest of the EMITTED section (not a parallel id-based summary). Tying
 *  the hash to exactly what buildGraphSection produces means the tripwire
 *  fires whenever anything the section depends on changes - endpoints,
 *  connector labels, glyphs, OR a shape label used as a ref. An id-based
 *  digest missed that last case: an old editor could rename a shape label
 *  (which changes the section refs) without touching connector topology,
 *  leaving a matching hash that let the stale graph delete actual connectors.
 *  The `S`/`M` tag plus a NUL field-separator and newline join keep an
 *  unlabelled string entry from colliding with a labelled map entry and
 *  keep entries from merging across the join. */
export function graphDigestForEntries(entries: GraphEntry[]): string {
  const norm = entries.map((e) =>
    typeof e === 'string'
      ? `S\0${e}`
      : `M\0${Object.keys(e)[0]}\0${Object.values(e)[0]}`,
  );
  return fnv1a(norm.sort().join('\n'));
}

export function graphDigest(d: DiagramState): string {
  return graphDigestForEntries(buildGraphSection(d));
}

// emission

export function buildGraphSection(d: DiagramState): GraphEntry[] {
  const names = buildNameMap(d.shapes);
  return eligibleConnectors(d).map((c) => {
    const fromId = (c.from as { shape: string }).shape;
    const toId = (c.to as { shape: string }).shape;
    const key = `${emitRef(names.get(fromId)!)} ${deriveGlyph(c)} ${emitRef(names.get(toId)!)}`;
    return c.label ? { [key]: c.label } : key;
  });
}

// reconciliation

const CREATED_W = 140;
const CREATED_H = 64;
const CREATED_GAP_X = 120;
const CREATED_GAP_Y = 88;

function slugify(ref: string): string {
  const slug = ref
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'node';
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Reconcile a raw `graph:` section into the parsed diagram. Mutates `d`
 *  (shapes may be created; eligible connectors created / relabelled /
 *  deleted). No-op for legacy files with no graph key. Throws with a
 *  human-readable message on malformed entries or ambiguous refs - the
 *  YAML dialog surfaces that message verbatim. */
export function applyGraphSection(
  d: DiagramState,
  rawGraph: unknown,
  rawHash: unknown,
): void {
  if (rawGraph === undefined || rawGraph === null) return;
  if (!Array.isArray(rawGraph)) {
    throw new Error('graph: must be a list of edge lines ("a -> b: label")');
  }
  const edges = rawGraph.map(parseGraphEntry);

  const storedHash = typeof rawHash === 'string' ? rawHash : undefined;
  if (storedHash !== undefined && storedHash !== graphDigest(d)) {
    console.warn(
      '[vellum] graph section is stale (connectors were edited without regenerating it) - ignoring graph edits for this load',
    );
    return;
  }
  // No hash → hand-authored section: create freely, but never delete.
  const fullSync = storedHash !== undefined;

  const byId = new Map(d.shapes.map((s) => [s.id, s]));
  // Shared name map: the exact readable names the emitter would produce for
  // THESE shapes. Emit and load both run buildNameMap over the same shapes, so
  // every emitted ref (including `#id-slice` disambiguators) resolves back to
  // the shape it came from. `byName` is unique by construction. `byBase`
  // groups shapes sharing an unsuffixed base name - used only to give a
  // hand-author a helpful "ambiguous, did you mean…" error for a bare name.
  const nameMap = buildNameMap(d.shapes);
  const byName = new Map<string, Shape>();
  for (const s of d.shapes) byName.set(nameMap.get(s.id)!, s);
  const byBase = new Map<string, Shape[]>();
  for (const s of d.shapes) {
    const b = baseNameFor(s);
    const arr = byBase.get(b);
    if (arr) arr.push(s);
    else byBase.set(b, [s]);
  }

  let nextZ =
    Math.max(
      0,
      ...d.shapes.map((s) => s.z ?? 0),
      ...d.connectors.map((c) => c.z ?? 0),
    ) + 1;

  // Cascade counters so several shapes created off one neighbour stack
  // instead of piling onto the same spot.
  const placeCounters = new Map<string, number>();
  const bump = (key: string) => {
    const n = placeCounters.get(key) ?? 0;
    placeCounters.set(key, n + 1);
    return n;
  };
  const place = (neighbour: Shape | null, side: 'after' | 'before') => {
    if (neighbour) {
      const n = bump(`${side}:${neighbour.id}`);
      return {
        x:
          side === 'after'
            ? neighbour.x + neighbour.w + CREATED_GAP_X
            : neighbour.x - CREATED_GAP_X - CREATED_W,
        y: neighbour.y + n * CREATED_GAP_Y,
      };
    }
    const n = bump('free');
    if (d.shapes.length === 0) return { x: 120, y: 120 + n * CREATED_GAP_Y };
    const minX = Math.min(...d.shapes.map((s) => s.x));
    const maxY = Math.max(...d.shapes.map((s) => s.y + s.h));
    return { x: minX, y: maxY + 96 + n * CREATED_GAP_Y };
  };

  const resolve = (ref: string): Shape | null => {
    // Ids resolve first (ground truth), then exact readable names.
    const byIdHit = byId.get(ref);
    if (byIdHit) return byIdHit;
    const byNameHit = byName.get(ref);
    if (byNameHit) return byNameHit;
    // A hand-authored BARE name that maps to several shapes: the emitter would
    // have disambiguated these, so tell the author which forms to use.
    const group = byBase.get(ref);
    if (group && group.length > 1) {
      throw new Error(
        `Graph reference "${ref}" is ambiguous - ${group.length} shapes share that name. ` +
          `Use one of: ${group.map((s) => nameMap.get(s.id)).join(', ')} (or a shape id).`,
      );
    }
    return null;
  };

  const createShape = (ref: string, neighbour: Shape | null, side: 'after' | 'before') => {
    const id = uniqueId(slugify(ref), new Set(byId.keys()));
    const pos = place(neighbour, side);
    const shape: Shape = {
      id,
      kind: 'rect',
      x: pos.x,
      y: pos.y,
      w: CREATED_W,
      h: CREATED_H,
      label: ref,
      layer: 'blueprint',
      z: nextZ++,
    };
    d.shapes.push(shape);
    byId.set(id, shape);
    // Register the new node under its ref so a later line reusing the same
    // ref binds to this shape instead of creating a duplicate.
    byName.set(ref, shape);
    return shape;
  };

  // Resolve refs in entry order, creating missing nodes as we go so a
  // later line can reference a node an earlier line introduced.
  const resolved = edges.map((e) => {
    let from = resolve(e.fromRef);
    let to = resolve(e.toRef);
    if (!from) from = createShape(e.fromRef, to, 'before');
    if (!to) to = e.toRef === e.fromRef ? from : createShape(e.toRef, from, 'after');
    return { edge: e, from, to };
  });

  // Match graph lines to existing connectors. Pass 1 is exact (endpoints +
  // label) so parallel edges pair up stably; pass 2 relaxes the label so a
  // line whose label was edited relabels its connector instead of
  // delete+recreate (which would lose waypoints, colours, routing).
  const pool = new Set(eligibleConnectors(d));
  const matched = new Map<(typeof resolved)[number], Connector>();
  for (const r of resolved) {
    for (const c of pool) {
      if (
        (c.from as { shape: string }).shape === r.from.id &&
        (c.to as { shape: string }).shape === r.to.id &&
        (c.label ?? '') === (r.edge.label ?? '')
      ) {
        matched.set(r, c);
        pool.delete(c);
        break;
      }
    }
  }
  for (const r of resolved) {
    if (matched.has(r)) continue;
    for (const c of pool) {
      if (
        (c.from as { shape: string }).shape === r.from.id &&
        (c.to as { shape: string }).shape === r.to.id
      ) {
        if (r.edge.label !== undefined) c.label = r.edge.label;
        else delete c.label;
        matched.set(r, c);
        pool.delete(c);
        break;
      }
    }
  }

  const connectorIds = new Set(d.connectors.map((c) => c.id));
  for (const r of resolved) {
    const existing = matched.get(r);
    if (existing) {
      if (deriveGlyph(existing) !== r.edge.glyph) applyGlyph(existing, r.edge.glyph);
      continue;
    }
    const id = uniqueId(`c-${r.from.id}-${r.to.id}`, connectorIds);
    connectorIds.add(id);
    const c: Connector = {
      id,
      from: { shape: r.from.id, anchor: 'auto' },
      to: { shape: r.to.id, anchor: 'auto' },
      routing: 'straight',
      layer: 'blueprint',
      z: nextZ++,
    };
    applyGlyph(c, r.edge.glyph);
    if (r.edge.label !== undefined) c.label = r.edge.label;
    d.connectors.push(c);
  }

  // Full sync: a shape-to-shape connector with no graph line was deleted
  // in the graph section - honour that. (Never reached for merge mode or
  // for free/dangling connectors, which aren't in the pool at all.)
  if (fullSync && pool.size > 0) {
    d.connectors = d.connectors.filter((c) => !pool.has(c));
  }
}
