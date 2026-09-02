#!/usr/bin/env node
/**
 * Harvests instrumentation from English Wikipedia into data/wikipedia.json.
 *
 * IMSLP is public-domain-weighted, so composers who died recently — Rachmaninoff,
 * Stravinsky, Shostakovich, Britten — are thin or absent there, and for orchestral
 * works IMSLP records the scoring as the single word "orchestra". Wikipedia
 * articles on individual works usually carry an "Instrumentation" section giving
 * the full wind complement, which is exactly the missing detail.
 *
 * Transport note: api.php rate-limits this network path hard (429 within a
 * handful of requests, even at one request per 1.2s — it is a shared address,
 * not our pace). The CDN-cached paths are not throttled at all, so this reads
 * article text from index.php?action=raw and category membership from the
 * rendered category page. Measured: 0 throttles in 10 raw fetches vs 8 in 10
 * REST fetches.
 *
 * Usage:
 *   node tools/harvest-wikipedia.mjs
 *   node tools/harvest-wikipedia.mjs --resume
 *   node tools/harvest-wikipedia.mjs --only "Sergei Rachmaninoff"
 *   node tools/harvest-wikipedia.mjs --pages "The Rite of Spring|Boléro"   # debug
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseInstrumentation, formatScoring, requiredInstruments, mentionsFamily,
} from '../lib/instrumentation.mjs';
import { writeIfChanged } from './stable-json.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = 'https://en.wikipedia.org';
const UA = 'TrumpetRepertoireFinder/1.1 (static site build step; contact via repo issues)';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const OUT = path.resolve(ROOT, flag('--out', 'data/wikipedia.json'));
const ONLY = flag('--only', null);
const PAGES = flag('--pages', null);
const GAP = Number(flag('--gap', '120'));
const MAX_ARTICLES = Number(flag('--max-articles', '250'));

/**
 * Composers to sweep, most-wanted first: the run saves after every composer and
 * can resume, so an interrupted sweep still leaves the valuable names done.
 */
const COMPOSERS = [
  'Sergei Rachmaninoff', 'Igor Stravinsky', 'Dmitri Shostakovich', 'Sergei Prokofiev',
  'Gustav Mahler', 'Richard Strauss', 'Maurice Ravel', 'Claude Debussy',
  'Jean Sibelius', 'Béla Bartók', 'Benjamin Britten', 'Aaron Copland',
  'Pyotr Ilyich Tchaikovsky', 'Antonín Dvořák', 'Johannes Brahms', 'Hector Berlioz',
  'Nikolai Rimsky-Korsakov', 'Ottorino Respighi', 'Gustav Holst', 'Ralph Vaughan Williams',
  'Edward Elgar', 'César Franck', 'Camille Saint-Saëns', 'Georges Bizet',
  'Samuel Barber', 'Leonard Bernstein', 'George Gershwin', 'Paul Hindemith',
  'Francis Poulenc', 'Darius Milhaud', 'Carl Nielsen', 'Edvard Grieg',
  'Leoš Janáček', 'Bohuslav Martinů', 'Zoltán Kodály', 'Anton Bruckner',
  'Richard Wagner', 'Robert Schumann', 'Felix Mendelssohn', 'Franz Schubert',
  'Ludwig van Beethoven', 'Wolfgang Amadeus Mozart', 'Joseph Haydn',
  'Giacomo Puccini', 'Giuseppe Verdi', 'Modest Mussorgsky', 'Alexander Borodin',
  'Alexander Glazunov', 'Alexander Scriabin', 'Aram Khachaturian',
  'Bedřich Smetana', 'Franz Liszt', 'Gabriel Fauré', 'Paul Dukas',
  'Vincent d\'Indy', 'Ernest Chausson', 'Frederick Delius', 'William Walton',
  'Michael Tippett', 'Malcolm Arnold', 'Arnold Bax', 'Gerald Finzi',
  'Arnold Schoenberg', 'Alban Berg', 'Anton Webern', 'Alexander Zemlinsky',
  'Erich Wolfgang Korngold', 'Kurt Weill', 'Olivier Messiaen', 'Erik Satie',
  'Charles Ives', 'Howard Hanson', 'Walter Piston', 'Ferde Grofé',
  'John Adams', 'Philip Glass',
  'Witold Lutosławski', 'Krzysztof Penderecki', 'György Ligeti', 'Arvo Pärt',
  'Toru Takemitsu', 'Ernest Bloch', 'George Enescu', 'Manuel de Falla',
  'Joaquín Rodrigo', 'Heitor Villa-Lobos', 'Carl Orff', 'Igor Markevitch',
  // Added for this family: composers whose catalogues are weighted towards
  // trumpet, cornet and band repertoire, which the orchestral list above
  // covers only incidentally. Names without a compositions category on
  // Wikipedia simply return nothing and cost one request.
  'Antonio Vivaldi', 'Georg Philipp Telemann', 'Giuseppe Torelli',
  'Johann Nepomuk Hummel', 'Alexander Arutiunian', 'Henri Tomasi',
  'André Jolivet', 'Alan Hovhaness', 'Reinhold Glière', 'Dmitri Kabalevsky',
  'Nikolai Myaskovsky', 'John Philip Sousa', 'Percy Grainger',
  'Vincent Persichetti', 'Morton Gould', 'Roy Harris', 'Eric Ewazen',
];

