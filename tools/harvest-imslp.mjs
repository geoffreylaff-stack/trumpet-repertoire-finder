#!/usr/bin/env node
/**
 * Harvests trumpet-family repertoire from IMSLP into data/imslp.json.
 *
 * This runs at BUILD time, never in the user's browser: IMSLP serves no
 * Access-Control-Allow-Origin header, so a page fetching it directly would be
 * blocked by CORS. Shipping a pre-built JSON file also makes the app instant
 * and keeps it working when IMSLP is down.
 *
 * Two passes, because IMSLP stores instrumentation in two different places:
 *
 *   Pass A — category names. Chamber and ensemble works are filed under
 *            categories whose name IS the exact scoring, e.g.
 *            "For 2 trumpets, cornet, trombone". Cheap and precise.
 *
 *   Pass B — the |Instrumentation= field in each page's wikitext, batched 50
 *            titles at a time. Catches works whose category is coarse.
 *
 * Usage: node tools/harvest-imslp.mjs [--limit N] [--out data/imslp.json]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseInstrumentation, formatScoring, mentionsFamily, fromCategoryName,
} from '../lib/instrumentation.mjs';
import { writeIfChanged } from './stable-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://imslp.org/api.php';
const UA = 'TrumpetRepertoireFinder/1.0 (static site build step; contact via repo issues)';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const OUT = path.resolve(ROOT, flag('--out', 'data/imslp.json'));
const LIMIT = parseInt(flag('--limit', '0'), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function api(params, attempt = 0) {
  const url = `${API}?${new URLSearchParams({ ...params, format: 'json' })}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    calls++;
    if (calls % 25 === 0) process.stderr.write(`    …${calls} API calls\n`);
    await sleep(120); // be a good citizen
    return await res.json();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(1000 * 2 ** attempt);
    return api(params, attempt + 1);
  }
}

/** IMSLP page titles look like "Work Title (Composer, Forename)". */
function splitTitle(pageTitle) {
  const m = /^(.*)\s+\(([^()]*)\)\s*$/.exec(pageTitle);
  if (!m) return { title: pageTitle.trim(), composerSort: null };
  const inner = m[2].trim();
  // "Various" and non-composer parentheticals are not composers.
  if (!inner.includes(',') && !/^(Various|Anonymous|Traditional)$/i.test(inner)) {
    return { title: pageTitle.trim(), composerSort: null };
  }
  return { title: m[1].trim(), composerSort: inner };
}

function composerId(sort) {
  return String(sort).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function displayComposer(sort) {
  if (!sort) return null;
  const parts = sort.split(',').map((s) => s.trim());
  if (parts.length < 2) return sort;
  return `${parts.slice(1).join(', ')} ${parts[0]}`.trim();
}

/** Pull "Op.125" / "BWV 1060" / "K.370" out of a work title. */
function extractCatalogue(title) {
  const m = /[,\s]((?:Op|BWV|KV?|Hob|D|RV|TWV|WoO|WAB|H|S|FP|MWV|BB|Wq|HWV|Sz|B|JW|Anh)\.?\s?[\dIVX][\d./a-zA-Z-]*(?:\s+No\.?\s?[\d/a-z-]+)?(?:\s*[ab])?)\s*$/.exec(title);
  if (!m) return { title, catalogue: null };
  return { title: title.slice(0, m.index).replace(/[,\s]+$/, ''), catalogue: m[1].trim() };
}

// ── Pass A ────────────────────────────────────────────────────────────────────
async function passA() {
  process.stderr.write('Pass A: scanning "For …" category names\n');
  const matching = [];
  let from;
  for (;;) {
    const params = { action: 'query', list: 'allcategories', acprefix: 'For ', aclimit: '500', acprop: 'size' };
    if (from) params.acfrom = from;
    const d = await api(params);
    const cats = d?.query?.allcategories ?? [];
    if (!cats.length) break;

    for (const c of cats) {
      const name = c['*'];
      // IMSLP's category list carries junk from bot probing; require sane names.
      if (!name || name.length > 160 || /[<>{}|]|&\w+=|--|\/\*/.test(name)) continue;
      if ((c.pages ?? 0) < 1) continue;
      if (!mentionsFamily(name)) continue;
      matching.push({ name, pages: c.pages });
    }
    from = d?.['query-continue']?.allcategories?.acfrom ?? d?.continue?.accontinue;
    if (!from) break;
    if (LIMIT && matching.length >= LIMIT) break;
  }
  process.stderr.write(`  ${matching.length} trumpet-family categories\n`);

  const works = [];
  for (const cat of matching) {
    let cmcontinue;
    for (;;) {
      const params = {
        action: 'query', list: 'categorymembers', cmtitle: `Category:${cat.name}`,
        cmlimit: '500', cmnamespace: '0',
      };
      if (cmcontinue) params.cmcontinue = cmcontinue;
      const d = await api(params);
      for (const m of d?.query?.categorymembers ?? []) {
        works.push({ page: m.title, category: cat.name });
      }
      cmcontinue = d?.['query-continue']?.categorymembers?.cmcontinue ?? d?.continue?.cmcontinue;
      if (!cmcontinue) break;
    }
  }
  process.stderr.write(`  ${works.length} category memberships\n`);
  return works;
}

// ── Pass B ────────────────────────────────────────────────────────────────────
async function membersOf(category) {
  const out = [];
  let cmcontinue;
  for (;;) {
    const params = {
      action: 'query', list: 'categorymembers', cmtitle: `Category:${category}`,
      cmlimit: '500', cmnamespace: '0',
    };
    if (cmcontinue) params.cmcontinue = cmcontinue;
    const d = await api(params);
    for (const m of d?.query?.categorymembers ?? []) out.push(m.title);
    cmcontinue = d?.['query-continue']?.categorymembers?.cmcontinue ?? d?.continue?.cmcontinue;
    if (!cmcontinue) break;
  }
  return out;
}

async function passB(titles) {
  process.stderr.write(`Pass B: reading |Instrumentation= for ${titles.length} pages\n`);
  const found = new Map();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const d = await api({
      action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main',
      titles: batch.join('|'),
    });
    for (const page of Object.values(d?.query?.pages ?? {})) {
      const rev = page?.revisions?.[0];
      const text = rev?.slots?.main?.['*'] ?? rev?.['*'];
      if (!text) continue;
      const m = /\|\s*Instrumentation\s*=\s*([^\n|}]*)/i.exec(text);
      if (!m) continue;
      const value = m[1].trim();
      if (value) found.set(page.title, value);
    }
  }
  process.stderr.write(`  ${found.size} instrumentation fields\n`);
  return found;
}

