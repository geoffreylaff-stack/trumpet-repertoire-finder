#!/usr/bin/env node
/**
 * Harvests James Stephenson's catalogue from composerjim.com into
 * data/composerjim.json.
 *
 * Why a source of its own. Stephenson is a living composer whose catalogue is
 * almost entirely absent from the two general sources: IMSLP is
 * public-domain-weighted, and Wikipedia has articles for very few individual
 * works. His own site lists the scoring for each piece, which makes it the
 * best available authority for his music — better than Wikipedia would be even
 * if Wikipedia covered it.
 *
 * What is taken, and what is not. Only catalogue facts: title, instrumentation,
 * year, duration and the page URL. The product descriptions also carry the
 * composer's own programme notes about the music, its commission and its
 * dedicatees; none of that is stored or shipped. The scoring is extracted from
 * the "Instrumentation:" line or the "For ..." summary and nothing else is kept
 * from the prose.
 *
 * Transport. The site is WordPress with WooCommerce, and its Store API returns
 * the catalogue as JSON, so this reads ~10 paginated API responses rather than
 * fetching 1,600 product pages. robots.txt permits this; it disallows only
 * wp-admin and WooCommerce's internal upload paths.
 *
 * Usage: node tools/harvest-composerjim.mjs [--out data/composerjim.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseInstrumentation, formatScoring, requiredInstruments, mentionsFamily, FAMILY,
} from '../lib/instrumentation.mjs';
import { writeIfChanged } from './stable-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://composerjim.com/wp-json/wc/store/v1/products';
const UA = 'TrumpetRepertoireFinder/1.0 (static site build step; contact via repo issues)';
const COMPOSER = 'James M. Stephenson';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, flag('--out', 'data/composerjim.json'));

/**
 * Product categories worth reading. Everything a trumpet, cornet or flugelhorn
 * might appear in — his solo and chamber trumpet music, plus the orchestral and
 * band catalogues where the family sits in the section. Categories with no
 * possible family content (Violin, Cello, Woodwinds…) are skipped, which keeps
 * the request count down without losing anything.
 */