/** Subcategories that hold other people's work, or no works at all. */
const SKIP_SUBCAT = /^(Recordings|Ballets to the music|Lists|Compositions? by year|Albums|Songs with)/i;
const SKIP_ARTICLE = /^(List of|Discography|Category:|Template:|Portal:|File:)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function get(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 404) return null;
    if (res.status === 429 || res.status === 503) {
      if (attempt >= 6) return null;
      const header = Number(res.headers.get('retry-after'));
      await sleep(Math.max(Number.isFinite(header) && header > 0 ? header * 1000 : 0, 1500 * 2 ** attempt));
      return get(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    calls++;
    await sleep(GAP);
    return await res.text();
  } catch (err) {
    if (attempt >= 4) throw err;
    await sleep(700 * 2 ** attempt);
    return get(url, attempt + 1);
  }
}

const wikiPath = (title) => encodeURIComponent(String(title).replace(/ /g, '_'));

/** Raw wikitext, following a single redirect hop. */
async function rawWikitext(title, followed = false) {
  const text = await get(`${WIKI}/w/index.php?title=${wikiPath(title)}&action=raw`);
  if (!text) return null;
  const redirect = /^\s*#REDIRECT\s*\[\[([^\]|#]+)/i.exec(text);
  if (redirect && !followed) return rawWikitext(redirect[1].trim(), true);
  return text;
}

/** Category membership, scraped from the rendered (cached) category page. */
async function categoryMembers(category) {
  const subcats = [];
  const pages = [];
  let url = `${WIKI}/wiki/${wikiPath(category)}`;

  for (let page = 0; page < 8 && url; page++) {
    const html = await get(url);
    if (!html) break;

    const slice = (startId, endId) => {
      const i = html.indexOf(`id="${startId}"`);
      if (i < 0) return '';
      const j = endId ? html.indexOf(`id="${endId}"`, i) : -1;
      return html.slice(i, j > 0 ? j : undefined);
    };
    const links = (chunk) => [...chunk.matchAll(/<a href="\/wiki\/([^"#]+)" title="([^"]+)"/g)].map((m) => m[2]);

    for (const t of links(slice('mw-subcategories', 'mw-pages'))) {
      if (t.startsWith('Category:')) subcats.push(t);
    }
    for (const t of links(slice('mw-pages', 'catlinks'))) {
      if (!t.includes(':')) pages.push(t);
    }

    // "next page" link when a category holds more than 200 entries.
    const next = /<a href="([^"]*?)"[^>]*>next page<\/a>/i.exec(html);
    url = next ? WIKI + next[1].replace(/&amp;/g, '&') : null;
  }
  return { subcats: [...new Set(subcats)], pages: [...new Set(pages)] };
}

