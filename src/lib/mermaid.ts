/* Mermaid importer.
 *
 * Takes the text of a `.mmd` / `.mermaid` file (or a fenced ```mermaid block
 * pasted as plain text) and returns a Vellum `DiagramState`. Like the
 * other importers, it is a focused parser, lossy on purpose, no library dep - Vellum
 * stays small, and we only need the structure (nodes + edges + labels), not
 * Mermaid's full rendering surface.
 *
 * Supported diagram types:
 *   - flowchart / graph (TD | TB | BT | LR | RL)
 *   - stateDiagram / stateDiagram-v2 (treated as a flowchart subset)
 *
 * Other diagram types (sequenceDiagram, classDiagram, erDiagram, gantt,
 * pie, journey, mindmap, ...) throw with a friendly message - they don't
 * map cleanly onto Vellum's shape/connector model and the AI-powered
 * Blueprintr importer is the right place for those.
 *
 * Layout: Mermaid relies on dagre/elk to position nodes. We don't ship a
 * layout engine, so we compute a simple layered layout from the graph's
 * structure (BFS rank from in-degree-0 roots, evenly distribute within each
 * rank). It's not as pretty as Mermaid's renderer but it's deterministic,
 * dependency-free, and gives the user a starting point they can tidy by
 * dragging in the editor, the same contract as Vellum's other importers.
 */

import * as dagre from '@dagrejs/dagre';
import type { Anchor, Connector, DiagramState, Shape } from '@/store/types';
import { htmlLabelToPlainText } from '@/lib/importer-utils';

type Direction = 'TD' | 'BT' | 'LR' | 'RL';

type ParsedNode = {
  /** Mermaid id as it appears in the source (e.g. "A", "node1"). */
  id: string;
  label: string;
  /** Vellum kind chosen from Mermaid's shape syntax (`[..]`, `{..}`, `((..))`). */
  kind: Shape['kind'];
  /** Set when the node was declared inside a `subgraph ... end` block. The
   *  string is the subgraph's id (its declared name) - resolved to a Vellum
   *  container shape after layout. Nested subgraphs use the closest enclosing
   *  one; we don't currently track grandparent chains. */
  subgraph?: string;
  /** Mermaid's rounded-rect shape (`(...)`) - drives Vellum's cornerRadius. */
  rounded?: boolean;
  /** `:::className` suffix from Mermaid's per-node class hint syntax
   *  (e.g. `Po1[Po1]:::edgeLabel`). The transit-node elision pass uses
   *  this as a strong signal that the user intends this node to render as
   *  a small inline badge rather than a full shape. */
  className?: string;
};

type ParsedEdge = {
  from: string;
  to: string;
  label?: string;
  style: 'solid' | 'dashed' | 'dotted';
  thick?: boolean;
  /** Whether the FROM end carries an arrow (Mermaid's `<-->`). */
  fromArrow: boolean;
  toArrow: boolean;
};

type ParsedSubgraph = {
  id: string;
  title: string;
  /** Parent subgraph id when nested (`subgraph A ... subgraph B ... end ... end`).
   *  dagre's compound mode honours nesting via setParent - without this,
   *  a nested cluster gets sibling-laid-out and visibly overflows its
   *  enclosing frame. */
  parent?: string;
  /** Direction override (subgraphs may have their own `direction LR` line).
   *  Currently ignored by the layout pass - the diagram-level direction
   *  wins - but parsed so a future revision can honour it. */
  direction?: Direction;
};

/** Style props carried by Mermaid `classDef` / inline `style` directives.
 *  Mapped 1:1 onto Vellum Shape fields at assembly time. We only honour
 *  the four properties that translate cleanly to flat shapes - colour,
 *  outline, line weight, label text colour. Mermaid's other CSS-style
 *  knobs (font, opacity, etc.) are ignored to keep the rendered output
 *  stable; users can dial those in the editor's inspector. */
type NodeStyle = {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  textColor?: string;
};

/** Parse a Mermaid source string into a Vellum `DiagramState`. Throws on
 *  unsupported diagram kinds or a payload with no recognisable nodes/edges. */