const CATEGORIES = [
  [163, 'Trumpet'], [240, 'Flugelhorn'], [168, 'Brass Quintet'], [45, 'Brass Band'],
  [19, 'Orchestra'], [34, 'Wind Ensemble & Band'],
  [137, 'Concertos (with Orchestra)'], [139, 'Concertos (with Wind Ensemble/Band)'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;

async function api(params, attempt = 0) {
  const url = `${API}?${new URLSearchParams(params)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    requests++;
    await sleep(1500); // one request every 1.5s against a small site
    return await res.json();
  } catch (err) {
    if (attempt >= 3) throw err;
    await sleep(2000 * 2 ** attempt);
    return api(params, attempt + 1);
  }
}

const ENTITIES = {
  '&amp;': '&', '&#038;': '&', '&quot;': '"', '&#039;': "'", '&#8217;': '’',
  '&#8216;': '‘', '&#8220;': '“', '&#8221;': '”', '&#8211;': '–',
  '&#8212;': '—', '&#8242;': "'", '&#8243;': '"', '&nbsp;': ' ', '&lt;': '<', '&gt;': '>',
};
const decode = (s) => String(s ?? '').replace(/&(?:amp|#038|quot|#039|#8217|#8216|#8220|#8221|#8211|#8212|#8242|#8243|nbsp|lt|gt);/g, (m) => ENTITIES[m] ?? m);

/**
 * Strip markup, but turn the block-level tags into commas first.
 *
 * These instrument lists are laid out one player per line and lean on the line
 * break to separate them, so flattening the tags to spaces runs the entries
 * together: "Bb trumpet 1-3" followed by "B flugelhorn" becomes one run-on
 * phrase, and the parser then reads the 3 as three flugelhorns and loses the
 * trumpets entirely. The line break is real punctuation here, so it is kept as
 * one.
 */
const text = (html) => decode(
  String(html ?? '')
    .replace(/<\s*(?:br|\/p|\/li|\/div|\/tr|\/h[1-6])\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' '),
).replace(/\s+/g, ' ').replace(/(?:\s*,\s*)+/g, ', ').replace(/^[,\s]+|[,\s]+$/g, '').trim();

/**
 * The house orchestral shorthand: woodwind group, then brass, then percussion
 * and strings — "*3*3*32 – 4231 – t+4 – hp – pno – str". The brass group is
 * horns.trumpets.trombones.tuba, so its second digit is the trumpet section,
 * and it is often the only place a full-orchestra work states that number.
 *
 * This lives here rather than in the shared parser because it is one
 * publisher's house style, not a general notation. A bare "4231" in some other
 * catalogue's text would mean nothing of the kind, and teaching the shared
 * parser to read four digits as a brass section would misread them everywhere
 * else.
 */
const SHORTHAND = /(?<![\d*])[*\d]{4,6}\s*[–—-]\s*(\d)(\d)(\d)(\d)(?!\d)/;
const SHORTHAND_FULL = /(?<![\d*])((?:\*?\d){4,6})\s*(?:\([^)]*\))?\s*[–—,-]\s*\*?(\d)\*?(\d)\*?(\d)\*?(\d)(?!\d)/;

function trumpetsFromShorthand(scoring) {
  const m = SHORTHAND.exec(scoring);
  return m ? Number(m[2]) : null;
}

// ── Turning a catalogue entry into something a reader can use ─────────────────
//
// The scoring is stored for display as well as for counting, and the two want
// different things. The counter is happy with "*3*3*32 – 4231 – t+4 – hp – str";
// a person reading a search result is not. Everything below rewrites the entry
// into the same plain, comma-separated form the rest of the index uses —
// "3 flutes, 3 oboes, … 4 horns, 2 trumpets, 3 trombones, tuba, timpani,
// 4 percussion, harp, strings" — so a Stephenson row reads like every other row.

const WOODWIND = ['flute', 'oboe', 'clarinet', 'bassoon'];
const BRASS = ['horn', 'trumpet', 'trombone', 'tuba'];
const IRREGULAR = { tuba: 'tubas', piano: 'pianos', harp: 'harps', sax: 'saxophones',
  percussion: 'percussion', strings: 'strings' };
const plural = (name) => IRREGULAR[name] ?? `${name}s`;
const countOf = (n, name) => (n === 1 ? name : `${n} ${plural(name)}`);

/**
 * Replace the two digit groups with the sections they stand for, leaving the
 * rest of the entry alone. The abbreviations that follow them — "t+3", "hp",
 * "str" — are ordinary shorthand and are expanded later with all the others.
 *
 * An asterisk marks a section that includes an auxiliary: a piccolo among the
 * flutes, a contrabassoon among the bassoons. The digit is the number of
 * players either way, so the count is safe to state, and which auxiliary it is
 * goes unasserted rather than guessed at.
 *
 * This rewrites in place rather than rebuilding the entry from the digits
 * alone. An earlier version did the latter, and only when the surrounding words
 * named no trumpet — which meant a concerto whose words did name one kept its
 * raw "1222 – 2100" on display, exactly the thing this is here to remove.
 */
const SHORTHAND_GLOBAL = new RegExp(SHORTHAND_FULL.source, 'g');

function expandDigitGroups(raw) {
  return raw.replace(SHORTHAND_GLOBAL, (whole, winds, hn, tpt, tbn, tuba) => {
    const parts = [];
    [...winds.matchAll(/\*?(\d)/g)].map((x) => Number(x[1])).slice(0, 4)
      .forEach((n, i) => { if (n > 0) parts.push(countOf(n, WOODWIND[i])); });
    [hn, tpt, tbn, tuba].map(Number)
      .forEach((n, i) => { if (n > 0) parts.push(countOf(n, BRASS[i])); });
    return parts.length ? parts.join(', ') : whole;
  });
}

const singular = (word) => (/(?:ss|is|us)$/i.test(word) ? word : word.replace(/s$/i, ''));

/**
 * "Flute 1-2" and "alto sax 1-3" are part numbers; say how many instead.
 *
 * The range has to close its list item, so only the words since the last comma
 * are taken as the instrument's name — otherwise the match reaches backwards
 * across whatever came before and welds two entries into one. Only the last
 * word is pluralised, and it is singularised first: the source writes both
 * "flute 1-2" and "flutes 1-2", and pluralising the second gave "2 flutess".
 */
function rangesToCounts(s) {
  // The leading group captures the separator so it can be put back: without it
  // "Bass Clarinet, Alto sax 1-2" came out as "Bass Clarinet,Alto 2 saxophones".
  // A trailing "*" marks a doubling in this catalogue, and a range is sometimes
  // run straight into the next entry, so neither ends the match.
  return s.replace(/(^|[,;(]\s*)([^,;(]*?)\s*(\d+)\s*[-–—]\s*(\d+)\*?(?=\s*(?:[,;(.]|\s[A-Za-z]|$))/g,
    (whole, lead, name, lo, hi) => {
      const [a, b] = [Number(lo), Number(hi)];
      const words = name.trim().split(/\s+/).filter(Boolean);
      if (!(b > a) || b - a > 11 || !words.length) return whole;
      // "Alto Sax. 1-2" abbreviates with a full stop; keeping it in the word
      // made the name fail the letters-only test and the range went unread.
      const last = words.pop().replace(/\.$/, '');
      if (!/^[A-Za-zé'-]+$/.test(last)) return whole;
      const head = words.length ? `${words.join(' ')} ` : '';
      const n = b - a + 1;
      // The number goes in front of the whole name — "2 alto saxophones" —
      // rather than in front of its last word.
      return `${lead}${n === 1 ? `${head}${singular(last)}` : `${n} ${head}${plural(singular(last))}`}`;
    });
}

const ABBREVIATIONS = [
  [/\bt\s*\+\s*(\d+)/gi, 'timpani, $1 percussion'],
  [/(?<=[,(]\s)t(?=\s*[,)]|$)/gi, 'timpani'],
  [/\btimp\b\.?/gi, 'timpani'], [/\bperc\b\.?/gi, 'percussion'],
  [/\bhp\b\.?/gi, 'harp'], [/\b(?:pf|pno)\b\.?/gi, 'piano'],
  [/\bcel\b\.?/gi, 'celesta'], [/\bstr\b\.?/gi, 'strings'],
  [/\bgtr\b\.?/gi, 'guitar'], [/\bkybds?\b\.?/gi, 'keyboards'],
  [/\bsaxe?s?\b\.?/gi, 'saxophones'], [/\btpts?\b\.?/gi, 'trumpets'],
  [/\btbns?\b\.?/gi, 'trombones'], [/\bflugels?\b(?!horn)/gi, 'flugelhorns'],
  [/\bpicc\b\.?/gi, 'piccolo'], [/\bopt\b\.?/gi, 'optional'],
  [/\bred\b\./gi, 'reduction'], [/\bdbl\b\.?/gi, 'doubling'],
  [/\bsus\b\.\s*cymb\b\.?/gi, 'suspended cymbal'], [/\btrgl\b\.?/gi, 'triangle'],
  [/\bd\.s\.\b/gi, ''],
];

/**
 * The whole tidy-up. The order matters, and each step depends on the one before:
 *
 *   1. Dashes and semicolons become commas, because the later steps all work
 *      one list item at a time.
 *   2. Keys go, before anything reads a number. "Bb clarinet 1-3" has to lose
 *      its Bb here or step 3 keeps it and produces "3 bb clarinets".
 *   3. Part ranges become counts.
 *   4. Abbreviations become words.
 *   5. Punctuation is tidied last, since every earlier step adds commas.
 *
 * The shorthand is only expanded when the words say nothing about the family —
 * the same rule the counts follow. Where a list names its brass in prose it is
 * more specific than four digits can be, and expanding over it replaced a
 * brass-ensemble scoring with a generic orchestra.
 */
function readableScoring(raw) {
  let s = expandDigitGroups(raw)
    .replace(/\s*[–—]\s*/g, ', ')   // this catalogue separates with dashes too
    .replace(/\s*;\s*/g, ', ')
    // Keys are outside this index's scope everywhere else, so they go here too.
    .replace(/\b(?:in\s+)?[A-Ga-g](?:[-\s]?(?:flat|sharp)\b|[b♭#♯])(?![a-z])\s*/g, '')
    .replace(/\b[A-G]\s+(?=(?:piccolo\s+)?(?:trumpet|cornet|flugel|clarinet|horn))/g, '');
  s = rangesToCounts(s);
  for (const [re, word] of ABBREVIATIONS) s = s.replace(re, word);
  s = s
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(?:,\s*)+/g, ', ')
    .replace(/\(\s*\)/g, '')
    .replace(/^[,\s.]+|[,\s.]+$/g, '')
    .trim();
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** "solo trumpet", "solo piccolo trumpet" — a concerto's soloist. */
const SOLO_FAMILY = /\bsolo\s+(?:[a-z]+\s+)?(?:trumpet|cornet|flugelhorn)\b/i;
const SOLO_FAMILY_G = /\bsolo\s+((?:[a-z]+\s+)?(?:trumpet|cornet|flugelhorn)s?)\b/gi;

/**
 * Lift a concerto's soloist out of the scoring so it can be counted alongside
 * the section standing behind it.
 *
 * The parser never adds two mentions of an instrument together — that rule is
 * what stops "the trumpets are silent until the finale" from doubling a
 * section — so "solo trumpet; … 2 trumpets …" reads as one trumpet, not three.
 * Here the two really are different players, which is the same reasoning that
 * makes Haydn's Trumpet Concerto three players in the curated file.
 */
function withSoloistsCounted(scoring) {
  const solos = [];
  const ensemble = scoring.replace(SOLO_FAMILY_G, (_, name) => { solos.push(name); return ' '; });
  const parsed = parseInstrumentation(ensemble);
  if (!solos.length) return parseInstrumentation(scoring);

  const soloParsed = parseInstrumentation(solos.join(', '));
  const counts = { ...parsed.counts };
  for (const [key, n] of Object.entries(soloParsed.counts)) counts[key] = (counts[key] ?? 0) + n;
  const total = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => `${n} ${FAMILY[key].plural}`)
    .join(', ');
  return total ? parseInstrumentation(total) : parsed;
}

/**
 * Long band lists have to be bounded somewhere, but cutting at a fixed length
 * lands mid-word and leaves a fragment ("… baritone saxophone B trum") that
 * then reads as a half-named instrument. Cut back to the last separator.
 *
 * The bound is generous because a band list runs woodwinds first and reaches
 * the brass late: a tighter one cut two works off before their trumpets and
 * dropped them from the index altogether.
 */
function clip(s, limit = 700) {
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf(','), head.lastIndexOf(';'), head.lastIndexOf(' – '));
  return (cut > limit * 0.5 ? head.slice(0, cut) : head).trim();
}

/**
 * Where the scoring stops and the composer's own writing begins.
 *
 * A page usually runs the instrument list straight into a note about the piece,
 * and the two have to be separated on the way in. Getting this wrong is not
 * only untidy: on one entry the extraction ran 1,600 characters into the notes,
 * and the trumpets it should have found were lost among the prose. The list is
 * deliberately broad — a marker matched too eagerly costs a few instruments off
 * the end of a scoring, while one missed drags in text that has no business
 * being stored at all.
 */
const PROSE_STARTS = new RegExp(
  '\\s+(?:'
  + 'notes?\\s+from\\s+the\\s+\\w+'
  + '|program(?:me)?\\s+notes?'
  + '|about\\s+(?:the|this)\\s+\\w+'
  + '|(?:co-)?commissioned\\b|premiered\\b|dedicated\\b|written\\s+for\\b|composed\\s+for\\b'
  + '|(?:includes|contains|uses)?\\s*the\\s+following\\b'
  + '|view\\s+(?:orchestral\\s+)?score\\b'
  + '|duration\\s*:'
  + '|(?:this|the)\\s+(?:piece|work|fanfare|concerto|movement|suite|symphony)\\b'
  + '|when\\s+I\\b|I\\s+(?:was|had|have|wrote|began)\\b|my\\s+\\w+\\s+(?:was|is)\\b'
  + '|\\b(?:special\\s+|many\\s+|with\\s+|my\\s+)?thanks\\b'
  + ')', 'i');

function cutAtProse(s) {
  const m = PROSE_STARTS.exec(s);
  return m ? s.slice(0, m.index).trim() : s;
}

/**
 * The scoring, and only the scoring. Prefers the explicit "Instrumentation:"
 * line; falls back to the "For ..." clause that opens the short description.
 * Everything after the scoring — programme notes, commission history — is left
 * behind deliberately.
 */
function scoringOf(product) {
  const desc = text(product.description);
  const short = text(product.short_description);

  const line = /(?:^|\s)instrumentation\s*:\s*(.+?)(?:\s+(?:program|programme)\s+notes\b|\s+view\s+(?:orchestral\s+)?score\b|\s+commissioned\b|\s+premiered\b|$)/i.exec(desc);
  if (line) return { scoring: clip(cutAtProse(line[1].trim())), how: 'instrumentation-line' };

  const forClause = /^\s*for\s+(.+?)(?:\s*\/\s*|$)/i.exec(short);
  if (forClause) return { scoring: clip(cutAtProse(forClause[1].trim())), how: 'short-description' };
  return { scoring: null, how: null };
}

function yearOf(product) {
  const blob = `${text(product.short_description)} ${text(product.description)}`;
  const m = /\bcompos(?:ed|ition)\s+in\s+(\d{4})\b/i.exec(blob)
    ?? /\((\d{4})\)/.exec(blob)
    ?? /\b(?:written|premiered)\s+in\s+(\d{4})\b/i.exec(blob);
  const y = m ? Number(m[1]) : null;
  return y && y >= 1980 && y <= new Date().getFullYear() + 1 ? y : null;
}

/** Editions are separate products; the parent carries the work's own name. */
function titleOf(product) {
  return decode(product.name)
    .replace(/\s*[:–-]\s*(?:print edition|pdf download|score only|parts?|full score)\s*$/i, '')
    .replace(/\s*\(?rental[^)]*\)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const GENRE_BY_CATEGORY = [
  ['Concertos (with Orchestra)', 'Concerto'],
  ['Concertos (with Wind Ensemble/Band)', 'Concerto'],
  ['Ballet', 'Ballet'], ['Opera', 'Opera'],
  ['Brass Band', 'Wind ensemble'], ['Wind Ensemble & Band', 'Wind ensemble'],
  ['Orchestra', 'Orchestral'],
  ['Chorus', 'Vocal chamber'], ['Voice', 'Vocal chamber'],
  ['Solos', 'Solo'],
  ['Chamber Music', 'Chamber'],
];

function genreOf(names) {
  const set = new Set(names.map(decode));
  for (const [cat, genre] of GENRE_BY_CATEGORY) if (set.has(cat)) return genre;
  return 'Other';
}

// ── Harvest ───────────────────────────────────────────────────────────────────
const byId = new Map();
for (const [id, label] of CATEGORIES) {
  let page = 1;
  for (;;) {
    const batch = await api({ category: String(id), per_page: '100', page: String(page) });
    if (!Array.isArray(batch) || !batch.length) break;
    for (const p of batch) if (!byId.has(p.id)) byId.set(p.id, p);
    process.stderr.write(`  ${label} page ${page}: ${batch.length}\n`);
    if (batch.length < 100) break;
    page++;
  }
}
process.stderr.write(`\n${byId.size} distinct products across ${CATEGORIES.length} categories\n`);

const works = [];
const skipped = { noScoring: 0, noFamily: 0, edition: 0 };

for (const p of byId.values()) {
  // Editions carry no description of their own; the parent product holds the work.
  if (!text(p.description) && !text(p.short_description)) { skipped.edition++; continue; }

  const { scoring: raw, how: readAs } = scoringOf(p);
  if (!raw) { skipped.noScoring++; continue; }

  let parsed = withSoloistsCounted(raw);

  // A full-orchestra work usually states its brass only in the shorthand, so
  // the words alone find no trumpets at all. The shorthand fills that gap and
  // nothing more: where the list does name its brass in words it says which
  // instruments as well as how many, and a four-digit group knows only about
  // trumpets. Letting it overrule the words turned "2 cornets, 2 trumpets"
  // into a flat three trumpets, losing the cornets.
  let how = null;
  const fromShorthand = trumpetsFromShorthand(raw);
  if (!parsed.total && fromShorthand !== null) {
    // Players, not parts: a concerto's soloist is counted alongside the section
    // they play in front of, the same convention the curated file uses.
    const total = fromShorthand + (SOLO_FAMILY.test(raw) ? 1 : 0);
    if (total > 0) {
      parsed = parseInstrumentation(`${total} trumpets`);
      how = 'orchestral-shorthand';
    }
  }

  if (!parsed.total) {
    if (!mentionsFamily(raw)) skipped.noFamily++;
    else skipped.noScoring++;
    continue;
  }

  works.push({
    composer: COMPOSER,
    title: titleOf(p),
    year: yearOf(p),
    genre: genreOf((p.categories ?? []).map((c) => c.name)),
    scoring: formatScoring(parsed),
    counts: parsed.counts,
    req: requiredInstruments(parsed),
    // Counts come from the raw entry, which carries the most information;
    // `full` is the same scoring rewritten for a reader. A build-time check
    // confirms the two still describe the same forces.
    full: readableScoring(raw),
    raw,
    estimated: parsed.uncertain.length > 0,
    // No \b after the dot: a word boundary needs a word character on one side,
    // and "Arr. Stephenson" has a space there, so \b never matched and every
    // arrangement was recorded as an original.
    arrangement: /\barr(?:\.|anged\b)/i.test(decode(p.name)),
    how: how ?? readAs,
    url: p.permalink,
  });
}

// One work can appear under several categories; keep the richest reading.
const byTitle = new Map();
for (const w of works) {
  const key = w.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const prev = byTitle.get(key);
  if (!prev || w.counts.trumpet > (prev.counts.trumpet ?? 0)) byTitle.set(key, w);
}
const unique = [...byTitle.values()].sort((a, b) => a.title.localeCompare(b.title));

await fs.mkdir(path.dirname(OUT), { recursive: true });
const wrote = await writeIfChanged(OUT, {
  generated: new Date().toISOString(),
  source: "composerjim.com — James Stephenson's own catalogue",
  note: 'Catalogue facts only: title, instrumentation, year and page URL. The programme notes on the site are the composer\'s own writing and are not stored.',
  counts: { works: unique.length, products: byId.size, requests },
  works: unique,
});
if (!wrote) process.stderr.write('  unchanged since the last harvest; file left as it was\n');

process.stderr.write(
  `\nWrote ${OUT}\n  ${unique.length} works with trumpet-family scoring\n`
  + `  skipped: ${skipped.edition} editions, ${skipped.noScoring} without a readable scoring, `
  + `${skipped.noFamily} without the family\n  ${requests} API requests\n`);