// ── Wikitext cleaning ─────────────────────────────────────────────────────────
/** Strip markup down to something the instrumentation parser can read. */
export function cleanWikitext(input) {
  let t = String(input);
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<ref[^>]*\/>/gi, '');
  t = t.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  // Templates, innermost first. Most are decoration ({{music|flat}}, {{cite}})
  // and simply go, but some carry the instrument itself — Lutosławski's Second
  // lists "{{Hanging indent |text=3 [[trumpets]] ...}}" — so those are unwrapped
  // rather than deleted.
  const UNWRAP = /^(nowrap|nobr|small|plainlist|hanging indent|lang|nolink)$/i;
  for (let i = 0; i < 10 && /\{\{/.test(t); i++) {
    t = t.replace(/\{\{([^{}]*)\}\}/g, (_, body) => {
      const named = /(?:^|\|)\s*text\s*=\s*([\s\S]*)$/i.exec(body);
      if (named) return ` ${named[1]} `;
      const [name, ...rest] = body.split('|');
      if (UNWRAP.test(name.trim())) return ` ${rest.join(' ')} `;
      return ' ';
    });
  }
  // Wikitables: strip the scaffolding but keep the cells. Deleting whole tables
  // loses the scoring outright for articles that lay it out as a grid
  // (Copland's Billy the Kid), while leaving the markup lets it crowd out the
  // instrument list further down (Tchaikovsky's Sixth).
  t = t.replace(/^\s*\{\|[^\n]*$/gm, ' ')     // opening, with its attributes
    .replace(/^\s*\|\}[^\n]*$/gm, ' ')        // closing
    .replace(/^\s*\|-[^\n]*$/gm, ' ')         // row separator
    .replace(/^\s*\|\+[^\n]*$/gm, ' ')        // caption
    .replace(/\|\||!!/g, '\n')                // inline cell separators
    .replace(/^\s*[|!]\s*(?:[a-zA-Z-]+\s*=\s*"[^"]*"\s*\|)?\s*/gm, '');  // cell prefix
  t = t.replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1');   // [[target|shown]] -> shown
  t = t.replace(/\[\[([^\]]*)\]\]/g, '$1');            // [[trumpet]]      -> trumpet
  t = t.replace(/\[https?:\/\/\S+\s([^\]]*)\]/g, '$1');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/'''?/g, '');
  t = t.replace(/&nbsp;/g, ' ');
  return t;
}

/**
 * Wikipedia writes instrumentation either as prose ("scored for 2 trumpets, 2
 * cornets…") or one instrument per line (":4 trumpets"). Flatten both to a single
 * comma-separated string.
 */
function flattenSection(text) {
  const parts = [];
  for (const raw of cleanWikitext(text).split('\n')) {
    let line = raw.replace(/^[:*#;]+\s*/, '').trim();
    if (!line || /^(and|or)$/i.test(line)) continue;
    parts.push(line.replace(/[;.]$/, ''));
  }
  return parts.join(', ').replace(/\s+/g, ' ').replace(/,\s*,/g, ',').trim();
}

/** Locate the instrumentation section, bounded by the next same-or-higher heading. */
function instrumentationSection(wikitext) {
  const headings = [...wikitext.matchAll(/^(={2,6})\s*([^=\n]+?)\s*\1\s*$/gm)]
    .map((m) => ({ level: m[1].length, title: m[2].trim(), start: m.index, end: m.index + m[0].length }));

  const wanted = /^(instrumentation|scoring|orchestration|instrumentation and scoring|forces|instruments)\b/i;
  for (let i = 0; i < headings.length; i++) {
    if (!wanted.test(headings[i].title)) continue;
    let stop = wikitext.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= headings[i].level) { stop = headings[j].start; break; }
    }
    return { text: wikitext.slice(headings[i].end, stop), how: 'section' };
  }

  // Fallback: many articles state the scoring in a sentence instead of a
  // section — Boléro is "written for a large orchestra consisting of:".
  const verbs = /\b(?:scored|orchestrated|written|composed|arranged)\s+for\b|\bcalls\s+for\b|\bconsisting\s+of\b/gi;
  let fallback = null;
  for (const m of wikitext.matchAll(verbs)) {
    // Stop at the next heading as well as at the window size: without this the
    // capture runs on into ==References== and the external-link templates.
    const raw = wikitext.slice(m.index, m.index + 900);
    const heading = /\n\s*==/.exec(raw);
    const window = heading ? raw.slice(0, heading.index) : raw;
    // Guard against ordinary prose ("written for Diaghilev"): a real scoring
    // list names several other orchestral instruments alongside the trumpets.
    // Every corroborating word is from outside this family, so a passage can
    // never vouch for itself — "trumpet" appearing three times proves nothing.
    // "horn" is safe here: \b will not match the tail of "flugelhorn".
    const corroborating = ['flute', 'oboe', 'clarinet', 'bassoon', 'horn', 'trombone', 'timpani', 'strings', 'harp', 'viola']
      .filter((w) => new RegExp(`\\b${w}`, 'i').test(window)).length;
    if (corroborating < 3 || !mentionsFamily(window)) continue;
    // Prefer a window that still names a trumpet once trimmed to its opening
    // sentence: that is a real scoring sentence rather than narrative which
    // happens to mention trumpets further down ("...composed for Paris").
    if (mentionsFamily(boundToSentence(flattenSection(window)))) {
      return { text: window, how: 'prose' };
    }
    // Otherwise remember it. Some articles genuinely spread the scoring over
    // more than one sentence, and half an answer beats dropping the work.
    fallback ??= window;
  }
  return fallback ? { text: fallback, how: 'prose-unbounded' } : null;
}

/**
 * A scoring sentence ends where the article resumes talking about the music
 * ("...and strings. The trumpets are silent until the finale."). Without
 * this cut the narrative gets parsed as if it were part of the instrumentation.
 * Digits are excluded from the look-ahead so "Op. 35" and "No. 2" survive.
 */
function boundToSentence(flat) {
  const m = /\.\s+(?=[A-Z])/.exec(flat);
  return m ? flat.slice(0, m.index) : flat;
}

/** "Symphonies by Jean Sibelius" -> "Symphony" */
function genreFrom(subcat) {
  if (!subcat) return 'Orchestral';
  const n = subcat.replace(/^Category:/, '').replace(/\s+by\s+.*$/i, '').trim();
  const map = {
    Symphonies: 'Symphony', Operas: 'Opera', Ballets: 'Ballet', Concertos: 'Concerto',
    'Symphonic poems': 'Tone poem', 'Chamber music': 'Chamber',
    'Choral compositions': 'Choral', 'Orchestral compositions': 'Orchestral',
    'Piano music': 'Piano', 'Piano compositions': 'Piano', Overtures: 'Overture',
    Masses: 'Sacred vocal', Requiems: 'Sacred vocal', 'Song cycles': 'Vocal',
    'Film scores': 'Film score', Suites: 'Suite', Marches: 'March',
    'Incidental music': 'Incidental music', Cantatas: 'Choral',
  };
  return map[n] ?? 'Orchestral';
}

// ── Harvest ───────────────────────────────────────────────────────────────────
const records = [];
const stats = { articles: 0, withSection: 0, withFamily: 0, skipped: 0 };

/** Article titles for one composer, mapped to the subcategory they came from. */
async function articlesOf(composer) {
  const found = new Map();
  const root = await categoryMembers(`Category:Compositions by ${composer}`);
  if (!root.pages.length && !root.subcats.length) return found;

  for (const t of root.pages) if (!SKIP_ARTICLE.test(t)) found.set(t, null);

  for (const sub of root.subcats) {
    if (SKIP_SUBCAT.test(sub.replace(/^Category:/, ''))) continue;
    try {
      const inner = await categoryMembers(sub);
      for (const t of inner.pages) if (!SKIP_ARTICLE.test(t) && !found.has(t)) found.set(t, sub);
    } catch { /* one bad subcategory shouldn't sink the composer */ }
    if (found.size >= MAX_ARTICLES) break;
  }
  return found;
}

async function readArticle(title, subcat) {
  stats.articles++;
  let text;
  try { text = await rawWikitext(title); } catch { stats.skipped++; return; }
  if (!text) { stats.skipped++; return; }

  const section = instrumentationSection(text);
  if (!section) { stats.skipped++; return; }
  stats.withSection++;

  let flat = flattenSection(section.text);
  // Sections are lists and legitimately span many lines; only the prose
  // fallback runs on into commentary, so only it gets cut at the sentence.
  if (section.how === 'prose') flat = boundToSentence(flat);  // 'prose-unbounded' keeps its full window
  // Generous cap: sections can carry a paragraph of preamble before the list,
  // and truncating mid-section silently loses the instruments entirely.
  flat = flat.slice(0, 4000);
  if (!mentionsFamily(flat)) return;

  const parsed = parseInstrumentation(flat);
  if (!parsed.total) return;
  stats.withFamily++;

  records.push({
    page: title,
    subcat,
    scoring: formatScoring(parsed),
    counts: parsed.counts,
    req: requiredInstruments(parsed),
    // `text` is what the parser saw, kept whole so a future parser change can
    // be replayed without re-fetching 3,200 articles; `full` is for display.
    text: flat,
    full: flat.length > 400 ? `${flat.slice(0, 397)}…` : flat,
    estimated: parsed.uncertain.length > 0,
    how: section.how,
    url: `${WIKI}/wiki/${wikiPath(title)}`,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
if (PAGES) {
  for (const t of PAGES.split('|')) await readArticle(t.trim(), null);
  for (const r of records) {
    process.stderr.write(`${r.page}\n   ${r.scoring}   [${r.how}]\n   ${r.full.slice(0, 200)}\n\n`);
  }
  process.stderr.write(`${JSON.stringify(stats)}\n`);
} else {
  const targets = ONLY ? [ONLY] : COMPOSERS;
  const done = new Set();

  if (args.includes('--resume')) {
    const prior = JSON.parse(await fs.readFile(OUT, 'utf8').catch(() => 'null'));
    for (const r of prior?.works ?? []) { records.push(r); done.add(r.composer); }
    if (done.size) process.stderr.write(`Resuming: ${done.size} composers already harvested\n`);
  }

  const save = async () => {
    await fs.mkdir(path.dirname(OUT), { recursive: true });
    // Leaves the file untouched when the harvest found the same works, so an
    // unchanged month does not churn timestamps through the whole build.
    return writeIfChanged(OUT, {
      generated: new Date().toISOString(),
      source: 'English Wikipedia (en.wikipedia.org)',
      license: 'Text from Wikipedia, CC BY-SA 4.0.',
      counts: { ...stats, works: records.length, apiCalls: calls },
      works: records,
    });
  };

  for (const composer of targets) {
    if (done.has(composer)) continue;
    const before = records.length;
    try {
      const entries = await articlesOf(composer);
      if (!entries.size) { process.stderr.write(`  —  ${composer}: no category\n`); continue; }
      for (const [title, subcat] of entries) await readArticle(title, subcat);
      for (let i = before; i < records.length; i++) {
        records[i].composer = composer;
        records[i].genre = genreFrom(records[i].subcat);
      }
      process.stderr.write(`  ${String(records.length - before).padStart(3)}  ${composer}  (${entries.size} articles)\n`);
    } catch (err) {
      process.stderr.write(`  !   ${composer}: ${err.message} (rerun with --resume)\n`);
    }
    await save();
  }

  const wrote = await save();
  if (!wrote) process.stderr.write('  unchanged since the last harvest; file left as it was\n');
  process.stderr.write(
    `\nWrote ${OUT}\n  ${records.length} works with trumpet-family scoring\n` +
    `  ${stats.articles} articles read, ${stats.withSection} had an instrumentation section, ${calls} requests\n`);
}