export function mermaidToDiagram(text: string): DiagramState {
  const stripped = stripFences(text).trim();
  if (!stripped) throw new Error('Mermaid source is empty.');

  const lines = stripped.split(/\r?\n/);
  const header = findHeader(lines);
  if (!header) {
    throw new Error(
      'Could not find a Mermaid diagram header (expected `flowchart`, `graph`, or `stateDiagram`).',
    );
  }

  const direction: Direction = header.direction;
  const body = lines.slice(header.lineIndex + 1);

  const nodes = new Map<string, ParsedNode>();
  const edges: ParsedEdge[] = [];
  const subgraphs = new Map<string, ParsedSubgraph>();
  // Stack of open subgraphs. We push on `subgraph X`, pop on `end`. Top of
  // stack is the active container that nodes get assigned to.
  const subgraphStack: string[] = [];

  // Style registries. classDefs hold the named class → props mapping;
  // assignments record each node's class (from `class id1,id2 name`
  // directives, complementing the inline `:::name` suffix on individual
  // nodes); inlineStyles hold per-node `style id ...` overrides.
  const classDefs = new Map<string, NodeStyle>();
  const classAssignments = new Map<string, string>();
  const inlineStyles = new Map<string, NodeStyle>();

  for (const raw of body) {
    const line = stripComment(raw).trim().replace(/;\s*$/, '');
    if (!line) continue;

    // Subgraph open: `subgraph id [Title]` or `subgraph "Title"` or `subgraph id`.
    const sgOpen = matchSubgraphOpen(line);
    if (sgOpen) {
      subgraphs.set(sgOpen.id, {
        id: sgOpen.id,
        title: sgOpen.title ?? sgOpen.id,
        parent: subgraphStack[subgraphStack.length - 1],
      });
      subgraphStack.push(sgOpen.id);
      continue;
    }
    if (line === 'end') {
      subgraphStack.pop();
      continue;
    }
    // Subgraph-local direction. Captured but not used by the layout pass.
    const dirMatch = line.match(/^direction\s+(TB|TD|BT|LR|RL)\s*$/);
    if (dirMatch && subgraphStack.length > 0) {
      const sg = subgraphs.get(subgraphStack[subgraphStack.length - 1]);
      if (sg) sg.direction = dirMatch[1] === 'TB' ? 'TD' : (dirMatch[1] as Direction);
      continue;
    }

    // `classDef name fill:#XXX,stroke:#YYY,...` - register a named class.
    const cdMatch = line.match(/^classDef\s+(\S+)\s+(.+)$/);
    if (cdMatch) {
      classDefs.set(cdMatch[1], parseStyleDecls(cdMatch[2]));
      continue;
    }
    // `class id1,id2,id3 className` - assign a class to one or more nodes.
    // Repeat directives accumulate; the last one for a given id wins.
    const classMatch = line.match(/^class\s+(\S+)\s+(\S+)$/);
    if (classMatch) {
      const ids = classMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
      for (const id of ids) classAssignments.set(id, classMatch[2]);
      continue;
    }
    // `style id fill:#XXX,...` - per-node inline override (wins over class).
    const styleMatch = line.match(/^style\s+(\S+)\s+(.+)$/);
    if (styleMatch) {
      inlineStyles.set(styleMatch[1], parseStyleDecls(styleMatch[2]));
      continue;
    }
    // Drop other directives we don't model so we never reject a valid file.
    if (
      /^(linkStyle|click|%%\{|%%init)/.test(line) ||
      line.startsWith('%%')
    ) {
      continue;
    }

    // Edge OR node. Try edge first because edges are line-shaped (an edge
    // line carries embedded node syntax for both endpoints).
    const edgeBatch = parseEdgeLine(line, nodes, subgraphStack);
    if (edgeBatch) {
      edges.push(...edgeBatch);
      continue;
    }
    // Bare node decl: `A[Label]` on its own line. Mermaid allows this too.
    const single = parseSingleNode(line);
    if (single) {
      upsertNode(nodes, single, subgraphStack);
      continue;
    }
// Ignore unrecognised tokens. Mermaid's grammar is permissive and we
    // don't want to fail the import on a stray directive.
  }

  if (nodes.size === 0 && edges.length === 0) {
    throw new Error('No Mermaid nodes or edges were recognised.');
  }

  // Lay out + emit Vellum shapes/connectors.
  return assembleDiagram(direction, nodes, edges, subgraphs, {
    classDefs,
    classAssignments,
    inlineStyles,
  });
}

/** Parse `fill:#xxx,stroke:#yyy,stroke-width:2px,color:white` into a
 *  NodeStyle. Tolerant of stray whitespace and the `px` unit suffix
 *  Mermaid sometimes ships on stroke-width. Unknown keys are silently
 *  dropped so we don't break on stylesheet additions Mermaid may add
 *  later. */
function parseStyleDecls(decls: string): NodeStyle {
  const out: NodeStyle = {};
  for (const part of decls.split(',')) {
    const eq = part.indexOf(':');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (!v) continue;
    if (k === 'fill') out.fill = v;
    else if (k === 'stroke') out.stroke = v;
    else if (k === 'stroke-width') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) out.strokeWidth = n;
    } else if (k === 'color') out.textColor = v;
  }
  return out;
}

/** Strip surrounding ```mermaid ... ``` fences if the user pasted a markdown
 *  code block. Tolerant of ``` followed by any language tag, or no tag. */
function stripFences(text: string): string {
  const m = text.match(/^\s*```\s*(\w+)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  return m ? m[2] : text;
}

/** Find the first non-blank, non-comment line that looks like a diagram header.
 *  Returns the matched direction + the line index it sat on so the body parser
 *  can skip it. */
function findHeader(
  lines: string[],
): { direction: Direction; lineIndex: number } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    // Mermaid frontmatter (`---\n title: ... \n---`) wraps the diagram on
    // some toolchains; skip until we find the close.
    if (line === '---') {
      let j = i + 1;
      while (j < lines.length && stripComment(lines[j]).trim() !== '---') j++;
      i = j;
      continue;
    }
    const m = line.match(/^(flowchart|graph|stateDiagram-v2|stateDiagram)(?:\s+(TB|TD|BT|LR|RL))?/);
    if (m) {
      const dir = (m[2] ?? 'TD') as Direction | 'TB';
      return { direction: dir === 'TB' ? 'TD' : (dir as Direction), lineIndex: i };
    }
    // Anything else as the first content line means an unsupported diagram
    // kind. Make the error specific so the user knows why.
    const head = line.split(/\s/)[0];
    if (
      [
        'sequenceDiagram',
        'classDiagram',
        'classDiagram-v2',
        'erDiagram',
        'gantt',
        'pie',
        'journey',
        'mindmap',
        'timeline',
        'gitGraph',
        'requirementDiagram',
        'C4Context',
        'sankey-beta',
      ].includes(head)
    ) {
      throw new Error(
        `Mermaid '${head}' diagrams aren't supported in the basic importer - the AI importer in Blueprintr handles those.`,
      );
    }
    return null;
  }
  return null;
}

/** Strip a trailing `%% comment` from a Mermaid source line. Comments start
 *  with `%%` and run to end-of-line. We don't honour comments inside quoted
 *  labels because Mermaid itself doesn't either. */
function stripComment(line: string): string {
  const idx = line.indexOf('%%');
  return idx >= 0 ? line.slice(0, idx) : line;
}

/** Parse a `subgraph` opener. Mermaid is loose here:
 *    `subgraph foo [Title]` - explicit id + bracketed title
 *    `subgraph "Quoted Title"` - quoted title, id derived from title
 *    `subgraph foo` - id is also the title
 *    `subgraph Edge Network` - multi-word id-AND-title (the entire
 *                                    trailing string)
 *  The last form was missing previously and silently dropped every
 *  multi-word `subgraph` line, which made multi-cluster diagrams (the
 *  AWS architecture pattern) lose ALL their containers - visible bug. */
function matchSubgraphOpen(
  line: string,
): { id: string; title?: string } | null {
  // Quoted title - id derived from the title.
  let m = line.match(/^subgraph\s+"([^"]+)"\s*$/);
  if (m) return { id: m[1], title: htmlLabelToPlainText(m[1]) };
  // Bracketed title - explicit id + display title.
  m = line.match(/^subgraph\s+(\S+)\s*\[([^\]]+)\]\s*$/);
  if (m) return { id: m[1], title: htmlLabelToPlainText(m[2]) };
  // Bare line - capture everything after `subgraph ` as both id and
  // title. Whitespace in the id is sanitised so callers can compose it
  // into Vellum shape ids without blowing up YAML.
  m = line.match(/^subgraph\s+(.+?)\s*$/);
  if (m) {
    const text = m[1];
    return {
      id: text.replace(/\s+/g, '_'),
      title: htmlLabelToPlainText(text),
    };
  }
  return null;
}

