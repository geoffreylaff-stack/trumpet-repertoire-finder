#!/usr/bin/env node
/**
 * Harvests composition years for the works already in the index, into
 * data/work-years.json.
 *
 * Why. Works are listed by date within each genre, but only the hand-curated
 * entries carried a year. Everything harvested sorted after them, and among
 * itself alphabetically — so a composer's Symphony No. 15 came before No. 2.
 *
 * Where the years come from. Both harvesters already read each work's page;
 * they simply never kept the date:
 *
 *   IMSLP      |Year/Date of Composition=1937 (between April and July)
 *   Wikipedia  the infobox (| year = 1927, | composed = 1924–25), or failing
 *              that the article's opening, "…composed in 1927…"
 *
 * Only the composition year is recorded. A publication or premiere year would
 * sort well enough, but the interface shows this number as the date the work
 * was written, so it has to be that.
 *
 * This file records what the pages say. The build checks each year against
 * the composer's lifetime before using it.
 *
 * Usage: node tools/harvest-years.mjs [--out data/work-years.json] [--gap 400]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeIfChanged } from './stable-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMSLP_API = 'https://imslp.org/api.php';
const WIKI = 'https://en.wikipedia.org';
const UA = 'TrumpetRepertoireFinder/1.1 (static site build step; contact via repo issues)';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, flag('--out', 'data/work-years.json'));
const GAP = Number(flag('--gap', '400'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status === 503) {
      if (attempt >= 6) return null;
      const header = Number(res.headers.get('retry-after'));
      await sleep(Math.max(Number.isFinite(header) && header > 0 ? header * 1000 : 0, 2000 * 2 ** attempt));
      return get(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    calls++;
    await sleep(GAP);
    return await res.text();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(1000 * 2 ** attempt);
    return get(url, attempt + 1);
  }
}

/**
 * The year a field gives: "c.1750", "1937 (between April and July)". A range
 * is a work's span of composition, and a work is dated by when it was
 * finished, so "1924–25" is 1925 and "1946–1951/53" is 1953 — the date
 * Shostakovich's Tenth is always given.
 */
export function yearOf(raw) {
  const m = /(?<!\d)(1[0-9]{3}|20[0-9]{2})((?:\s*[–—\-\/]\s*\d{2,4}(?!\d))*)/.exec(String(raw ?? ''));
  if (!m) return null;
  let y = Number(m[1]);
  const last = m[2] ? /(\d{2,4})\s*$/.exec(m[2])?.[1] : null;
  if (last) {
    const end = last.length === 4 ? Number(last) : Math.floor(y / 100) * 100 + Number(last.slice(-2));
    if (end >= y && end - y <= 60) y = end; // otherwise not a range ("1820/21" fine, "1750-3" left as is)
  }
  return y >= 1000 && y <= new Date().getFullYear() ? y : null;
}

export function imslpYear(wikitext) {
  const raw = /\|\s*Year\/Date of Composition\s*=\s*([^|\n]*)/i.exec(wikitext)?.[1];
  return yearOf(raw);
}

