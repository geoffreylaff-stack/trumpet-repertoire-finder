/**
 * Shared instrumentation parser.
 *
 * Runs unmodified in Node (harvesters) and in the browser (app). It turns the
 * free-text instrumentation strings used by catalogues and publishers into
 * structured counts for one instrument family, then renders them back out in a
 * single canonical form so that "3 tpt.", "Three Trumpets" and
 * "2 trumpets in B-flat, cornet" all display consistently.
 *
 * Everything family-specific lives in the FAMILY table and the PATTERNS list
 * below; the parsing machinery underneath is family-agnostic.
 */

/**
 * Canonical family members, in score order (top of the section down).
 *
 * Scope decisions, all deliberate:
 *   • Transposition is ignored. "Trumpet in C" and "Trumpet in B-flat" are both
 *     simply "trumpet" — see stripTranspositions.
 *   • Cornet is its own instrument, not a kind of trumpet. Different bore,
 *     different tone, and orchestrally a separate line — Tchaikovsky and
 *     Berlioz both write for trumpets and cornets at the same time.
 *   • Bass trumpet is excluded, and is actively consumed by an IGNORE pattern
 *     so that it cannot fall through and be counted as a plain trumpet.
 */
export const FAMILY = {
  piccoloTrumpet: { label: 'piccolo trumpet', plural: 'piccolo trumpets', order: 0 },
  trumpet:        { label: 'trumpet',         plural: 'trumpets',         order: 1 },
  cornet:         { label: 'cornet',          plural: 'cornets',          order: 2 },
  flugelhorn:     { label: 'flugelhorn',      plural: 'flugelhorns',      order: 3 },
};

export const FAMILY_KEYS = Object.keys(FAMILY).sort(
  (a, b) => FAMILY[a].order - FAMILY[b].order
);

/**
 * The key an instrument is pitched in, in any of the ways sources write it:
 * "in C", "in B-flat", "in B♭", "in Bb", "E-flat trumpet". The trailing
 * negative lookahead keeps "in Concert pitch" from reading as a key, since a
 * bare note name is only a note name when nothing follows it.
 */
const KEY_OF = String.raw`[A-G](?:[-‐‑‒–—\s]*(?:flat|sharp)\b|\s*[b♭#♯](?![a-z]))?`;
const IN_KEY = new RegExp(String.raw`\s+in\s+${KEY_OF}(?:\s+or\s+${KEY_OF})*(?![\w'])`, 'gi');

/** The mirror-image form: "B-flat trumpet", "3 E-flat cornets". */
const FAMILY_WORD = String.raw`(?:piccolo[\s-]*)?(?:trumpet|cornet|kornett|fl(?:ü|ue|u)gel|clarin[oi]|tromb[ae]|tromp)`;
const KEY_PREFIX = new RegExp(String.raw`\b${KEY_OF}\s+(?=${FAMILY_WORD})`, 'gi');

/**
 * Drop the key an instrument is pitched in. Beyond being outside this app's
 * scope, leaving it in corrupts the count: "3 B-flat trumpets" would otherwise
 * read as an unnumbered plural, because the number no longer sits against the
 * instrument it belongs to. Applied per segment, after splitting, so it can
 * never reach across a comma and weld two instruments together.
 */
function stripTranspositions(segment) {
  return segment.replace(IN_KEY, '').replace(KEY_PREFIX, '').replace(/\s+/g, ' ').trim();
}

/**
 * Names that contain an in-scope instrument's name but are not that instrument.
 * These are erased from the text before anything else looks at it — skipping
 * them in the matching loop is not enough, because "bass trumpet" still holds
 * the word "trumpet" for a later pattern to find.
 */
const OUT_OF_SCOPE = [
  // Bass trumpet is deliberately outside this app's scope.
  /\bbass[\s-]*(?:trumpets?|trompete[ns]?)\b/gi,
  /\btromb[ae]\s+bass[ao]\b/gi,
  /\bbasstrompete[ns]?\b/gi,
  // The trumpet marine is a bowed monochord — a trumpet in name only.
  /\b(?:trumpet|tromba|trompette)\s+marin[ae]?\b/gi,
  // The cornett / cornetto (Zink) is a Renaissance wooden horn, unrelated to
  // the valved cornet.
  /\b(?:cornett[ioe]?s?|zinken?)\b/gi,
  // "Trumpet 8'" on an organ is a rank of pipes, not a player.
  /\btrumpet\s+stops?\b/gi,
];

/** Blank out every out-of-scope name so no pattern can see inside one. */
function stripOutOfScope(text) {
  let t = String(text);
  for (const re of OUT_OF_SCOPE) t = t.replace(re, ' ');
  return t;
}