/* ----------------------------------- nodes ---------------------------------- */

const SHAPE_TOKEN_RE =
  // Order matters - try LONGER bracket forms first so `[[...]]` doesn't get
  // chewed by the `[...]` rule. Each entry: { open, close, kind, rounded }.
  [
    { open: '((', close: '))', kind: 'ellipse' as const },
    { open: '[[', close: ']]', kind: 'rect' as const, rounded: false },
    { open: '[(', close: ')]', kind: 'rect' as const },
    { open: '[/', close: '/]', kind: 'rect' as const },
    { open: '[\\', close: '\\]', kind: 'rect' as const },
    { open: '{{', close: '}}', kind: 'diamond' as const },
    { open: '>',  close: ']',  kind: 'rect' as const },
    { open: '(',  close: ')',  kind: 'rect' as const, rounded: true },
    { open: '[',  close: ']',  kind: 'rect' as const },
    { open: '{',  close: '}',  kind: 'diamond' as const },
  ];

/** Parse a token that should be a single node declaration: `A[Label]`,
 *  `B((Round))`, `C{Diamond}`, or just `nodeId` (bare reference reuses an
 *  earlier shape). Returns null when the slice doesn't begin with an
 *  identifier. */
function parseNodeAt(
  src: string,
  start: number,
): { node: ParsedNode | null; bareId: string | null; end: number } | null {
  const idMatch = src.slice(start).match(/^([A-Za-z0-9_\-]+)/);
  if (!idMatch) return null;
  const id = idMatch[1];
  let cursor = start + id.length;
  if (cursor >= src.length || !isShapeOpen(src, cursor)) {
    // Bare reference - caller looks up the shape from the nodes map.
    return { node: null, bareId: id, end: cursor };
  }
  for (const tok of SHAPE_TOKEN_RE) {
    if (src.startsWith(tok.open, cursor)) {
      const labelStart = cursor + tok.open.length;
      const closeIdx = src.indexOf(tok.close, labelStart);
      if (closeIdx === -1) return null;
      const label = htmlLabelToPlainText(stripQuotes(src.slice(labelStart, closeIdx).trim()));
      let endIdx = closeIdx + tok.close.length;
      const cls = matchClassHint(src, endIdx);
      if (cls) endIdx += cls.length;
      return {
        node: {
          id,
          label,
          kind: tok.kind,
          rounded: 'rounded' in tok ? tok.rounded : undefined,
          className: cls?.name,
        },
        bareId: null,
        end: endIdx,
      };
    }
  }
  // Identifier followed by something that's not a known shape opener - treat
  // as a bare reference. We still consume an optional `:::className` so it
  // doesn't get tokenised as a stray identifier on the next pass.
  const cls = matchClassHint(src, cursor);
  return { node: null, bareId: id, end: cursor + (cls?.length ?? 0) };
}

/** Try to match Mermaid's per-node class hint (`:::className`) at the
 *  given position. Returns the matched name + total consumed length, or
 *  null when no hint is present. */
function matchClassHint(
  src: string,
  start: number,
): { name: string; length: number } | null {
  const m = src.slice(start).match(/^:::([A-Za-z_][\w-]*)/);
  return m ? { name: m[1], length: m[0].length } : null;
}

function isShapeOpen(src: string, idx: number): boolean {
  return SHAPE_TOKEN_RE.some((t) => src.startsWith(t.open, idx));
}

