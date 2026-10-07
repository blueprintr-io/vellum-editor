/* Forgiving search for pickers: icon packs, library shapes and rack
 * equipment.
 *
 * A query is split into words, and an item matches when every word finds
 * something in it:
 *   - the same word, singular or plural ("switches" → "Switch");
 *   - the start of a word ("fire" → "Firewall");
 *   - an abbreviation or synonym from the glossary below ("fw" → "Firewall",
 *     "lb" → "Load balancer", "fibre" → "Fiber");
 *   - the initials of consecutive words ("hsm" → "Hardware security module");
 *   - the word with a typo ("swtich" → "Switch", "firwall" → "Firewall");
 *   - letters in order from the start of a word, for abbreviations of three
 *     letters or more ("rtr" → "Router", "stg" → "Storage").
 * Matches in an item's name count most, then its keywords, then context such
 * as its vendor or category. Of two items that match equally well, the one
 * whose name is more fully covered by the query ranks first, so "Firewall"
 * beats "Firewall manager policy" for "firewall".
 *
 * Each distinct query word is scored once against the index's vocabulary
 * rather than once per item, so a search over the ~11k-icon manifest stays
 * within a few milliseconds. DOM-free; covered by tests/fuzzy-search.test.ts. */

export type SearchFields = {
  /** What the item is called; matches here count most. */
  name: string;
  /** Other words and phrases it answers to. */
  keywords?: readonly string[];
  /** Where it comes from, such as a vendor or category; counts least. */
  context?: readonly string[];
};

export type FuzzyOptions = {
  /** Shortest query word that may match by letters in order ("rtr" →
   *  "router"). Shorter words rely on the glossary and initials, which keeps
   *  a two-letter query from matching most of a large catalogue. */
  minSubsequence?: number;
};

/** `missing` counts the query's words the item didn't match (see `search`). */
export type FuzzyHit = { index: number; score: number; missing: number };

/** Equivalent terms: a query word equal to one of a group's single-word
 *  terms also searches for the group's other terms. Normalized text. */
const GLOSSARY: readonly (readonly string[])[] = [
  ['fw', 'firewall', 'ngfw', 'utm'],
  ['waf', 'web application firewall'],
  ['lb', 'slb', 'adc', 'load balancer', 'load balancing', 'application delivery controller'],
  ['sw', 'switch'],
  ['rtr', 'router'],
  ['gw', 'gateway'],
  ['srv', 'svr', 'server'],
  ['ap', 'wap', 'access point', 'wireless access point'],
  ['wlc', 'wireless controller', 'wireless lan controller'],
  ['wifi', 'wlan', 'wireless'],
  ['ups', 'uninterruptible power supply', 'battery backup'],
  ['pdu', 'rpdu', 'power distribution unit', 'power strip', 'power bar'],
  ['ats', 'sts', 'transfer switch', 'automatic transfer switch'],
  ['kvm', 'keyboard video mouse'],
  ['nas', 'network attached storage'],
  ['san', 'storage area network'],
  ['das', 'jbod', 'direct attached storage', 'disk shelf', 'disk enclosure'],
  ['nvr', 'dvr', 'cctv', 'network video recorder', 'video recorder'],
  ['hsm', 'hardware security module'],
  ['pbx', 'pabx', 'voip', 'telephony', 'phone system'],
  ['ntp', 'ptp', 'time server', 'gps clock'],
  ['av', 'audio visual', 'audio video'],
  ['pp', 'patch panel'],
  ['odf', 'fiber panel', 'optical distribution frame'],
  ['fiber', 'fibre', 'optical'],
  ['fc', 'fibre channel', 'fiber channel'],
  ['cm', 'cable manager', 'cable management'],
  ['oob', 'out of band', 'console server', 'terminal server', 'serial console'],
  ['bmc', 'ilo', 'idrac', 'ipmi'],
  ['mgmt', 'management'],
  ['psu', 'power supply'],
  ['nic', 'network card', 'network interface'],
  ['hba', 'host bus adapter'],
  ['tor', 'top of rack'],
  ['hci', 'hyperconverged'],
  ['gpu', 'accelerator'],
  ['lto', 'tape', 'tape library'],
  ['env', 'environment', 'environmental'],
  ['pc', 'computer', 'workstation'],
  ['db', 'database'],
  ['k8s', 'kubernetes'],
  ['vm', 'virtual machine'],
  ['vpc', 'vnet', 'virtual network'],
  ['vpn', 'virtual private network'],
  ['cdn', 'content delivery network'],
  ['dns', 'domain name system'],
  ['ids', 'intrusion detection'],
  ['ips', 'intrusion prevention'],
  ['iam', 'identity and access management'],
  ['sso', 'single sign on'],
  ['ad', 'active directory'],
  ['mq', 'message queue'],
  ['lan', 'local area network'],
  ['wan', 'wide area network'],
  ['iot', 'internet of things'],
  ['ml', 'machine learning'],
  ['ai', 'artificial intelligence'],
  ['os', 'operating system'],
  ['cpu', 'processor'],
  ['hdd', 'hard drive', 'hard disk'],
  ['ssd', 'solid state drive'],
  ['auth', 'authentication'],
  ['cert', 'certificate'],
  ['repo', 'repository'],
  ['app', 'application'],
  ['svc', 'service'],
  ['msg', 'message'],
  ['img', 'image'],
];

