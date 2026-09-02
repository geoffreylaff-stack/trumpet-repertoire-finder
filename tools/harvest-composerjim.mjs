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

function trumpetsFromShorthand(scoring) {
  const m = SHORTHAND.exec(scoring);
  return m ? Number(m[2]) : null;
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
 * The scoring, and only the scoring. Prefers the explicit "Instrumentation:"
 * line; falls back to the "For ..." clause that opens the short description.
 * Everything after the scoring — programme notes, commission history — is left
 * behind deliberately.
 */
function scoringOf(product) {
  const desc = text(product.description);
  const short = text(product.short_description);

  const line = /(?:^|\s)instrumentation\s*:\s*(.+?)(?:\s+(?:program|programme)\s+notes\b|\s+view\s+(?:orchestral\s+)?score\b|\s+commissioned\b|\s+premiered\b|$)/i.exec(desc);
  if (line) return { scoring: line[1].trim().slice(0, 400), how: 'instrumentation-line' };

  const forClause = /^\s*for\s+(.+?)(?:\s*\/\s*|$)/i.exec(short);
  if (forClause) return { scoring: forClause[1].trim().slice(0, 400), how: 'short-description' };
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
    full: raw,
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