/**
 * Match patterns, deliberately ordered most-specific-first: "piccolo trumpet"
 * must be consumed before the bare "trumpet" pattern can claim its second word.
 */
const PATTERNS = [
  ['piccoloTrumpet', /\bpiccolo[\s-]*trumpets?\b/i],
  ['piccoloTrumpet', /\btromb[ae]\s+piccol[ae]\b/i],
  ['piccoloTrumpet', /\bbach[\s-]*trumpets?\b/i],
  ['flugelhorn',     /\bfl(?:ü|ue|u)gel[\s-]?horns?\b/i],
  ['cornet',         /\bcornets?\b/i],
  ['cornet',         /\bkornetts?\b/i],
  ['trumpet',        /\btrumpets?\b/i],
  ['trumpet',        /\btrompete[ns]?\b/i],
  ['trumpet',        /\btrompettes?\b/i],
  ['trumpet',        /\btromb[ae]\b/i],
  ['trumpet',        /\bclarin[oi]\b/i],
  ['trumpet',        /\btpt\.?(?!\w)/i],
];

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, solo: 1, single: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  double: 2, triple: 3, quadruple: 4,
};

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * Plural forms across every language the patterns accept. Tested against the
 * matched text itself, so it only ever sees a family instrument's own name —
 * "horns" here can only be the tail of "flugel horns".
 */
const PLURAL = /(?:trumpets|cornets|kornetts|horns|trompettes|trompeten|trombe|clarini)\b/i;

/** Some catalogues write "third doubling flugelhorn" where scores write "3rd". */
const ORDINAL_WORDS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
};

/** True when the string names any in-scope family instrument at all. */
export function mentionsFamily(text) {
  if (!text) return false;
  const cleaned = stripTranspositions(stripOutOfScope(text));
  return PATTERNS.some(([, re]) => re.test(cleaned));
}

/**
 * Split an instrumentation string into segments on commas, semicolons and
 * top-level "and", while keeping parenthesised asides attached to their
 * instrument (so "3 trumpets (3rd doubling flugelhorn)" stays one segment).
 */
function splitSegments(text) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);

    if (depth === 0 && (c === ',' || c === ';' || c === '/')) {
      out.push(buf); buf = ''; continue;
    }
    if (depth === 0 && /\s/.test(c)) {
      const rest = text.slice(i);
      const m = /^\s+(?:and|und|et|&)\s+/i.exec(rest);
      if (m) { out.push(buf); buf = ''; i += m[0].length - 1; continue; }
    }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Pull a leading quantity off a segment: "2 trumpets" / "two trumpets". */
function leadingCount(segment, matchIndex) {
  const before = segment.slice(0, matchIndex).trim();
  const digits = /(\d+)\s*(?:x\s*)?$/.exec(before);
  if (digits) return parseInt(digits[1], 10);

  const word = /([a-z]+)\s*$/i.exec(before);
  if (word) {
    const n = NUMBER_WORDS[word[1].toLowerCase()];
    if (n) return n;
  }
  return null; // unknown — decided by plurality below
}

/**
 * Parse an instrumentation string into family counts.
 *
 * @returns {{counts: Record<string, number>, doublings: Array, present: string[],
 *            uncertain: string[], total: number}}
 */