// ── Merge ─────────────────────────────────────────────────────────────────────
function buildRecords(categoryHits, instrumentationByPage) {
  const byPage = new Map();

  const ensure = (page) => {
    if (!byPage.has(page)) {
      const { title: rawTitle, composerSort } = splitTitle(page);
      const { title, catalogue } = extractCatalogue(rawTitle);
      byPage.set(page, {
        page, title, catalogue,
        composerSort, composer: displayComposer(composerSort),
        composerId: composerSort ? composerId(composerSort) : null,
        candidates: [],
      });
    }
    return byPage.get(page);
  };

  for (const hit of categoryHits) {
    const { text, arrangement } = fromCategoryName(hit.category);
    const parsed = parseInstrumentation(text);
    if (!parsed.total) continue;
    ensure(hit.page).candidates.push({
      source: 'imslp-category', raw: text, arrangement, parsed,
      specificity: 2 - (arrangement ? 1 : 0),
    });
  }

  for (const [page, raw] of instrumentationByPage) {
    const parsed = parseInstrumentation(raw);
    if (!parsed.total) continue;
    ensure(page).candidates.push({
      source: 'imslp-instrumentation', raw, arrangement: false, parsed, specificity: 1.5,
    });
  }

  const records = [];
  for (const rec of byPage.values()) {
    if (!rec.candidates.length) continue;
    // Prefer original scorings over arrangements, then richer detail.
    rec.candidates.sort((a, b) =>
      b.specificity - a.specificity ||
      b.parsed.present.length - a.parsed.present.length ||
      b.parsed.total - a.parsed.total);
    const best = rec.candidates[0];
    const alternates = rec.candidates.slice(1)
      .filter((c) => c.raw !== best.raw)
      .slice(0, 4)
      .map((c) => ({ scoring: formatScoring(c.parsed), full: c.raw, arrangement: c.arrangement }));

    records.push({
      id: rec.page.replace(/\s+/g, '_'),
      title: rec.title,
      catalogue: rec.catalogue,
      composer: rec.composer,
      composerSort: rec.composerSort,
      composerId: rec.composerId,
      scoring: formatScoring(best.parsed),
      counts: best.parsed.counts,
      full: best.raw,
      arrangement: best.arrangement,
      estimated: best.parsed.uncertain.length > 0,
      alternates,
      source: best.source,
      url: `https://imslp.org/wiki/${encodeURIComponent(rec.page.replace(/\s+/g, '_'))}`,
    });
  }

  records.sort((a, b) =>
    (a.composerSort || 'zz').localeCompare(b.composerSort || 'zz') ||
    a.title.localeCompare(b.title));
  return records;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const categoryHits = await passA();

const featureCategories = [
  'Scores featuring the trumpet',
  'Scores featuring the cornet',
  'Scores featuring the flugelhorn',
];
const featurePages = new Set();
for (const cat of featureCategories) {
  try {
    for (const t of await membersOf(cat)) featurePages.add(t);
  } catch (err) {
    process.stderr.write(`  ! skipped "${cat}": ${err.message}\n`);
  }
}
for (const hit of categoryHits) featurePages.add(hit.page);

let pageList = [...featurePages];
if (LIMIT) pageList = pageList.slice(0, LIMIT);
const instrumentation = await passB(pageList);

const works = buildRecords(categoryHits, instrumentation);
const composers = new Map();
for (const w of works) {
  if (!w.composerId) continue;
  if (!composers.has(w.composerId)) {
    composers.set(w.composerId, { id: w.composerId, name: w.composer, sort: w.composerSort, works: 0 });
  }
  composers.get(w.composerId).works++;
}

await fs.mkdir(path.dirname(OUT), { recursive: true });
const wrote = await writeIfChanged(OUT, {
  generated: new Date().toISOString(),
  source: 'IMSLP / Petrucci Music Library (imslp.org)',
  license: 'Work metadata from IMSLP, which publishes catalogue data under CC-BY-SA.',
  counts: { works: works.length, composers: composers.size, apiCalls: calls },
  composers: [...composers.values()].sort((a, b) => a.sort.localeCompare(b.sort)),
  works,
});
if (!wrote) process.stderr.write('  unchanged since the last harvest; file left as it was\n');

process.stderr.write(`\nWrote ${OUT}\n  ${works.length} works, ${composers.size} composers, ${calls} API calls\n`);