const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with']);

const KEYWORD_WEIGHT = 0.85;
const CONTEXT_WEIGHT = 0.6;
const SYNONYM_WEIGHT = 0.95;
/** Every word of a glossary phrase must match at least this well. */
const STRONG = 0.7;
/** A name word matched at least this well counts as covered by the query. */
const COVERED = 0.4;

/** Lowercase letters and digits, single-spaced:
 *  "Load-Balancer_v2" → "load balancer v2", "Fibré" → "fibre". */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function searchWords(text: string): string[] {
  const n = normalizeSearchText(text);
  return n ? n.split(' ') : [];
}

/** A crude English singular, applied to both sides of every comparison so
 *  its mistakes ("status" → "statu") cancel out. */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Singular query word → the phrases (as word lists) it also searches for. */
const SYNONYMS = new Map<string, string[][]>();
for (const group of GLOSSARY) {
  for (const term of group) {
    if (term.includes(' ')) continue;
    const key = singular(term);
    const alts = SYNONYMS.get(key) ?? [];
    for (const other of group) if (other !== term) alts.push(other.split(' '));
    SYNONYMS.set(key, alts);
  }
}

/** Optimal string alignment distance (edits plus adjacent swaps), giving up
 *  as soon as it must exceed `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, before[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    before = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** How well a typed word `t` (singular `ts`) matches word `w` (singular
 *  `ws`), from 0 (not at all) to 1 (exactly). */
function wordQuality(t: string, ts: string, w: string, ws: string, minSubsequence: number): number {
  if (w === t) return 1;
  if (ws === ts) return 0.98;
  if (w.startsWith(t)) return 0.7 + (0.25 * t.length) / w.length;
  // Inside a word: "sql" in "mysql". Three letters hide in many words
  // ("tor" in "storage"), so they count for less.
  if (t.length >= 3 && w.includes(t)) return (t.length >= 4 ? 0.45 : 0.35) + (0.1 * t.length) / w.length;
  if (t.length >= 4) {
    const max = t.length >= 8 ? 2 : 1;
    const sameStart = w[0] === t[0] || w[1] === t[1] || (w[0] === t[1] && w[1] === t[0]);
    if (sameStart && Math.abs(w.length - t.length) <= max) {
      const d = editDistance(t, w, max);
      if (d <= max) return 0.5 - 0.08 * (d - 1);
    }
    // A misspelt start of a longer word: "firwal" → "firewall". Only the
    // word's start as long as what was typed, or one longer, is compared,
    // so "fibre" (dropping its "b") doesn't pass for the "fire" of firewall.
    if (w[0] === t[0] && w.length > t.length + 1) {
      for (let len = t.length; len <= t.length + 1; len++)
        if (editDistance(t, w.slice(0, len), 1) <= 1) return 0.42;
    }
  }
  if (t.length >= minSubsequence && t.length < w.length && w[0] === t[0]) {
    let j = 1;
    let last = 0;
    for (let i = 1; i < t.length; i++) {
      while (j < w.length && w[j] !== t[i]) j++;
      if (j >= w.length) return 0;
      last = j++;
    }
    return 0.3 + (0.15 * t.length) / (last + 1);
  }
  return 0;
}

/** A glossary term matches only whole words (or, when four letters or more,
 *  the start of one) - "ap" must not find every "api". */
function synonymQuality(a: string, as: string, w: string, ws: string): number {
  if (w === a) return 1;
  if (ws === as) return 0.98;
  if (a.length >= 4 && w.startsWith(a)) return 0.85;
  return 0;
}

type Doc = {
  name: Int32Array;
  /** First letters of the name's words, when it has two or more. */
  initials: string;
  keywords: Int32Array;
  keywordInitials: readonly string[];
  context: Int32Array;
};