export function parseInstrumentation(text) {
  const counts = {};
  const doublings = [];
  // Counts are NOT accumulated across mentions. Source text routinely names an
  // instrument more than once — a second scoring for a reduced version, or plain
  // narrative ("the trumpets are silent until the finale") — and summing those
  // turns three trumpets into six. The scoring is stated first, so the first
  // explicit number wins; plurality is only a fallback.
  const explicit = {};   // key -> count taken from an actual number
  const inferred = {};   // key -> count read off singular/plural
  const ambiguous = new Set(); // only plurals are a real guess; "trumpet" means one
  if (!text) return { counts, doublings, present: [], uncertain: [], total: 0 };

  const normalised = stripOutOfScope(String(text).replace(/[’‘]/g, "'"))
    .replace(/\s+/g, ' ');

  for (const rawSegment of splitSegments(normalised)) {
    // Separate the parenthetical aside; it describes doublings, not new players.
    const asides = [];
    const head = stripTranspositions(
      rawSegment.replace(/\(([^)]*)\)|\[([^\]]*)\]/g, (_, a, b) => {
        asides.push(a ?? b ?? '');
        return ' ';
      })
    );

    let primaryKey = null;
    for (const [key, re] of PATTERNS) {
      const m = re.exec(head);
      if (!m) continue;
      primaryKey = key;

      const n = leadingCount(head, m.index);
      if (n !== null) {
        if (explicit[key] === undefined) explicit[key] = n;
      } else {
        // No number given: fall back on plurality, recorded separately so an
        // explicit count stated elsewhere always outranks the guess.
        const isPlural = PLURAL.test(m[0]);
        if (inferred[key] === undefined) {
          inferred[key] = isPlural ? 2 : 1;
          if (isPlural) ambiguous.add(key); // "trumpets" could be any number
        }
      }
      break; // one family instrument per segment
    }

    // Doublings named in the aside ("3rd doubling flugelhorn").
    for (const aside of asides) {
      if (!/doubl|also|alternat|switch|=|raddoppi/i.test(aside)) continue;
      const cleanAside = stripTranspositions(aside);
      for (const [key, re] of PATTERNS) {
        if (!re.test(cleanAside)) continue;
        const ordinalWord = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/i.exec(cleanAside);
        const player = /(\d+(?:st|nd|rd|th)?)/.exec(cleanAside)
          ?? (ordinalWord ? [null, ORDINAL_WORDS[ordinalWord[1].toLowerCase()]] : null);
        doublings.push({
          instrument: key,
          parent: primaryKey,
          player: player ? player[1] : null,
          text: aside.trim(),
        });
        if (!primaryKey && explicit[key] === undefined && inferred[key] === undefined) {
          inferred[key] = 0; // named only as a doubling, so no part of its own
        }
        break;
      }
    }
  }

  // Resolve: an explicit number beats a guess; only a guess is "uncertain".
  const uncertain = [];
  for (const key of new Set([...Object.keys(explicit), ...Object.keys(inferred)])) {
    if (explicit[key] !== undefined) {
      counts[key] = explicit[key];
    } else {
      counts[key] = inferred[key];
      if (inferred[key] > 0 && ambiguous.has(key)) uncertain.push(key);
    }
  }

  const present = FAMILY_KEYS.filter((k) => counts[k] > 0);
  const total = present.reduce((s, k) => s + counts[k], 0);
  return { counts, doublings, present, uncertain, total };
}

/** "two trumpets, cornet" — words for small numbers, singular gets no number. */
export function formatScoring(parsed, { numerals = false } = {}) {
  // Group doublings under the instrument whose players actually pick them up,
  // so a Ravel score reads "three trumpets (1st doubling piccolo trumpet)".
  const byParent = new Map();
  const orphans = [];
  for (const d of parsed.doublings || []) {
    if (!FAMILY[d.instrument]) continue;
    if (parsed.counts[d.instrument]) continue; // listed on its own line already
    const phrase = d.player
      ? `${d.player} doubling ${FAMILY[d.instrument].label}`
      : `doubling ${FAMILY[d.instrument].label}`;
    if (d.parent && parsed.counts[d.parent]) {
      if (!byParent.has(d.parent)) byParent.set(d.parent, []);
      byParent.get(d.parent).push(phrase);
    } else {
      orphans.push(phrase);
    }
  }

  const parts = [];
  for (const key of FAMILY_KEYS) {
    const n = parsed.counts[key];
    if (!n) continue;
    const meta = FAMILY[key];
    const num = !numerals && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
    let piece = n === 1 ? meta.label : `${num} ${meta.plural}`;
    const extra = byParent.get(key);
    if (extra?.length) piece += ` (${extra.join(', ')})`;
    parts.push(piece);
  }

  return [...parts, ...orphans].join(', ');
}

/**
 * Every family instrument the work actually requires a player to pick up,
 * counted parts and doublings alike. A flugelhorn taken up by the third
 * trumpet is still a flugelhorn as far as anyone searching for one is
 * concerned.
 */
export function requiredInstruments(parsed) {
  const keys = new Set(FAMILY_KEYS.filter((k) => parsed.counts[k] > 0));
  for (const d of parsed.doublings || []) if (FAMILY[d.instrument]) keys.add(d.instrument);
  return [...keys].sort((a, b) => FAMILY[a].order - FAMILY[b].order);
}

/** Stable signature for de-duplicating identical scorings. */
export function scoringKey(parsed) {
  return FAMILY_KEYS.map((k) => `${k}:${parsed.counts[k] || 0}`).join('|');
}

/**
 * Tidy a catalogue category name into a plain instrumentation string:
 * "For 2 trumpets, cornet (arr)" -> { text: "2 trumpets, cornet", arrangement: true }
 */
export function fromCategoryName(name) {
  let text = String(name).replace(/^For\s+/i, '').trim();
  const arrangement = /\(arr\)\s*$/i.test(text);
  text = text.replace(/\(arr\)\s*$/i, '').trim();
  return { text, arrangement };
}