/** Wikitext with templates, references, comments and link markup removed. */
function prose(wikitext) {
  let s = wikitext.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref[^>]*\/>/gi, '').replace(/<ref[\s\S]*?<\/ref>/gi, '');
  for (let i = 0; i < 6; i++) s = s.replace(/\{\{[^{}]*\}\}/g, ''); // nested templates, innermost first
  s = s.replace(/\{\|[\s\S]*?\|\}/g, '');
  return s.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/'''?/g, '');
}

export function wikipediaYear(wikitext) {
  // Infobox fields that state when the work was written. Premiere and
  // publication fields are deliberately not among them.
  const field = /^\s*\|\s*(?:year|years|composed|composition_date|date_composed|written|date)\s*=\s*(.+)$/im.exec(wikitext);
  const fromField = field ? yearOf(field[1].replace(/<ref[\s\S]*$/i, '')) : null;
  if (fromField) return { year: fromField, how: 'infobox' };
  const lead = prose(wikitext).slice(0, 4000);
  // The wording between the verb and the year must not move on to a
  // premiere or a publication ("composed for…, first performed in 1850").
  const m = /\b(?:composed|written|completed|wrote)\b([^.\n]{0,80}?)(?<!\d)((?:1[0-9]{3}|20[0-9]{2})(?:\s*[–—\-\/]\s*\d{2,4}(?!\d))*)/i.exec(lead);
  const fromLead = m && !/premi|perform|publish|staged|produc/i.test(m[1]) ? yearOf(m[2]) : null;
  return fromLead ? { year: fromLead, how: 'lead' } : null;
}

// Run as a script, not when the tests import the parsers above.
if (import.meta.url === `file://${process.argv[1]}`) {
  const imslp = JSON.parse(await fs.readFile(path.join(ROOT, 'data/imslp.json'), 'utf8'));
  const wikipedia = JSON.parse(await fs.readFile(path.join(ROOT, 'data/wikipedia.json'), 'utf8'));
  const out = { imslp: {}, wikipedia: {} };
  const counts = { imslpPages: 0, imslpYears: 0, wikipediaPages: 0, wikipediaYears: 0 };

  // ── IMSLP: page wikitext, 50 titles per request ──
  const ids = [...new Set((imslp.works ?? []).map((w) => w.id).filter(Boolean))].sort();
  process.stderr.write(`IMSLP: ${ids.length} pages\n`);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', format: 'json',
      titles: batch.map((t) => t.replace(/_/g, ' ')).join('|'),
    });
    const d = JSON.parse(await get(`${IMSLP_API}?${params}`) ?? '{}');
    const back = new Map((d?.query?.normalized ?? []).map((n) => [n.to, n.from]));
    for (const page of Object.values(d?.query?.pages ?? {})) {
      if (page.missing !== undefined) continue;
      counts.imslpPages++;
      const rev = page?.revisions?.[0];
      const year = imslpYear(rev?.slots?.main?.['*'] ?? rev?.['*'] ?? '');
      if (!year) continue;
      const id = (back.get(page.title) ?? page.title).replace(/ /g, '_');
      out.imslp[id] = year;
      counts.imslpYears++;
    }
    if ((i / 50) % 10 === 0) process.stderr.write(`  ${i + batch.length}/${ids.length}\n`);
  }

  // ── Wikipedia: raw wikitext per article, following one redirect ──
  const pages = [...new Set((wikipedia.works ?? []).map((w) => w.page).filter(Boolean))].sort();
  process.stderr.write(`Wikipedia: ${pages.length} articles\n`);
  const wikiPath = (t) => encodeURIComponent(String(t).replace(/ /g, '_'));
  for (const [n, page] of pages.entries()) {
    let text = await get(`${WIKI}/w/index.php?title=${wikiPath(page)}&action=raw`);
    const redirect = text && /^\s*#REDIRECT\s*\[\[([^\]|#]+)/i.exec(text);
    if (redirect) text = await get(`${WIKI}/w/index.php?title=${wikiPath(redirect[1].trim())}&action=raw`);
    if (!text) continue;
    counts.wikipediaPages++;
    const found = wikipediaYear(text);
    if (!found) continue;
    out.wikipedia[page] = found;
    counts.wikipediaYears++;
    if (n % 100 === 0) process.stderr.write(`  ${n}/${pages.length}\n`);
  }

  const payload = {
    generated: new Date().toISOString(),
    source: 'IMSLP |Year/Date of Composition= and English Wikipedia infoboxes / article leads',
    counts: { ...counts, calls },
    works: out,
  };
  const wrote = await writeIfChanged(OUT, payload);
  process.stderr.write(`${wrote ? 'Wrote' : 'Unchanged:'} ${path.relative(ROOT, OUT)} — ${JSON.stringify(counts)}\n`);
}