function parseSingleNode(line: string): ParsedNode | null {
  const r = parseNodeAt(line, 0);
  if (!r || r.end !== line.length) return null;
  return r.node;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

function upsertNode(
  nodes: Map<string, ParsedNode>,
  node: ParsedNode,
  subgraphStack: string[],
): void {
  const existing = nodes.get(node.id);
  if (existing) {
    // A later shape declaration overrides label/kind. Mermaid behaves the
    // same: `A[First]` then `A[Second]` keeps the second.
    if (node.label) existing.label = node.label;
    if (node.kind) existing.kind = node.kind;
    if (node.rounded !== undefined) existing.rounded = node.rounded;
    // If the re-declaration happens inside a subgraph and the node hasn't
    // been claimed by one yet, claim it now (matches Mermaid semantics).
    if (!existing.subgraph && subgraphStack.length > 0) {
      existing.subgraph = subgraphStack[subgraphStack.length - 1];
    }
  } else {
    nodes.set(node.id, {
      ...node,
      subgraph: subgraphStack[subgraphStack.length - 1],
    });
  }
}

/** Claim a bare-reference node id for the current subgraph. Used when an
 *  edge inside `subgraph X ... end` references a node by id alone (no
 *  shape syntax). Without this the container bbox would miss those nodes
 *  and they'd render outside the dashed frame. */
function adoptIntoSubgraph(
  nodes: Map<string, ParsedNode>,
  id: string,
  subgraphStack: string[],
): void {
  const sg = subgraphStack[subgraphStack.length - 1];
  const existing = nodes.get(id);
  if (existing) {
    if (!existing.subgraph) existing.subgraph = sg;
  } else {
    nodes.set(id, { id, label: id, kind: 'rect', subgraph: sg });
  }
}

/* ----------------------------------- edges ---------------------------------- */

/** Edge operator catalogue. Patterns are anchored - caller probes a slice
 *  starting at a candidate index. Order matters: longer / more specific
 *  patterns must come BEFORE shorter ones (e.g. `==>` before `==`).
 *
 *  Bidirectional `<-->` is captured in `bidi` so the resulting connector
 *  gets an arrow on the FROM end too. */
type EdgeOp = {
  re: RegExp;
  style: 'solid' | 'dashed';
  toArrow: boolean;
  thick?: boolean;
  bidi?: boolean;
};

const EDGE_OPS: EdgeOp[] = [
  { re: /^<-+\.+->/, style: 'dashed', toArrow: true, bidi: true },
  { re: /^<=+>/,     style: 'solid',  toArrow: true, thick: true, bidi: true },
  { re: /^<-+>/,     style: 'solid',  toArrow: true, bidi: true },
  { re: /^-+\.+->/,  style: 'dashed', toArrow: true },
  { re: /^=+>/,      style: 'solid',  toArrow: true, thick: true },
  { re: /^-+>/,      style: 'solid',  toArrow: true },
  { re: /^-+\.+-+/,  style: 'dashed', toArrow: false },
  { re: /^=+/,       style: 'solid',  toArrow: false, thick: true },
  { re: /^-{2,}/,    style: 'solid',  toArrow: false },
];

/** Try to match an edge operator at `src[start]`. Returns the matched
 *  operator definition + length on success, null on miss. */
function matchEdgeOp(
  src: string,
  start: number,
): { op: EdgeOp; length: number } | null {
  const slice = src.slice(start);
  for (const op of EDGE_OPS) {
    const m = slice.match(op.re);
    if (m) return { op, length: m[0].length };
  }
  return null;
}

/** Parse a flowchart edge line into one or more `ParsedEdge`s plus any
 *  inline node declarations. Returns null when the line doesn't contain an
 *  edge operator (caller treats it as a bare-node line). Returns [] for an
 *  edge line that we couldn't fully parse - better than throwing on every
 *  exotic edge syntax we haven't covered. */
function parseEdgeLine(
  line: string,
  nodes: Map<string, ParsedNode>,
  subgraphStack: string[],
): ParsedEdge[] | null {
  // Walk the line, accumulating "tokens" - each token is either a node
  // declaration/reference or an edge operator. A valid edge line is an
  // alternating sequence: NODE OP NODE (OP NODE)*.
  type Token =
    | { kind: 'node'; id: string; node: ParsedNode | null }
    | { kind: 'op'; op: EdgeOp; label?: string };

  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) {
      i++;
      continue;
    }
    const opMatch = matchEdgeOp(line, i);
    if (opMatch) {
      let after = i + opMatch.length;
      // `-->|label|` form: pipe-delimited label sits AFTER the operator.
      let label: string | undefined;
      // skip whitespace before pipe
      let probe = after;
      while (probe < line.length && /\s/.test(line[probe])) probe++;
      if (line[probe] === '|') {
        const close = line.indexOf('|', probe + 1);
        if (close > probe) {
          label = htmlLabelToPlainText(stripQuotes(line.slice(probe + 1, close).trim()));
          after = close + 1;
        }
      }
      tokens.push({ kind: 'op', op: opMatch.op, label });
      i = after;
      continue;
    }
    // Quoted mid-edge label: `A -- "Po1<br>OM4 Fibre" --> B`. Mermaid wraps
    // multi-word / HTML labels in quotes between two op halves; without
    // this branch the parser would treat the inner words as node ids and
    // create ghost rect nodes ("br", "OM4", "Fibre", ...).
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      if (close > i) {
        const inner = htmlLabelToPlainText(line.slice(i + 1, close));
        const prev = tokens[tokens.length - 1];
        if (prev && prev.kind === 'op' && prev.label === undefined) {
          prev.label = inner;
        }
        i = close + 1;
        continue;
      }
    }
    // `--text---` form: text sandwiched between two op halves. Detect by
    // checking whether the prior token was a half-op (style 'solid', no
    // arrow) and a follow-up op exists later on this line. Mermaid's
    // grammar for this is hairy - a heuristic that catches the common case
    // is good enough: take the next plain word(s) up to the next op, and
    // attach as a label to the previous op token.
    const r = parseNodeAt(line, i);
    if (!r) {
      i++;
      continue;
    }
    if (r.node) {
      upsertNode(nodes, r.node, subgraphStack);
      tokens.push({ kind: 'node', id: r.node.id, node: r.node });
    } else if (r.bareId) {
      // Bare reference. The `A -- X --> B` mid-edge-label form has a
      // HALF op (no arrow yet) preceding the bare token, then a CLOSING
      // op with the arrow after. Distinguish from a chain `A --> X -->
      // B` where the leading op already carried the arrow - in the
      // chain case X is an actual intermediate endpoint, not a label.
      const prev = tokens[tokens.length - 1];
      const lookahead = (() => {
        let j = r.end;
        while (j < line.length && /\s/.test(line[j])) j++;
        return matchEdgeOp(line, j);
      })();
      const prevIsHalfOp =
        prev && prev.kind === 'op' && !prev.op.toArrow && !prev.op.bidi;
      if (
        prevIsHalfOp &&
        prev.label === undefined &&
        lookahead
      ) {
        prev.label = htmlLabelToPlainText(r.bareId);
      } else {
        // Endpoint reference - and if we're inside a `subgraph ... end` block,
        // attribute the node to the current subgraph even when its shape was
        // declared earlier outside. Mermaid considers re-references inside
        // a subgraph as membership; we'd otherwise leave the container
        // bbox missing this node (visible bug: half a subgraph's contents
        // sitting outside its dashed frame).
        if (subgraphStack.length > 0) {
          adoptIntoSubgraph(nodes, r.bareId, subgraphStack);
        }
        tokens.push({ kind: 'node', id: r.bareId, node: null });
      }
    }
    i = r.end;
  }

  // Reduce alternating tokens to ParsedEdges. We must see at least one OP
  // and two surrounding NODE tokens; chained `A --> B --> C` is supported.
  // Multiple consecutive ops (the "open + close" halves around a mid-edge
  // label) are merged so the resulting edge picks up arrow info from the
  // close half AND the label that sat between them.
  const out: ParsedEdge[] = [];
  let lastNodeIdx = -1;
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.kind !== 'node') continue;
    if (lastNodeIdx >= 0) {
      // Collect every op token between the previous node and this one.
      const opSpan: { kind: 'op'; op: EdgeOp; label?: string }[] = [];
      for (let k = lastNodeIdx + 1; k < t; k++) {
        const tk = tokens[k];
        if (tk.kind === 'op') opSpan.push(tk);
      }
      if (opSpan.length > 0) {
        const merged = mergeOpSpan(opSpan);
        out.push({
          from: (tokens[lastNodeIdx] as { id: string }).id,
          to: tok.id,
          label: merged.label,
          style: merged.style,
          thick: merged.thick,
          fromArrow: !!merged.bidi,
          toArrow: merged.toArrow,
        });
      }
    }
    lastNodeIdx = t;
  }
  return out.length === 0 ? null : out;
}

/** Merge a span of op tokens between two nodes. The label comes from
 *  whichever half had one (typically the open half - `--label-->`); arrow,
 *  thickness, and style flags take the union so an unambiguous-looking
 *  edge ("arrow at the END of a thick dashed line") survives the round
 *  trip through the open/close half decomposition. */
