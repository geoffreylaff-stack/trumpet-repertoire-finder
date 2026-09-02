#!/usr/bin/env node
/**
 * Merges the curated dataset with the harvested IMSLP dataset into the single
 * data/works.json the browser app loads, then emits a self-contained
 * dist/trumpet-finder.html with the data and code inlined.
 *
 * Curated entries win over harvested ones for the same work: IMSLP records
 * orchestral scoring as the single word "orchestra", which is exactly the
 * detail this app exists to supply.
 *
 * Usage: node tools/build.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { writeIfChanged } from './stable-json.mjs';
import { parseInstrumentation, formatScoring, requiredInstruments } from '../lib/instrumentation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...s) => path.join(ROOT, ...s);

const readJson = async (file, fallback = null) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fallback; }
};

const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Key for detecting that curated and IMSLP describe the same work. */
const workKey = (composerId, title) =>
  `${composerId}::${fold(title).replace(/\b(no|op|the|a|in|major|minor|for)\b/g, '').replace(/\s+/g, '')}`;

/**
 * Second key on the catalogue number. Titles drift between sources
 * ("Serenade for Winds" vs "Serenade for Wind Instruments") but "Op. 44" does
 * not, so this catches duplicates that the title key misses.
 */
const catKey = (composerId, catalogue) => {
  const c = fold(catalogue).replace(/\s+/g, '');
  return c ? `${composerId}::cat::${c}` : null;
};

/**
 * Third key, on numbered forms. Wikipedia titles a work "Symphony No. 9" where
 * the curated entry is "Symphony No. 9 in E minor, 'From the New World'" — no
 * amount of title normalisation makes those equal, but (symphony, 9) does.
 * The qualifier keeps "Piano Concerto No. 2" apart from "Violin Concerto No. 2".
 */
const formKey = (composerId, title) => {
  const m = /^(.*?)\b(symphony|symphonies|concerto|quartet|quintet|sonata|trio|octet|sextet|septet|serenade|suite|rhapsody|overture|mass)\b[\s,]*(?:no\.?\s*)?(\d+)/i
    .exec(fold(title));
  if (!m) return null;
  const qualifier = (m[1].trim().split(/\s+/).pop() || '').replace(/[^a-z]/g, '');
  return `${composerId}::form::${qualifier}-${m[2]}-${m[3]}`;
};

const curated = await readJson(p('data/curated.json'), { composers: {}, works: [] });
const wikipedia = await readJson(p('data/wikipedia.json'), { works: [] });
const imslp = await readJson(p('data/imslp.json'), { composers: [], works: [] });

const composers = new Map();
const byName = new Map(); // fold(display name) -> id
const works = [];
const seen = new Set();

