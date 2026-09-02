#!/usr/bin/env node
/**
 * Harvests composer birth and death years from IMSLP into data/composer-dates.json.
 *
 * Why. The index knew when 52 of its 2,008 composers lived, all of them typed
 * by hand into the curated file. Everyone else was a bare name, which is
 * exactly the information a reader wants first — whether the composer is a
 * contemporary you could commission from, or someone three centuries dead.
 *
 * Where the dates come from. IMSLP keeps a structured person record on each
 * composer's category page:
 *
 *     {{#fte:person
 *     |Born Year=1948|Born Month=|Born Day=
 *     |Died Year=|Died Month=|Died Day=
 *
 * That is a better source than a general one for these particular people. Most
 * of this index came from IMSLP, so its own page titles identify each composer
 * exactly, with no name matching to get wrong — and its long tail of obscure
 * arrangers exists nowhere else in a form a lookup could find.
 *
 * An empty Died Year is the interesting case and is left to the build to
 * interpret: this file records only what the page says.
 *
 * Usage: node tools/harvest-composers.mjs [--out data/composer-dates.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIfChanged } from './stable-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://imslp.org/api.php';
const UA = 'TrumpetRepertoireFinder/1.0 (static site build step; contact via repo issues)';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, flag('--out', 'data/composer-dates.json'));
const IN = path.resolve(ROOT, flag('--from', 'data/imslp.json'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function api(params, attempt = 0) {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json' })}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    calls++;
    await sleep(150);
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(1000 * 2 ** attempt);
    return api(params, attempt + 1);
  }
}

/**
 * A year as IMSLP writes it. Most are plain, but the field also carries
 * approximations ("c.1600", "ca. 1720") and occasionally a range for a date
 * nobody is sure of ("1683 or 1684"). The first four-digit number is the year
 * in every one of those forms; anything with no year at all is not a date.
 */
function yearOf(raw) {
  const m = /(\d{4})/.exec(String(raw ?? ''));
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 800 && y <= new Date().getFullYear() ? y : null;
}

const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Every spelling IMSLP knows the composer by, as single folded words.
 *
 * A transliterated name reaches this index under whichever spelling its source
 * happened to use, and the two need not agree: IMSLP files Glazunov under
 * "Aleksandr" while Wikipedia says "Alexander", so a lookup on the exact name
 * finds nothing and the composer keeps no dates at all. IMSLP records the
 * variants itself:
 *
 *     |Alternate Names=Alexander, Alexandre Konstantinovič, … Glazounow
 *
 * The field is a jumble of forename and surname variants rather than a list of
 * whole names, so it is kept as a bag of words for the build to match against
 * — which is enough, because a match there has to agree on the surname too.
 */
function alternateWords(wikitext) {
  const raw = /\|\s*Alternate Names\s*=\s*([^|\n}]*)/i.exec(wikitext)?.[1] ?? '';
  return [...new Set(fold(raw).split(' ').filter((w) => w.length > 1))];
}

/** Pull the person record out of a category page's wikitext. */
function personDates(wikitext) {
  // IMSLP writes the person record under two different template names, and a
  // guard on only the first quietly rejected hundreds of pages that had the
  // dates all along — Glazunov among them. The fields inside are the same.
  if (!/\{\{#(?:fte:person|imslpcomposer)/i.test(wikitext)) return null;
  const born = yearOf(/\|\s*Born Year\s*=\s*([^|\n}]*)/i.exec(wikitext)?.[1]);
  const died = yearOf(/\|\s*Died Year\s*=\s*([^|\n}]*)/i.exec(wikitext)?.[1]);
  if (!born && !died) return null;
  const alt = alternateWords(wikitext);
  // A death before a birth is a typo on the page, not a fact about a person.
  if (born && died && died < born) return { born, died: null, suspect: true, alt };
  return { born, died, ...(alt.length ? { alt } : {}) };
}

// ── Harvest ───────────────────────────────────────────────────────────────────
const source = JSON.parse(await fs.readFile(IN, 'utf8'));
const names = [...new Set((source.composers ?? []).map((c) => c.sort).filter(Boolean))].sort();
process.stderr.write(`Looking up ${names.length} composers on IMSLP\n`);

const dates = {};
const stats = { found: 0, noRecord: 0, missingPage: 0 };

for (let i = 0; i < names.length; i += 50) {
  const batch = names.slice(i, i + 50);
  const d = await api({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    titles: batch.map((n) => `Category:${n}`).join('|'),
  });

  // The API normalises some titles on the way in; map them back so a result
  // can be filed under the name this index actually uses.
  const back = new Map();
  for (const n of d?.query?.normalized ?? []) back.set(n.to, n.from);

  for (const page of Object.values(d?.query?.pages ?? {})) {
    const title = back.get(page.title) ?? page.title;
    const name = String(title).replace(/^Category:/, '');
    if (page.missing !== undefined) { stats.missingPage++; continue; }
    const rev = page?.revisions?.[0];
    const wikitext = rev?.slots?.main?.['*'] ?? rev?.['*'] ?? '';
    const found = personDates(wikitext);
    if (!found) { stats.noRecord++; continue; }
    dates[name] = found;
    stats.found++;
  }
  if ((i / 50) % 5 === 0) process.stderr.write(`  ${i + batch.length}/${names.length}\n`);
}

const born = Object.values(dates).filter((d) => d.born).length;
const living = Object.values(dates).filter((d) => d.born && !d.died).length;

await fs.mkdir(path.dirname(OUT), { recursive: true });
const wrote = await writeIfChanged(OUT, {
  generated: new Date().toISOString(),
  source: 'IMSLP / Petrucci Music Library (imslp.org) — person records on composer category pages',
  counts: { looked_up: names.length, ...stats, with_birth_year: born, no_death_year: living, apiCalls: calls },
  dates,
});
if (!wrote) process.stderr.write('  unchanged since the last harvest; file left as it was\n');

process.stderr.write(
  `\nWrote ${OUT}\n  ${stats.found} person records (${born} with a birth year, `
  + `${living} with no death year)\n  ${stats.noRecord} pages carried no record, `
  + `${stats.missingPage} had no page\n  ${calls} API calls\n`);