function mergeOpSpan(
  span: { kind: 'op'; op: EdgeOp; label?: string }[],
): { style: 'solid' | 'dashed'; toArrow: boolean; thick: boolean; bidi: boolean; label: string | undefined } {
  let style: 'solid' | 'dashed' = 'solid';
  let toArrow = false;
  let thick = false;
  let bidi = false;
  let label: string | undefined;
  for (const t of span) {
    if (t.op.style === 'dashed') style = 'dashed';
    if (t.op.toArrow) toArrow = true;
    if (t.op.thick) thick = true;
    if (t.op.bidi) bidi = true;
    if (t.label && !label) label = t.label;
  }
  return { style, toArrow, thick, bidi, label };
}

/* --------------------------------- assembly --------------------------------- */

/** Per-node size floors. `computeNodeSize` grows beyond these for
 *  multi-line labels common in network / cloud diagrams. The maximum
 *  caps a single line at ~36 chars before the box stops widening - past
 *  that the renderer wraps. */
const NODE_MIN_W = 160;
const NODE_MIN_H = 64;
const NODE_MAX_W = 280;
/** Approximate label glyph metrics at the renderer's default 13px body. */
const CHAR_W = 7.2;
const LINE_H = 18;
const LABEL_PAD_X = 28;
const LABEL_PAD_Y = 24;
/** Padding from a dagre cluster's bounding box out to the rendered
 *  container frame. dagre already leaves space inside the cluster for
 *  its own children; this is the buffer between the dashed line and
 *  the cluster's title strip. */
const CONTAINER_PAD = 12;
/** dagre layout spacing - separation between sibling nodes within a
 *  rank (`nodesep`), between adjacent ranks (`ranksep`), and between
 *  parallel edges (`edgesep`). Tuned to read like mermaid.live's
 *  flowchart output: dense enough to fit a multi-cluster cloud
 *  architecture on screen without horizontal scrolling. */
const DAGRE_NODESEP = 36;
const DAGRE_RANKSEP = 56;
const DAGRE_EDGESEP = 12;
const DAGRE_MARGIN = 24;
/** Subtle fill on imported subgraph containers - gives clusters the
 *  shaded-cell look mermaid.live uses without picking a hard colour
 *  that fights either light or dark themes. The renderer composites
 *  this over the page background. */
const SUBGRAPH_FILL = 'rgba(127, 127, 127, 0.08)';

/** Build the final DiagramState. Pipeline:
 *    1. Materialise stub nodes for any bare-reference endpoints.
 *    2. Elide class-marked transit nodes into edge labels.
 *    3. Hand the graph to dagre - it does rank assignment, crossing
 *       reduction, x-coordinate assignment (Brandes-Köpf), and cluster
 *       layout in one pass.
 *    4. Translate dagre's centre-coords + cluster bboxes back into
 *       Vellum's top-left coords, emitting shapes / containers /
 *       connectors. */