/** "Sergei Rachmaninoff" -> "Rachmaninoff, Sergei" */
function toSortForm(name) {
  const parts = String(name).trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`;
}

const idFromSort = (sort) => fold(sort).replace(/\s+/g, '-');

/**
 * Resolve a composer across the three sources. Identity is matched on the
 * display name, not on a derived id: Wikipedia says "Pyotr Ilyich Tchaikovsky"
 * and IMSLP says "Tchaikovsky, Pyotr", which would otherwise become two people.
 */
function resolveComposer(name, extra = {}) {
  const key = fold(name);
  let id = byName.get(key) ?? extra.id;
  if (!id) id = idFromSort(extra.sort ?? toSortForm(name));

  if (!composers.has(id)) {
    // n counts original works only; arrangements are hidden by default, so
    // advertising them in the typeahead would promise more than the app shows.
    composers.set(id, {
      id, name, sort: extra.sort ?? toSortForm(name),
      dates: extra.dates ?? null, aliases: extra.aliases ?? [], n: 0, nArr: 0,
    });
  }
  byName.set(key, id);

  const c = composers.get(id);
  if (extra.dates && !c.dates) c.dates = extra.dates;
  if (extra.aliases) c.aliases = [...new Set([...c.aliases, ...extra.aliases])];
  return c;
}

// ── Curated ───────────────────────────────────────────────────────────────────
for (const [id, meta] of Object.entries(curated.composers ?? {})) {
  resolveComposer(meta.name, { id, dates: meta.dates, aliases: meta.aliases, sort: meta.sort });
}

for (const w of curated.works ?? []) {
  const parsed = parseInstrumentation(w.trumpets);
  if (!parsed.total) {
    process.stderr.write(`  ! curated work has no trumpet-family scoring: ${w.title}\n`);
    continue;
  }
  seen.add(workKey(w.c, w.title));
  for (const k of [catKey(w.c, w.cat), formKey(w.c, w.title)]) if (k) seen.add(k);
  works.push({
    c: w.c,
    t: w.title,
    cat: w.cat || null,
    y: w.year ?? null,
    g: w.genre || 'Other',
    s: formatScoring(parsed),
    counts: parsed.counts,
    req: requiredInstruments(parsed),
    full: w.full || null,
    note: w.note || null,
    arr: false,
    est: false,
    src: 'curated',
    url: null,
  });
  composers.get(w.c).n++;
}

// ── Wikipedia ─────────────────────────────────────────────────────────────────
// Ranked above IMSLP: for orchestral works IMSLP records only "orchestra",
// while the Wikipedia article gives the full wind complement.
/**
 * Works filed directly under "Compositions by X" have no subcategory to name
 * their genre, so the harvester defaults them to "Orchestral". The title is a
 * better witness than that default.
 */
function genreFromTitle(title, fallback) {
  const t = title.toLowerCase();
  if (/\bsymphon(y|ie|ia)\b/.test(t) && !/symphonic poem/.test(t)) return 'Symphony';
  if (/\bconcert(o|ino)\b/.test(t)) return 'Concerto';
  if (/\boverture\b/.test(t)) return 'Overture';
  if (/\b(sonata|quartet|quintet|trio|octet|sextet|septet|duo)\b/.test(t)) return 'Chamber';
  if (/\b(mass|requiem|te deum|oratorio|cantata|psalm)\b/.test(t)) return 'Sacred vocal';
  if (/\b(suite|serenade|divertimento)\b/.test(t)) return 'Suite';
  if (/\b(ballet|pas de deux)\b/.test(t)) return 'Ballet';
  if (/\b(opera|opéra)\b/.test(t)) return 'Opera';
  if (/\b(symphonic poem|tone poem)\b/.test(t)) return 'Tone poem';
  return fallback;
}

for (const w of wikipedia.works ?? []) {
  if (!w.composer || !w.scoring) continue;
  const c = resolveComposer(w.composer);

  // Article titles carry a disambiguator: "Symphony No. 2 (Rachmaninoff)".
  const title = w.page.replace(/\s*\([^()]*\)\s*$/, '').trim() || w.page;
  const key = workKey(c.id, title);
  const fk = formKey(c.id, title);
  if (seen.has(key) || (fk && seen.has(fk))) continue; // curated already covers it
  seen.add(key);
  if (fk) seen.add(fk);

  // Re-parse the stored source text when it is present, so a parser change
  // reaches the index through `npm run build` alone rather than requiring
  // another full sweep of 3,200 articles.
  //
  // Older snapshots captured text that ran past the scoring into the next
  // section, dragging in headings and external-link markup; cut that here so
  // the shipped index is clean without waiting on a re-harvest.
  // Heading level tells the two cases apart. A level-2 heading ("==Structure==")
  // means the article has left the scoring behind, so cut there. A deeper one
  // ("=== Band version ===") is a label *inside* the scoring, so keep the words
  // and drop only the markup.
  const tidy = (s) => {
    const moved = /(?<!=)==(?!=)/.exec(s);
    const body = moved && moved.index > 0 ? s.slice(0, moved.index) : s;
    return body
      .replace(/=+\s*([^=]*?)\s*=+/g, '$1, ')
      .replace(/\s+/g, ' ')
      .replace(/(?:\s*,\s*)+/g, ', ')
      .replace(/^[,\s]+|[,\s]+$/g, '')
      .trim();
  };
  const sourceText = w.text ? tidy(w.text) : null;
  const reparsed = sourceText ? parseInstrumentation(sourceText) : null;
  const usable = reparsed?.total > 0;

  works.push({
    c: c.id,
    t: title,
    cat: null,
    y: null,
    g: w.subcat ? (w.genre || 'Orchestral') : genreFromTitle(title, w.genre || 'Orchestral'),
    s: usable ? formatScoring(reparsed) : w.scoring,
    counts: usable ? reparsed.counts : w.counts,
    req: usable ? requiredInstruments(reparsed) : w.req,
    full: sourceText ? sourceText.slice(0, 400) : (w.full || null),
    note: null,
    arr: false,
    est: usable ? reparsed.uncertain.length > 0 : !!w.estimated,
    src: 'wikipedia',
    url: w.url,
  });
  c.n++;
}

// ── IMSLP ─────────────────────────────────────────────────────────────────────
for (const w of imslp.works ?? []) {
  if (!w.composerId || !w.composer) continue;
  const c = resolveComposer(w.composer, { id: w.composerId, sort: w.composerSort });

  const key = workKey(c.id, w.title);
  const ck = catKey(c.id, w.catalogue);
  const fk = formKey(c.id, w.title);
  if (seen.has(key) || (ck && seen.has(ck)) || (fk && seen.has(fk))) continue; // a better source already covers it
  seen.add(key);
  for (const k of [ck, fk]) if (k) seen.add(k);

  // Re-parse the source string so harvested rows share the app's current
  // formatting and doubling rules without needing a fresh harvest.
  const parsed = parseInstrumentation(w.full || '');
  const usable = parsed.total > 0;

  works.push({
    c: c.id,
    t: w.title,
    cat: w.catalogue || null,
    y: null,
    g: w.arrangement ? 'Arrangement' : 'Other',
    s: usable ? formatScoring(parsed) : w.scoring,
    counts: usable ? parsed.counts : w.counts,
    req: usable ? requiredInstruments(parsed) : Object.keys(w.counts || {}).filter((k) => w.counts[k] > 0),
    full: w.full || null,
    note: null,
    arr: !!w.arrangement,
    est: !!w.estimated,
    src: 'imslp',
    url: w.url,
  });
  if (w.arrangement) c.nArr++; else c.n++;
}

// Drop composers whose every entry is an arrangement or otherwise unshowable.
for (const [id, c] of composers) if (!c.n && !c.nArr) composers.delete(id);

// `src` and `url` drive the merge and the build-time checks below, but they
// name the upstream catalogues, so they are dropped from the shipped index
// rather than left for anyone reading the JSON or the network tab.
const shipped = works.map(({ src, url, ...rest }) => rest);

// Dated from when the data was harvested, not when the build ran: a rebuild
// that changes nothing must produce an identical index, or every CI run would
// mint a new build id and prompt every visitor to re-download 1.8 MB for
// nothing. The harvesters stamp their own output, and that timestamp travels
// in the file — file mtimes do not, since a fresh `git checkout` resets them
// all to the moment CI cloned the repository.
const harvestDates = [wikipedia.generated, imslp.generated]
  .filter(Boolean)
  .map((d) => Date.parse(d))
  .filter(Number.isFinite);
const dataDate = new Date(Math.max(...harvestDates, 0) || Date.now()).toISOString();

const payload = {
  generated: dataDate,
  stats: { works: works.length, composers: composers.size },
  composers: [...composers.values()].sort((a, b) => String(a.sort).localeCompare(String(b.sort))),
  works: shipped,
};

await fs.mkdir(p('data'), { recursive: true });
// If the works and composers are unchanged, keep the existing file exactly as
// it is — including its date — so the build id below stays put and no visitor
// is asked to re-download an index that has not changed.
await writeIfChanged(p('data/works.json'), payload);
const dataJson = await fs.readFile(p('data/works.json'), 'utf8');

// ── Cache busting and version stamping ────────────────────────────────────────
/*
 * GitHub Pages serves everything with `Cache-Control: max-age=600` and an ETag,
 * and offers no way to set headers. After ten minutes a returning visitor
 * revalidates and gets current files, so the usual case is already correct. Two
 * gaps are not:
 *
 *   1. Bare asset paths let a freshly revalidated index.html pair with an
 *      app.js still inside its ten-minute window — new markup, old code.
 *   2. Inside that window nothing revalidates at all, and the visitor has no
 *      way to tell which build they are looking at.
 *
 * So every asset gets a content hash in its query string, which makes a new
 * index.html incapable of loading old assets, and the build id is published
 * separately in data/version.json for the page to check against itself.
 */
const short = (text) => createHash('sha256').update(text).digest('hex').slice(0, 10);

// The lib is imported *by* app.js, so version it first and rewrite the import
// before hashing app.js — otherwise app.js's hash would not cover the change.
const libSrc = await fs.readFile(p('lib/instrumentation.mjs'), 'utf8');
const vLib = short(libSrc);

const appOriginal = await fs.readFile(p('assets/app.js'), 'utf8');
const appSrc = appOriginal.replace(
  /from '(\.\.\/lib\/instrumentation\.mjs)(?:\?v=[^']*)?'/,
  `from '$1?v=${vLib}'`,
);
if (appSrc !== appOriginal) await fs.writeFile(p('assets/app.js'), appSrc);

const cssSrc = await fs.readFile(p('assets/styles.css'), 'utf8');
const vApp = short(appSrc);
const vCss = short(cssSrc);
const vData = short(dataJson);
const build = short(vLib + vApp + vCss + vData);

let html = await fs.readFile(p('index.html'), 'utf8');
html = html
  .replace(/href="assets\/styles\.css(?:\?v=[^"]*)?"/, `href="assets/styles.css?v=${vCss}"`)
  .replace(/src="assets\/app\.js(?:\?v=[^"]*)?"/, `src="assets/app.js?v=${vApp}"`);

const buildInfo = '<script id="build-info">'
  + `window.__BUILD__=${JSON.stringify(build)};window.__DATA_V__=${JSON.stringify(vData)};`
  + '</script>';
html = /<script id="build-info">[\s\S]*?<\/script>/.test(html)
  ? html.replace(/<script id="build-info">[\s\S]*?<\/script>/, buildInfo)
  : html.replace(/(\n(\s*))<script type="module"/, `$1${buildInfo}$1<script type="module"`);
await fs.writeFile(p('index.html'), html);

// Deliberately tiny, and fetched with cache: 'no-store', so the check itself
// can never be answered from the cache it is meant to see past.
await fs.writeFile(p('data/version.json'), JSON.stringify({
  build,
  generated: payload.generated,
  works: payload.stats.works,
  composers: payload.stats.composers,
}));


/**
 * Plausibility report. An over-count from mis-read source text looks exactly
 * like a legitimate large section, so it never announced itself — "eight trumpets"
 * for Die ägyptische Helena sat in the index unflagged. Very large sections are
 * rare and real ones are famous (Handel's Fireworks, The Rite of Spring), so
 * listing them at build time makes a regression visible instead of silent.
 * Curated rows are hand-checked and exempt, and so are arrangements: a trumpet
 * ensemble transcription of a Mozart vocal canon really is twelve trumpets, so
 * flagging it would be noise rather than signal.
 *
 * The threshold is higher than the oboe index's five. Trumpet sections are
 * simply bigger — Mahler's Second reaches ten with its offstage band, Verdi's
 * Requiem eight, and a ceremonial fanfare for six is unremarkable — so five
 * here would cry wolf on a page of correct entries and the report would stop
 * being read.
 */
const SECTION_LIMIT = 6;
const implausible = works.filter((w) => {
  if (w.src === 'curated' || w.arr) return false;
  const total = Object.values(w.counts ?? {}).reduce((s, n) => s + (n || 0), 0);
  return total > SECTION_LIMIT;
});
if (implausible.length) {
  process.stderr.write(`\n  ${implausible.length} work(s) with more than ${SECTION_LIMIT} trumpet-family players — worth an eyeball:\n`);
  for (const w of implausible.slice(0, 20)) {
    process.stderr.write(`    ${w.s}  —  ${w.t} (${w.src})\n`);
  }
}

// ── Self-contained single-file build ──────────────────────────────────────────
const inlined = html
  .replace(/<link rel="stylesheet" href="assets\/styles\.css[^"]*" \/>/, `<style>\n${cssSrc}\n</style>`)
  .replace(
    /<script type="module" src="assets\/app\.js[^"]*"><\/script>/,
    `<script type="module">\n${libSrc.replace(/^export /gm, '')}\n` +
    `window.__WORKS_DATA__ = ${dataJson};\n` +
    `${appSrc.replace(/^import[\s\S]*?from '[^']*';\n/m, '')}\n</script>`
  );

await fs.mkdir(p('dist'), { recursive: true });
await fs.writeFile(p('dist/trumpet-finder.html'), inlined);

// Printed because `src` is stripped from the shipped index, so this breakdown
// is otherwise unrecoverable from data/works.json alone.
const bySource = works.reduce((acc, w) => ({ ...acc, [w.src]: (acc[w.src] ?? 0) + 1 }), {});
process.stderr.write(`  by source: ${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ')}\n`);

const kb = (s) => `${Math.round(s / 1024)} KB`;
process.stderr.write(
  `Built data/works.json — ${payload.stats.works} works, ${payload.stats.composers} composers ` +
  `(${kb(Buffer.byteLength(JSON.stringify(payload)))})\n` +
  `Built dist/trumpet-finder.html — ${kb(Buffer.byteLength(inlined))} standalone\n`
);