type Token = {
  word: string;
  singular: string;
  alternatives: readonly string[][];
  acronym: boolean;
  numeric: boolean;
};

export class FuzzyIndex {
  private readonly vocab: string[] = [];
  private readonly vocabSingular: string[] = [];
  private readonly ids = new Map<string, number>();
  private readonly docs: Doc[];
  private readonly minSubsequence: number;
  private longestName = 0;

  constructor(items: readonly SearchFields[], options: FuzzyOptions = {}) {
    this.minSubsequence = options.minSubsequence ?? 3;
    this.docs = items.map((item) => this.doc(item));
  }

  get size(): number {
    return this.docs.length;
  }

  private id(word: string): number {
    let id = this.ids.get(word);
    if (id === undefined) {
      id = this.vocab.length;
      this.ids.set(word, id);
      this.vocab.push(word);
      this.vocabSingular.push(singular(word));
    }
    return id;
  }

  private doc(item: SearchFields): Doc {
    const name = searchWords(item.name);
    this.longestName = Math.max(this.longestName, name.length);
    const keywords: number[] = [];
    const keywordInitials: string[] = [];
    for (const phrase of item.keywords ?? []) {
      const words = searchWords(phrase);
      for (const w of words) keywords.push(this.id(w));
      if (words.length > 1) keywordInitials.push(words.map((w) => w[0]).join(''));
    }
    // "loadbalancer" finds "Load balancer".
    for (let i = 0; i + 1 < name.length; i++) keywords.push(this.id(name[i] + name[i + 1]));
    const context: number[] = [];
    for (const phrase of item.context ?? []) for (const w of searchWords(phrase)) context.push(this.id(w));
    return {
      name: Int32Array.from(name, (w) => this.id(w)),
      initials: name.length > 1 ? name.map((w) => w[0]).join('') : '',
      keywords: Int32Array.from(keywords),
      keywordInitials,
      context: Int32Array.from(context),
    };
  }

  private tokens(query: string): Token[] {
    const words = searchWords(query);
    const meaningful = words.filter((w) => !STOP_WORDS.has(w));
    return [...new Set(meaningful.length ? meaningful : words)].map((word) => ({
      word,
      singular: singular(word),
      alternatives: SYNONYMS.get(singular(word)) ?? [],
      acronym: /^[a-z]{2,8}$/.test(word),
      numeric: /^\d+$/.test(word),
    }));
  }