function assembleDiagram(
  direction: Direction,
  nodes: Map<string, ParsedNode>,
  edgesIn: ParsedEdge[],
  subgraphs: Map<string, ParsedSubgraph>,
  styles: {
    classDefs: Map<string, NodeStyle>;
    classAssignments: Map<string, string>;
    inlineStyles: Map<string, NodeStyle>;
  },
): DiagramState {
  // Materialise any nodes that only appear on edges as bare references.
  for (const e of edgesIn) {
    if (!nodes.has(e.from)) {
      nodes.set(e.from, { id: e.from, label: e.from, kind: 'rect' });
    }
    if (!nodes.has(e.to)) {
      nodes.set(e.to, { id: e.to, label: e.to, kind: 'rect' });
    }
  }

  // Class-marked transit nodes (`Po1[Po1]:::edgeLabel`) collapse into
  // edge labels - fewer boxes, cleaner output.
  const edges = elideTransitNodes(nodes, edgesIn);

  const nodeList = Array.from(nodes.values());

  // Per-node sizes derived from label content - fed to dagre as the box
  // dimensions it must lay out around.
  const sizes = new Map<string, { w: number; h: number }>();
  for (const n of nodeList) {
    sizes.set(n.id, computeNodeSize(n.label, n.kind));
  }

  // Build the dagre graph. Compound mode supports clusters (subgraphs),
  // multigraph mode lets us track parallel edges separately so dagre can
  // route them with `edgesep` spacing.
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true });
  g.setGraph({
    rankdir: direction === 'TD' ? 'TB' : direction,
    nodesep: DAGRE_NODESEP,
    ranksep: DAGRE_RANKSEP,
    edgesep: DAGRE_EDGESEP,
    marginx: DAGRE_MARGIN,
    marginy: DAGRE_MARGIN,
    // network-simplex gives the best visual rank assignment but is slower
    // on huge graphs; for import sizes (typically <100 nodes) it's fine.
    ranker: 'network-simplex',
    // Greedy feedback-arc removal so a `A↔B` failover pair gets a clean
    // top-down rank; the original arrow direction is restored on render.
    acyclicer: 'greedy',
  });
  g.setDefaultEdgeLabel(() => ({}));

  // Subgraph clusters first, so node `setParent` calls below see the
  // cluster nodes already present. Then wire nested cluster parentage
  // (`subgraph A ... subgraph B ... end ... end`) - without this, B
  // would lay out as a sibling of A and visibly overflow A's frame.
  for (const [sgId, sg] of subgraphs) {
    g.setNode(`sg:${sgId}`, { label: sg.title });
  }
  for (const [sgId, sg] of subgraphs) {
    if (sg.parent && subgraphs.has(sg.parent)) {
      g.setParent(`sg:${sgId}`, `sg:${sg.parent}`);
    }
  }
  // Actual nodes.
  for (const n of nodeList) {
    const sz = sizes.get(n.id)!;
    g.setNode(n.id, { width: sz.w, height: sz.h });
    if (n.subgraph && subgraphs.has(n.subgraph)) {
      g.setParent(n.id, `sg:${n.subgraph}`);
    }
  }
  // Edges. The `name` argument keys parallel edges so multigraph mode
  // tracks each separately.
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    g.setEdge(e.from, e.to, { weight: 1 }, `e${i}`);
  }

  dagre.layout(g);

  // Read dagre's output. Node entries hold CENTRE coords; we translate to
  // Vellum's top-left convention. Cluster entries hold their own bbox so
  // we don't have to recompute it from member positions.
  const shapes: Shape[] = [];
  const idMap = new Map<string, string>();
  const containerShapes: Shape[] = [];
  for (const [sgId, sg] of subgraphs) {
    const dn = g.node(`sg:${sgId}`);
    if (!dn) continue;
    const cid = `mmd-sg-${sgId}`;
    const containerShape: Shape = {
      id: cid,
      kind: 'container',
      x: Math.round(dn.x - dn.width / 2 - CONTAINER_PAD),
      y: Math.round(dn.y - dn.height / 2 - CONTAINER_PAD),
      w: Math.round(dn.width + CONTAINER_PAD * 2),
      h: Math.round(dn.height + CONTAINER_PAD * 2),
      label: sg.title,
      layer: 'blueprint',
      strokeStyle: 'dashed',
      fill: SUBGRAPH_FILL,
    };
    if (sg.parent && subgraphs.has(sg.parent)) {
      containerShape.parent = `mmd-sg-${sg.parent}`;
    }
    containerShapes.push(containerShape);
  }
  for (const n of nodeList) {
    const dn = g.node(n.id);
    if (!dn) continue;
    const sz = sizes.get(n.id)!;
    const vid = `mmd-${n.id}`;
    idMap.set(n.id, vid);
    const shape: Shape = {
      id: vid,
      kind: n.kind,
      x: Math.round(dn.x - sz.w / 2),
      y: Math.round(dn.y - sz.h / 2),
      w: sz.w,
      h: sz.h,
      layer: 'blueprint',
    };
    if (n.label) shape.label = n.label;
    if (n.kind === 'rect' && n.rounded) shape.cornerRadius = 12;
    if (n.subgraph && subgraphs.has(n.subgraph)) {
      shape.parent = `mmd-sg-${n.subgraph}`;
    }
    // Apply Mermaid style props. Precedence: per-node `style id ...` overrides
    // class-level `classDef name ...` which overrides Vellum's renderer
    // defaults. The inline `:::className` suffix and the `class id name`
    // directive both feed into classAssignments - both produce the same
    // class lookup here.
    const className = n.className ?? styles.classAssignments.get(n.id);
    const classStyle = className ? styles.classDefs.get(className) : undefined;
    const inline = styles.inlineStyles.get(n.id);
    const merged: NodeStyle = { ...classStyle, ...inline };
    if (merged.fill) shape.fill = merged.fill;
    if (merged.stroke) shape.stroke = merged.stroke;
    if (merged.strokeWidth !== undefined) shape.strokeWidth = merged.strokeWidth;
    if (merged.textColor) shape.textColor = merged.textColor;
    shapes.push(shape);
  }
  // Containers paint behind their children.
  const orderedShapes = [...containerShapes, ...shapes];

  // Emit connectors. Strategy:
  //   - Use Vellum's orthogonal auto-routing (clean elbows from cardinal
  //     anchors) instead of dagre's edge waypoints. dagre's intermediate
  //     points are tuned for spline rendering and produce visible jogs
  //     when threaded through Vellum's straight or orthogonal renderer.
  //   - For PARALLEL edges (multiple connectors between the same pair),
  //     assign each connector a distinct FRACTIONAL anchor on the
  //     source/target so the renderer routes them as separate paths
  //     rather than stacking them on top of each other. Mermaid users
  //     expect this for failover pairs (`A → B` and `B → A`) and for
  //     load-balanced flows (`GWLB → NVA1`, `GWLB → NVA1` again).
  const isHorizontal = direction === 'LR' || direction === 'RL';
  const parallelGroups = new Map<string, number[]>();
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    // Group by unordered pair so A→B and B→A share a group; both sides
    // get fractional anchors and don't collide.
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (!parallelGroups.has(key)) parallelGroups.set(key, []);
    parallelGroups.get(key)!.push(i);
  }

  const connectors: Connector[] = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const fromVid = idMap.get(e.from);
    const toVid = idMap.get(e.to);
    if (!fromVid || !toVid) continue;
    const groupKey = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    const peers = parallelGroups.get(groupKey)!;
    const { fromAnchor, toAnchor } = computeParallelAnchors(
      i,
      peers,
      isHorizontal,
    );
    const conn: Connector = {
      id: `mmd-c-${i}`,
      from: { shape: fromVid, anchor: fromAnchor },
      to: { shape: toVid, anchor: toAnchor },
      // Curved S-shaped connectors read better than orthogonal elbows
      // for cloud / network architectures - they suggest flow without
      // the engineering-blueprint connotation of right-angled bends.
      // Vellum's `curved` mode draws cubic Beziers tangent to the
      // anchor exit normals, so cardinal anchors (auto / [t, 1] / etc.)
      // produce smooth arcs out of the source and into the target.
      routing: 'curved',
      fromMarker: e.fromArrow ? 'arrow' : 'none',
      toMarker: e.toArrow ? 'arrow' : 'none',
      layer: 'blueprint',
    };
    if (e.label) conn.label = e.label;
    if (e.style === 'dashed') conn.style = 'dashed';
    if (e.thick) conn.strokeWidth = 2.4;
    connectors.push(conn);
  }

  dodgeConnectorLabels(connectors, orderedShapes);

  return {
    version: '1.0',
    meta: { title: 'Imported from Mermaid', defaults: { fidelity: 1 } },
    shapes: orderedShapes,
    connectors,
    annotations: [],
  };
}

/** Pick fractional anchors for a connector that is part of a parallel
 *  edge group, OR `'auto'` when the connector is the only edge between
 *  its endpoints. Parallel members get evenly-distributed positions
 *  along the bottom/top edges (TB layout) or right/left edges (LR
 *  layout) so each connector gets its own routing channel.
 *
 *  Why unordered grouping (so `A→B` and `B→A` share a group): a failover
 *  pair routed from the same anchor on each side would render two
 *  arrows along the same line. Treating them as peers gives them
 *  distinct anchors and the renderer draws two visibly separate paths. */
