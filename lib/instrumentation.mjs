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
 * A leading count or trailing part-range/number written against an
 * out-of-scope name, wrapped around it so both are erased along with the
 * name itself. A number left behind is free to drift onto whichever real
 * instrument sits next in a comma-less run-on list — "bass trumpet 4
 * cornet 1-2" would otherwise leave a stray "4" for "cornet" to misread as
 * its own count instead of the "1-2" that is actually its. Independent of,
 * and for the same reason as, the leading/trailing consumption the main
 * matching loop does for in-scope instruments below.
 *
 * The negative lookbehind on the leading side guards the opposite mistake —
 * reading a bare digit as this name's own count when it is actually the
 * tail of an unrelated, real instrument's range sitting right before it:
 * "trumpet 1-3 bass trumpet" must not let "bass trumpet" swallow trumpet's
 * own "3".
 */
const OUT_OF_SCOPE_LEADING = String.raw`\b(?<![-–—]\s*)(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|double|triple|quadruple)\s+`;
const OUT_OF_SCOPE_TRAILING = String.raw`\s*\d+\s*(?:[-–—]\s*\d+)?`;
function withAdjacentNumbers(source) {
  return new RegExp(`(?:${OUT_OF_SCOPE_LEADING})?(?:${source})(?:${OUT_OF_SCOPE_TRAILING})?`, 'gi');
}

/**
 * Names that contain an in-scope instrument's name but are not that instrument.
 * These are erased from the text before anything else looks at it — skipping
 * them in the matching loop is not enough, because "bass trumpet" still holds
 * the word "trumpet" for a later pattern to find.
 */