  /** Items matching `query`, best first (ties keep their index order).
   *  An item must match every word, except that numbers are optional ("48
   *  port switch" still finds switches) and a query of two or more other
   *  words may miss one of them; `missing` says how many it missed. Rarer
   *  words weigh more, so a partial match on "firewall" outranks one on
   *  "aws". `fallback` may vouch for a query word on an item the text
   *  doesn't match, with a quality from 0 to 1 - rack search uses it for
   *  words that name an option, like "sfp". */
  search(query: string, fallback?: (index: number, word: string) => number): FuzzyHit[] {
    const tokens = this.tokens(query);
    if (!tokens.length) return [];
    const { vocab, vocabSingular, docs } = this;
    const literal = new Map<string, Float32Array>();
    const synonym = new Map<string, Float32Array>();
    for (const t of tokens) {
      if (!literal.has(t.word)) {
        const q = new Float32Array(vocab.length);
        for (let i = 0; i < vocab.length; i++)
          q[i] = wordQuality(t.word, t.singular, vocab[i], vocabSingular[i], this.minSubsequence);
        literal.set(t.word, q);
      }
      for (const alt of t.alternatives)
        for (const a of alt)
          if (!synonym.has(a)) {
            const as = singular(a);
            const q = new Float32Array(vocab.length);
            for (let i = 0; i < vocab.length; i++) q[i] = synonymQuality(a, as, vocab[i], vocabSingular[i]);
            synonym.set(a, q);
          }
    }

    const best = (q: Float32Array, ids: Int32Array) => {
      let m = 0;
      for (let i = 0; i < ids.length; i++) if (q[ids[i]] > m) m = q[ids[i]];
      return m;
    };
    /** Weakest word of a phrase found in one field; 0 unless all are. */
    const phrase = (alt: string[], ids: Int32Array) => {
      let m = 1;
      for (const a of alt) m = Math.min(m, best(synonym.get(a)!, ids));
      return m >= STRONG ? m : 0;
    };

    const n = docs.length;
    const count = tokens.length;
    const words = tokens.filter((t) => !t.numeric).length;
    const allowMissing = words >= 2 ? 1 : 0;
    const leadToken = Math.max(0, tokens.findIndex((t) => !t.numeric));
    // Pass 1: how well each item matches each query word.
    const quality = new Float32Array(n * count);
    const coverage = new Float32Array(n);
    const lead = new Uint8Array(n);
    const missing = new Uint8Array(n);
    const frequency = new Float64Array(count);
    const covered = new Uint8Array(this.longestName);
    for (let d = 0; d < n; d++) {
      const doc = docs[d];
      const name = doc.name;
      covered.fill(0, 0, name.length);
      for (let k = 0; k < count; k++) {
        const t = tokens[k];
        /** Marks the name's words this token matches. */
        const cover = (q: Float32Array) => {
          for (let i = 0; i < name.length; i++)
            if (q[name[i]] >= COVERED) {
              covered[i] = 1;
              if (k === leadToken && i === 0) lead[d] = 1;
            }
        };
        const lit = literal.get(t.word)!;
        cover(lit);
        let q = Math.max(
          best(lit, name),
          best(lit, doc.keywords) * KEYWORD_WEIGHT,
          best(lit, doc.context) * CONTEXT_WEIGHT,
        );
        if (t.acronym) {
          // Two letters are the initials of a great many names ("lb": Light
          // Bulb, Life Buoy), so they count for less - and for less again
          // when the glossary already knows what the letters stand for.
          const weight = (t.word.length === 2 ? 0.65 : 1) * (t.alternatives.length ? 0.7 : 1);
          const at = doc.initials.indexOf(t.word);
          if (at >= 0) {
            const a = (doc.initials.length === t.word.length ? 0.9 : 0.78) * weight;
            q = Math.max(q, a);
            if (a >= 0.6) {
              for (let i = at; i < at + t.word.length; i++) covered[i] = 1;
              if (k === leadToken && at === 0) lead[d] = 1;
            }
          }
          for (const initials of doc.keywordInitials)
            if (initials.includes(t.word))
              q = Math.max(q, (initials === t.word ? 0.9 : 0.78) * weight * KEYWORD_WEIGHT);
        }
        for (const alt of t.alternatives) {
          if (alt.length === 1) {
            const s = synonym.get(alt[0])!;
            cover(s);
            q = Math.max(
              q,
              best(s, name) * SYNONYM_WEIGHT,
              best(s, doc.keywords) * KEYWORD_WEIGHT * SYNONYM_WEIGHT,
              best(s, doc.context) * CONTEXT_WEIGHT * SYNONYM_WEIGHT,
            );
          } else {
            const inName = phrase(alt, name);
            if (inName) for (const a of alt) cover(synonym.get(a)!);
            q = Math.max(
              q,
              inName * SYNONYM_WEIGHT,
              phrase(alt, doc.keywords) * KEYWORD_WEIGHT * SYNONYM_WEIGHT,
              phrase(alt, doc.context) * CONTEXT_WEIGHT * SYNONYM_WEIGHT,
            );
          }
        }
        if (fallback) q = Math.max(q, fallback(d, t.word));
        quality[d * count + k] = q;
        if (q > 0) frequency[k]++;
        else if (!t.numeric) missing[d]++;
      }
      let c = 0;
      for (let i = 0; i < name.length; i++) c += covered[i];
      coverage[d] = name.length ? c / name.length : 0;
    }

    // Pass 2: a word found in fewer items says more about the ones it is in.
    const weight = Array.from(frequency, (f) => 1 + Math.log((n + 1) / (f + 1)) / Math.log(n + 2));
    const hits: FuzzyHit[] = [];
    for (let d = 0; d < n; d++) {
      if (missing[d] > allowMissing) continue;
      let sum = 0;
      let total = 0;
      let numbers = 0;
      for (let k = 0; k < count; k++) {
        const q = quality[d * count + k];
        if (tokens[k].numeric && words) {
          if (q > 0) numbers++;
          continue;
        }
        sum += weight[k] * q;
        total += weight[k];
      }
      if (sum <= 0) continue;
      hits.push({
        index: d,
        // Starting the way the query starts only helps complete matches: in
        // "48 port switch" the thing wanted is the last word, not the first.
        score: (100 * sum) / total + 5 * numbers + 15 * coverage[d] + (lead[d] && !missing[d] ? 8 : 0),
        missing: missing[d],
      });
    }
    hits.sort((a, b) => b.score - a.score || a.index - b.index);
    return hits;
  }
}