function computeParallelAnchors(
  edgeIndex: number,
  peers: number[],
  isHorizontal: boolean,
): { fromAnchor: 'auto' | [number, number]; toAnchor: 'auto' | [number, number] } {
  if (peers.length <= 1) {
    return { fromAnchor: 'auto', toAnchor: 'auto' };
  }
  const idx = peers.indexOf(edgeIndex);
  // Distribute as 1/(N+1), 2/(N+1), ..., N/(N+1) - symmetric around 0.5,
  // never hits 0 or 1 so anchors stay inside the node bounds.
  const t = (idx + 1) / (peers.length + 1);
  if (isHorizontal) {
    // LR/RL: source exits the right edge, target enters the left edge;
    // spread vertically.
    return {
      fromAnchor: [1, t],
      toAnchor: [0, t],
    };
  }
  // TB/BT: source exits the bottom edge, target enters the top edge;
  // spread horizontally.
  return {
    fromAnchor: [t, 1],
    toAnchor: [t, 0],
  };
}

/** Estimate a comfortable bounding-box for `label` at the renderer's
 *  default 13px body. Conservative on width - we'd rather have a slightly
 *  oversized box than truncated text. Diamond geometry crops from the
 *  corners so we expand it a bit; ellipses lose horizontal real estate
 *  to their curve at top/bottom. */
function computeNodeSize(
  label: string,
  kind: ParsedNode['kind'],
): { w: number; h: number } {
  const lines = (label || '').split('\n');
  const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
  let w = Math.max(NODE_MIN_W, Math.min(NODE_MAX_W, maxChars * CHAR_W + LABEL_PAD_X));
  let h = Math.max(NODE_MIN_H, lines.length * LINE_H + LABEL_PAD_Y);
  if (kind === 'diamond') {
    w = Math.min(NODE_MAX_W * 1.3, w * 1.25);
    h *= 1.15;
  } else if (kind === 'ellipse') {
    w = Math.min(NODE_MAX_W * 1.2, w * 1.15);
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/** Candidate label positions tried in order by the dodge pass. Walks
 *  outward from the midpoint, alternating sides so a label that can't
 *  sit at 0.5 prefers the closest clear slot rather than skewing to one
 *  end. The renderer's default (when labelPosition is undefined) is
 *  0.5, so the first candidate matches that - i.e. we only set
 *  labelPosition when we actually need to slide. */
const LABEL_DODGE_CANDIDATES = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8];
/** Minimum gap (in px) between the rendered label bbox and any nearby
 *  shape or container title before we treat it as a clean candidate.
 *  Conservative on purpose - labels that graze a shape look almost as
 *  bad as labels that overlap one. */
const LABEL_DODGE_MARGIN = 4;
/** Conservative padding around the label's text metrics - covers the
 *  small white halo the renderer paints behind connector labels and
 *  protects against small font-metric mismatches between this
 *  geometry-only estimate and what the browser actually measures. */
const LABEL_BBOX_PAD_X = 6;
const LABEL_BBOX_PAD_Y = 4;
/** Approximate height of the cluster's title strip - CONTAINER_PAD
 *  spaces the title above the inner content, then ~24px of glyph
 *  height for the rendered text itself at the renderer's default body
 *  size. */
const CONTAINER_TITLE_BAND_H = 24;

type Bbox = { x: number; y: number; w: number; h: number };

function bboxOverlap(a: Bbox, b: Bbox, margin: number): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}

/** Resolve a Vellum anchor to a world-space point on the shape, picking
 *  the cardinal edge that faces `other` for `'auto'`. Approximate - we
 *  only use this to estimate a connector's chord midpoint, not to
 *  reproduce the renderer's exact path geometry. */
function resolveAnchorPoint(
  s: Bbox,
  anchor: Anchor,
  other: { x: number; y: number },
): { x: number; y: number } {
  if (Array.isArray(anchor)) {
    return { x: s.x + s.w * anchor[0], y: s.y + s.h * anchor[1] };
  }
  const cx = s.x + s.w / 2;
  const cy = s.y + s.h / 2;
  if (anchor === 'top') return { x: cx, y: s.y };
  if (anchor === 'bottom') return { x: cx, y: s.y + s.h };
  if (anchor === 'left') return { x: s.x, y: cy };
  if (anchor === 'right') return { x: s.x + s.w, y: cy };
  // 'auto' - pick the cardinal edge facing the other endpoint.
  const dx = other.x - cx;
  const dy = other.y - cy;
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? { x: s.x + s.w, y: cy } : { x: s.x, y: cy };
  }
  return dy > 0 ? { x: cx, y: s.y + s.h } : { x: cx, y: s.y };
}

/** Post-layout label dodging. For each labelled connector, walk a fixed
 *  set of fractions along the chord between its source and target
 *  anchors and pick the first whose label bbox doesn't sit on top of a
 *  non-endpoint shape or inside a container's title strip. If nothing
 *  clears, leave the connector alone - the renderer's 0.5 default
 *  applies and the user can nudge from there.
 *
 *  Why chord (straight line) and not the rendered curve: Vellum's
 *  `routing: 'curved'` produces a smooth S-curve between two cardinal
 *  anchor exits, and its midpoint is close enough to the chord midpoint
 *  for the dodge fractions to map cleanly between the two. Computing the
 *  exact Bezier midpoint here would mean duplicating the renderer's
 *  path code; the chord approximation gets us correct dodge decisions
 *  in every case I've watched, and this pass is a heuristic anyway. */