const OUT_OF_SCOPE = [
  // Bass trumpet is deliberately outside this app's scope.
  withAdjacentNumbers(String.raw`\bbass[\s-]*(?:trumpets?|trompete[ns]?)\b`),
  withAdjacentNumbers(String.raw`\btromb[ae]\s+bass[ao]\b`),
  withAdjacentNumbers(String.raw`\bbasstrompete[ns]?\b`),
  // The trumpet marine is a bowed monochord — a trumpet in name only.
  withAdjacentNumbers(String.raw`\b(?:trumpet|tromba|trompette)\s+marin[ae]?\b`),
  // The cornett / cornetto (Zink) is a Renaissance wooden horn, unrelated to
  // the valved cornet.
  withAdjacentNumbers(String.raw`\b(?:cornett[ioe]?s?|zinken?)\b`),
  // "Trumpet 8'" on an organ is a rank of pipes, not a player.
  withAdjacentNumbers(String.raw`\btrumpet\s+stops?\b`),
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
  ['piccoloTrumpet', /\bpiccolo[\s-]*trompete[ns]?\b/i],
  ['piccoloTrumpet', /\btromb[ae]\s+piccol[ae]\b/i],
  ['piccoloTrumpet', /\bbach[\s-]*trumpets?\b/i],
  ['flugelhorn',     /\bfl(?:ü|ue|u)gel[\s-]?h(?:o|ö|oe)rn(?:er|s)?\b/i],
  ['cornet',         /\bcornets?\b/i],
  ['cornet',         /\bkornett(?:s|en|e)?\b/i],
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
const PLURAL = /(?:trumpets|cornets|kornett(?:s|en|e)|horns|h(?:ö|oe)rner|trompettes|trompeten|trombe|clarini)\b/i;

/** Some catalogues write "third doubling flugelhorn" where scores write "3rd". */
const ORDINAL_WORDS = {
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th',
  sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th',
};

/**
 * Marks a parenthetical as describing a doubling rather than fresh players.
 *
 * "dbl." is the ordinary abbreviation in a score, and a part list often says a
 * player "includes" the second instrument rather than doubles on it. Both
 * describe the same thing: one player, two instruments to own. "or" is
 * deliberately absent — a choice between instruments is not a doubling, and
 * treating it as one would claim a work needs a cornet when the trumpeter may
 * simply play the part on the trumpet.
 */
const DOUBLING_CUE = /doubl|\bdbl|includ|also|alternat|switch|=|raddoppi/i;

/** An ordinal naming a chair: "3rd", "third", or a bare "3". */
const ORDINAL = /\b(\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\b/gi;

/**
 * A chair as scores name it: "third" and a bare "2" both become "3rd", "2nd".
 * Part lists write "Trumpet 2 doubles flugelhorn", meaning the 2nd.
 */
function asOrdinal(token) {
  const word = ORDINAL_WORDS[token.toLowerCase()];
  if (word) return word;
  if (!/^\d+$/.test(token)) return token; // already "3rd"
  const n = parseInt(token, 10);
  const teen = n % 100 >= 11 && n % 100 <= 13;
  return `${n}${teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th')}`;
}

/**
 * Which chairs take up the doubled instrument, as a readable phrase.
 *
 * Only ordinals BEFORE the cue name players; those after it belong to the
 * instrument being picked up. A band score writing "3rd and 4th doubling 2nd
 * and 3rd flugelhorn" has four ordinals, of which only the first two are
 * chairs.
 */
function doublingPlayers(aside) {
  const cue = DOUBLING_CUE.exec(aside);
  const players = [...new Set(
    [...(cue ? aside.slice(0, cue.index) : aside).matchAll(ORDINAL)].map((m) => asOrdinal(m[1])),
  )];
  if (!players.length) return null;
  if (players.length === 1) return players[0];
  return `${players.slice(0, -1).join(', ')} and ${players.at(-1)}`;
}

/**
 * Every family instrument named in a piece of text, most specific first.
 *
 * Each name is blanked once matched so that a broader pattern cannot claim it
 * a second time: "piccolo trumpet" must not also register as a plain trumpet.
 * The caller passes text that has already had transpositions stripped.
 */
function familyNamesIn(text) {
  const at = new Map();
  let scan = text;
  for (const [key, re] of PATTERNS) {
    const m = re.exec(scan);
    if (!m) continue;
    scan = scan.slice(0, m.index) + ' '.repeat(m[0].length) + scan.slice(m.index + m[0].length);
    if (!at.has(key)) at.set(key, m.index);
  }
  // Blanking keeps the string's length, so the indices stay comparable and the
  // list can be handed back in the order the text names them.
  return [...at].sort((a, b) => a[1] - b[1]).map(([key]) => key);
}

/**
 * Split a doubling aside into one clause per doubling.
 *
 * A comma joins onto the clause so far in two cases. Before the cue arrives,
 * bare ordinals are an incomplete fragment that has to attach to whatever
 * follows: "2nd, 3rd and 4th doubling flugelhorn" lists three chairs taking
 * one instrument, not three separate doublings. After the cue, a comma only
 * still joins when what follows is a pure remark repeating the same
 * instrument, not naming a different one — a fresh cue of its own always
 * starts a new clause regardless of what either side names, and so does a
 * comma-separated item that turns out to name a different instrument: a
 * section list can read "flutes doubling piccolo, oboes, clarinets doubling
 * piccolo clarinet, and bassoons", where "oboes" is its own bare item, not a
 * remark on the flutes' doubling, even though the whole aside contains the
 * word "doubling".
 */
function doublingClauses(aside) {
  const clauses = [];
  for (const chunk of aside.split(/[,;]/)) {
    const last = clauses.at(-1);
    if (last === undefined) { clauses.push(chunk); continue; }

    const lastNames = familyNamesIn(last);
    const lastIsIncomplete = !DOUBLING_CUE.test(last) && lastNames.length === 0;
    const chunkIsPureRemark = !DOUBLING_CUE.test(chunk)
      && familyNamesIn(chunk).every((key) => lastNames.includes(key));

    if (lastIsIncomplete || chunkIsPureRemark) {
      clauses[clauses.length - 1] = `${last}, ${chunk}`;
    } else {
      clauses.push(chunk);
    }
  }
  return clauses;
}

/**
 * Read every doubling an aside describes, each with the chairs that take it,
 * plus any instrument the aside names without a doubling cue of its own.
 *
 * One aside can name more than one instrument — "2nd doubling flugelhorn, 3rd
 * doubling cornet", or "doubling cornet and flugelhorn" where a single player
 * owns both. Reading only the first left the second instrument out of the
 * work's required list, so nobody searching for it could find the work.
 *
 * An aside is not always only a doubling, though — see doublingClauses — so
 * a clause with no cue of its own is kept apart as a bare mention rather
 * than credited to whichever doubling happens to sit next to it.
 */
function readDoublings(aside) {
  const found = [];
  const bare = [];
  const seen = new Set();
  for (const clause of doublingClauses(aside)) {
    const hasCue = DOUBLING_CUE.test(clause);
    const player = hasCue ? doublingPlayers(clause) : null;
    for (const key of familyNamesIn(clause)) {
      if (seen.has(key)) continue; // a later remark repeating the name
      seen.add(key);
      (hasCue ? found : bare).push({ key, player, text: clause });
    }
  }
  return { found, bare };
}

/**
 * The count a bare mention (no leading number, found loose in an aside)
 * implies for `key` — an explicit number in front of it if there is one,
 * otherwise the same singular/plural guess a plain segment would make.
 */
function countFor(text, key) {
  for (const [k, re] of PATTERNS) {
    if (k !== key) continue;
    const m = re.exec(text);
    if (!m) continue;
    const n = leadingCount(text, m.index);
    if (n !== null) return { count: n, ambiguous: false };
    const isPlural = PLURAL.test(m[0]);
    return { count: isPlural ? 2 : 1, ambiguous: isPlural };
  }
  return { count: 1, ambiguous: false }; // familyNamesIn already found it; a pattern must match
}

/** True when the string names any in-scope family instrument at all. */
export function mentionsFamily(text) {
  if (!text) return false;
  const cleaned = stripTranspositions(stripOutOfScope(text));
  return PATTERNS.some(([, re]) => re.test(cleaned));
}

/**
 * Index of the text's first family mention (by whichever pattern matches
 * earliest), or -1 if none. Matched against the raw text, not the
 * scope-stripped form mentionsFamily uses — stripping shortens the string
 * and would shift the index away from the original text a caller cuts.
 * Used to find where a harvested article's scoring prose actually begins.
 */
export function firstFamilyMentionIndex(text) {
  if (!text) return -1;
  let earliest = -1;
  for (const [, re] of PATTERNS) {
    const m = re.exec(text);
    if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
  }
  return earliest;
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

/**
 * Read a part range written after the instrument: "Trumpet 1-4" means four
 * players, not one. Band and wind-ensemble instrument lists number their parts
 * this way as a matter of course, and without this the whole section collapses
 * to a single "trumpet" — the range is the only statement of size those lists
 * make.
 *
 * The range must sit immediately after the name, so "trumpet in B-flat 1" and
 * a stray "3-4 minutes" elsewhere in the text cannot be mistaken for one.
 *
 * A bare trailing number with no range ("Trumpet 1") is deliberately not
 * read as a count either — see the same comment — but it still needs
 * consuming, `count: null` and all: left alone, that "1" sits in the scan
 * for whatever comes next in a run-on list to misread as its own leading
 * count, turning "trumpet in B-flat 1 cornet 1-2" into one cornet instead
 * of two.
 */
function trailingRange(segment, afterIndex) {
  const after = segment.slice(afterIndex);
  const range = /^\s*(\d+)\s*[-–—]\s*(\d+)\b/.exec(after);
  if (range) {
    const [lo, hi] = [parseInt(range[1], 10), parseInt(range[2], 10)];
    if (hi > lo && hi - lo <= 11) {
      // `length` lets the caller consume the range together with the name it
      // belongs to, so the next instrument along cannot inherit its last number.
      return { count: hi - lo + 1, length: range[0].length };
    }
  }
  const bare = /^\s*\d+\b(?!\s*[-–—])/.exec(after);
  if (bare) return { count: null, length: bare[0].length };
  return null;
}

/** Pull a leading quantity off a segment: "2 trumpets" / "two trumpets". */
function leadingCount(segment, matchIndex) {
  const before = segment.slice(0, matchIndex).trim();
  // A part range that follows an instrument name belongs to that instrument,
  // not the one after it: in "trumpet 1-3 flugelhorn" the 3 is the third
  // trumpet, and reading it forwards invents three flugelhorns. This arises
  // when a list runs two entries together without a comma, which is what a
  // stripped-out line break leaves behind.
  //
  // The name has to be there. A range with nothing before it is an ordinary
  // count — "3-4 trumpets" means three or four of them — and treating that as
  // somebody else's part numbers loses the count altogether.
  if (/[a-z]\s*\d+\s*[-–—]\s*\d+\s*(?:x\s*)?$/i.test(before)) return null;
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
 * Where a leading count starts, mirroring what leadingCount reads — the
 * position right before the digits or number-word, not just its value.
 *
 * The run-on consuming loop needs this to blank the count along with the
 * name once it is read: name-matching alone erases "trumpets" from "3
 * trumpets cornet" but leaves the "3" sitting in the scan, free to be read
 * again as "cornet"'s own leading count — three trumpets, three cornets,
 * when the source states a count for only one of them.
 */
function leadingCountStart(segment, matchIndex) {
  const before = segment.slice(0, matchIndex).trimEnd();
  if (/[a-z]\s*\d+\s*[-–—]\s*\d+\s*(?:x\s*)?$/i.test(before)) return null;
  const digits = /(\d+)\s*(?:x\s*)?$/.exec(before);
  if (digits) return digits.index;

  const word = /([a-z]+)\s*$/i.exec(before);
  if (word && NUMBER_WORDS[word[1].toLowerCase()]) return word.index;
  return null;
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

    // Read every family instrument the segment names, left to right, blanking
    // each match as it is taken so a longer name cannot be counted twice: once
    // "piccolo trumpet" is consumed, the bare "trumpet" pattern must not find
    // it again.
    //
    // This used to stop at the first match, on the assumption that a segment
    // names one instrument. Run-on lists break that assumption — a stripped
    // line break leaves "trumpet 1-3 flugelhorn" as a single segment, and
    // stopping early recorded the flugelhorn and silently lost three trumpets.
    let primaryKey = null;
    let scan = head;
    let lastEnd = -1;
    for (;;) {
      let found = null;
      for (const [key, re] of PATTERNS) {
        const m = re.exec(scan);
        // PATTERNS is ordered most-specific-first, so on a tie the more
        // specific name is already in hand; otherwise the earliest mention wins.
        if (m && (!found || m.index < found.m.index)) found = { key, m };
      }
      if (!found) break;
      const { key, m } = found;

      // "2 trumpets or 2 flugelhorns" is one pair of players with a choice of
      // instrument, not four players — so the alternative is skipped and the
      // instrument named first is the one recorded. The count is allowed to
      // repeat inside the gap, since the choice is usually spelled out on both
      // sides rather than left implied.
      const gap = lastEnd >= 0 ? scan.slice(lastEnd, m.index) : null;
      const alternative = gap !== null && /^[\s,]*(?:or|oder|ou)\b[\s\d,]*$/i.test(gap);

      // Read the count before consuming anything, then consume the name
      // together with both its leading count and any trailing range, so the
      // next instrument in a run-on list cannot inherit either: neither the
      // range's last number ("trumpet 1-3 flugelhorn" — the 3 is the third
      // trumpet) nor a count already claimed here with nothing of its own to
      // replace it ("3 trumpets cornet" is three trumpets and one cornet,
      // not three — left unconsumed, that "3" is still sitting there for
      // "cornet" to read as its own).
      const nameEnd = m.index + m[0].length;
      const range = trailingRange(scan, nameEnd);
      const consumedEnd = nameEnd + (range ? range.length : 0);
      const leadStart = leadingCountStart(scan, m.index);
      const n = leadingCount(scan, m.index) ?? (range ? range.count : null);
      const consumedStart = leadStart ?? m.index;
      const before = scan.slice(0, consumedStart);
      scan = before + ' '.repeat(consumedEnd - consumedStart) + scan.slice(consumedEnd);
      lastEnd = consumedEnd;
      if (alternative) continue;

      primaryKey ??= key;
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
    }

    // Doublings named in the aside ("3rd doubling flugelhorn"). See
    // DOUBLING_CUE for which words mark one, and why "or" is not among them.
    for (const aside of asides) {
      if (!DOUBLING_CUE.test(aside)) continue;
      const { found, bare } = readDoublings(stripTranspositions(aside));
      for (const { key, player } of found) {
        // An aside often restates the instrument it belongs to — "trumpet 2
        // doubles flugelhorn" — and nothing doubles itself.
        if (key === primaryKey) continue;
        doublings.push({
          instrument: key,
          parent: primaryKey,
          player,
          text: aside.trim(),
        });
        if (!primaryKey && explicit[key] === undefined && inferred[key] === undefined) {
          inferred[key] = 0; // named only as a doubling, so no part of its own
        }
      }
      // A clause with no cue of its own is a plain mention riding along in
      // the aside, not a doubling — it gets a real, independent count.
      for (const { key, text: clause } of bare) {
        if (key === primaryKey) continue;
        if (explicit[key] === undefined && inferred[key] === undefined) {
          const { count, ambiguous: isAmbiguous } = countFor(clause, key);
          inferred[key] = count;
          if (isAmbiguous) ambiguous.add(key);
        }
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