function dodgeConnectorLabels(
  connectors: Connector[],
  shapes: Shape[],
): void {
  const shapeById = new Map<string, Shape>();
  for (const s of shapes) shapeById.set(s.id, s);
  const nodeShapes = shapes.filter((s) => s.kind !== 'container');
  const containerShapes = shapes.filter((s) => s.kind === 'container');

  for (const conn of connectors) {
    if (!conn.label) continue;
    if (!('shape' in conn.from) || !('shape' in conn.to)) continue;
    const fromShape = shapeById.get(conn.from.shape);
    const toShape = shapeById.get(conn.to.shape);
    if (!fromShape || !toShape) continue;

    const fromCenter = {
      x: fromShape.x + fromShape.w / 2,
      y: fromShape.y + fromShape.h / 2,
    };
    const toCenter = {
      x: toShape.x + toShape.w / 2,
      y: toShape.y + toShape.h / 2,
    };
    const fromPt = resolveAnchorPoint(fromShape, conn.from.anchor, toCenter);
    const toPt = resolveAnchorPoint(toShape, conn.to.anchor, fromCenter);

    const lines = conn.label.split('\n');
    const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const labelW = Math.ceil(maxChars * CHAR_W + LABEL_BBOX_PAD_X * 2);
    const labelH = Math.ceil(lines.length * LINE_H + LABEL_BBOX_PAD_Y * 2);

    for (const t of LABEL_DODGE_CANDIDATES) {
      const px = fromPt.x + (toPt.x - fromPt.x) * t;
      const py = fromPt.y + (toPt.y - fromPt.y) * t;
      const lbox: Bbox = {
        x: px - labelW / 2,
        y: py - labelH / 2,
        w: labelW,
        h: labelH,
      };

      let collides = false;
      for (const s of nodeShapes) {
        if (s.id === fromShape.id || s.id === toShape.id) continue;
        if (bboxOverlap(lbox, s, LABEL_DODGE_MARGIN)) {
          collides = true;
          break;
        }
      }
      if (!collides) {
        for (const c of containerShapes) {
          if (c.id === fromShape.id || c.id === toShape.id) continue;
          const titleBand: Bbox = {
            x: c.x,
            y: c.y,
            w: c.w,
            h: CONTAINER_PAD + CONTAINER_TITLE_BAND_H,
          };
          if (bboxOverlap(lbox, titleBand, LABEL_DODGE_MARGIN)) {
            collides = true;
            break;
          }
        }
      }
      if (!collides) {
        if (t !== 0.5) conn.labelPosition = t;
        break;
      }
    }
  }
}

/** A node that the source MARKED with one of these class names is treated
 *  as an edge-badge candidate for elision. This catches the
 *  `Po1[Po1]:::edgeLabel` idiom that mermaid.live renders as a small
 *  grey badge mid-connector. We deliberately don't elide unmarked
 *  degree-2 nodes with content labels - an actual decision branch like
 *  `C[OK]` looks identical structurally. */
const TRANSIT_CLASS_RE = /(?:^|\W)(edge[-_]?label|labelnode|edgeBadge|portLabel|interface|inlineLabel|midLabel)(?:$|\W)/i;
/** Pure-symbol labels (empty, just punctuation/whitespace, single dash,
 *  bullet, etc.) are NEVER meaningful content - they're decorations the
 *  user added by accident or intentionally as visual spacers. Any
 *  degree-1-in/1-out node with one of these labels is unconditionally
 *  elided so it doesn't render as a mysterious blank box. This covers
 *  the `[-]`, `[ ]`, `[·]` cases users have hit when adapting diagrams
 *  from other tools. */
const PURE_SYMBOL_LABEL_RE = /^[\s\-_—·•|.]*$/;
const TRANSIT_LABEL_MAX = 60;

/** Fold pseudo-nodes that the source marked as edge decorations into
 *  their adjacent edges. The two A→T→B edges become one A→B carrying T's
 *  label; the pseudo-node is deleted.
 *
 *  Conservative gating: only when the user wrote `:::edgeLabel` (or a
 *  recognised synonym) on the node. Without that signal we leave the
 *  node alone - better to render an extra rect than to silently swallow
 *  an actual decision branch. Subgraph members never get elided (they're
 *  structural, not decorations). */
function elideTransitNodes(
  nodes: Map<string, ParsedNode>,
  edges: ParsedEdge[],
): ParsedEdge[] {
  // Iterate to convergence so a CHAIN of class-marked transits
  // (e.g. `A --> Po1[..]:::edgeLabel --> Mid[-]:::edgeLabel --> B`)
  // collapses fully on subsequent passes. A single pass would only fold
  // the first transit; the second's in-edge (from the now-deleted first)
  // wouldn't appear in the adjacency map and it would stay visible as a
  // floating node - that's the empty "-" box you saw in the screenshot.
  let working = edges;
  // Cap iterations defensively; in practice convergence is 1-3 passes
  // even for long chains.
  for (let pass = 0; pass < 8; pass++) {
    const result = elideTransitPass(nodes, working);
    if (!result.changed) return result.edges;
    working = result.edges;
  }
  return working;
}

/** Single elision sweep - collapses every node that's currently
 *  class-marked AND has degree 1-in/1-out. Returns the new edge list +
 *  whether anything changed (so the caller knows whether to re-sweep). */
function elideTransitPass(
  nodes: Map<string, ParsedNode>,
  edges: ParsedEdge[],
): { edges: ParsedEdge[]; changed: boolean } {
  const inAdj = new Map<string, ParsedEdge[]>();
  const outAdj = new Map<string, ParsedEdge[]>();
  for (const e of edges) {
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to)!.push(e);
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from)!.push(e);
  }

  const elided = new Set<string>();
  const removedEdges = new Set<ParsedEdge>();
  const addedEdges: ParsedEdge[] = [];

  for (const [id, node] of nodes) {
    if (node.kind !== 'rect') continue;
    if (node.subgraph) continue;
    const label = node.label ?? '';
    const classHinted = !!node.className && TRANSIT_CLASS_RE.test(node.className);
    const symbolOnly = PURE_SYMBOL_LABEL_RE.test(label);
    if (!classHinted && !symbolOnly) continue;
    if (label.length > TRANSIT_LABEL_MAX) continue;
    const ins = (inAdj.get(id) ?? []).filter((e) => !removedEdges.has(e));
    const outs = (outAdj.get(id) ?? []).filter((e) => !removedEdges.has(e));
    if (ins.length !== 1 || outs.length !== 1) continue;
    // Self-loop guard: A → T → A would collapse to A → A.
    if (ins[0].from === outs[0].to) continue;
    const merged: ParsedEdge = {
      from: ins[0].from,
      to: outs[0].to,
      // Symbol-only labels are non-content - drop rather than render the
      // glyph in the middle of the merged connector. Class-hinted labels
      // are actual text (port name / interface) and propagate forward.
      label: symbolOnly ? undefined : label,
      style: ins[0].style === 'dashed' || outs[0].style === 'dashed' ? 'dashed' : 'solid',
      thick: ins[0].thick || outs[0].thick,
      fromArrow: ins[0].fromArrow,
      toArrow: outs[0].toArrow,
    };
    removedEdges.add(ins[0]);
    removedEdges.add(outs[0]);
    addedEdges.push(merged);
    elided.add(id);
  }

  for (const id of elided) nodes.delete(id);
  return {
    edges: [...edges.filter((e) => !removedEdges.has(e)), ...addedEdges],
    changed: elided.size > 0,
  };
}
