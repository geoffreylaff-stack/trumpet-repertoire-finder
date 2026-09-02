import { FAMILY, FAMILY_KEYS } from '../lib/instrumentation.mjs?v=c41317dcba';

/**
 * All searching happens against an index that ships with the page, so the app
 * works offline, needs no server beyond static file hosting, and never sends
 * the user's query anywhere.
 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    // Object.assign cannot set these: `dataset` is read-only, and a hyphenated
    // name like aria-pressed becomes a stray JS property instead of an attribute.
    if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.includes('-')) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};

const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Works rendered per batch when searching the whole catalogue. */
const CATALOGUE_PAGE = 150;

const state = {
  data: null,
  composer: null,
  mode: null,          // 'composer' | 'catalogue' | null (start screen)
  tab: 'composer',     // which workflow is on screen
  shown: CATALOGUE_PAGE,
  required: new Set(),
  explicit: new Set(), // ticked by hand, as opposed to implied by a quantity
  counts: {},          // instrument key -> 'any' | 'eqN' | 'geN'
  arrangements: false,
  estimated: true,
  group: true,
  sort: 'default',
};

/** id -> composer record, for naming works in catalogue-wide results. */
let composersById = new Map();
const composerOf = (id) => composersById.get(id);
const composerLabel = (id) => composerOf(id)?.name ?? 'Unknown';

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadData() {
  // The single-file build injects the index directly; the hosted build fetches it.
  if (window.__WORKS_DATA__) return window.__WORKS_DATA__;
  // The version marker makes a new index.html unable to reuse an old index.
  const v = window.__DATA_V__ ? `?v=${window.__DATA_V__}` : '';
  const res = await fetch(`data/works.json${v}`);
  if (!res.ok) throw new Error(`Could not load the work index (HTTP ${res.status}).`);
  return res.json();
}

// ── Composer matching ─────────────────────────────────────────────────────────
function indexComposers(composers) {
  return composers.map((c) => ({
    ...c,
    _folded: fold(c.name),
    _sortFolded: fold(c.sort),
    _surname: fold(String(c.sort).split(',')[0]),
    _aliases: (c.aliases ?? []).map(fold),
  }));
}

/** Ranked match: exact surname beats prefix beats substring. */
function matchComposers(query, limit = 8) {
  const q = fold(query);
  if (!q) return [];
  const scored = [];
  for (const c of state.data.composers) {
    let score = 0;
    if (c._surname === q || c._aliases.includes(q)) score = 100;
    else if (c._folded === q || c._sortFolded === q) score = 95;
    else if (c._surname.startsWith(q)) score = 80;
    else if (c._aliases.some((a) => a.startsWith(q))) score = 75;
    else if (c._folded.startsWith(q) || c._sortFolded.startsWith(q)) score = 70;
    else if (c._sortFolded.includes(q)) score = 40;
    else if (c._folded.includes(q)) score = 35;
    if (!score) continue;
    // Prefer composers we actually have a lot for; it is the better guess.
    scored.push({ c, score: score + Math.min(12, Math.log2(c.n + c.nArr + 1) * 2) });
  }
  scored.sort((a, b) => b.score - a.score || a.c._sortFolded.localeCompare(b.c._sortFolded));
  return scored.slice(0, limit).map((s) => s.c);
}

/** Levenshtein distance, iterative with a single rolling row. */
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Near-misses for a query that matched nothing. "Rachmaninov" and "Rachmaninoff"
 * are both in common use, and a dead end reads as "not in the index" when the
 * composer is right there under another spelling.
 */
function nearestComposers(query, limit = 5) {
  const q = fold(query);
  if (q.length < 3) return [];
  const tolerance = Math.max(2, Math.floor(q.length / 3));
  return state.data.composers
    .map((c) => ({ c, d: Math.min(editDistance(q, c._surname), editDistance(q, c._folded)) }))
    .filter((x) => x.d <= tolerance)
    .sort((a, b) => a.d - b.d || (b.c.n + b.c.nArr) - (a.c.n + a.c.nArr))
    .slice(0, limit)
    .map((x) => x.c);
}

// ── Filtering ─────────────────────────────────────────────────────────────────
/** Does the work call for this instrument, whether as its own part or a doubling? */
const needs = (w, key) => (w.req?.includes(key) ?? false) || (w.counts?.[key] ?? 0) > 0;

/**
 * How many of this instrument a work asks for. Printed parts where there are
 * any; otherwise one, when the instrument is reached only by a doubling. A
 * score with no separate flugelhorn part but a trumpeter told to pick one up
 * still needs a flugelhorn, so "exactly one flugelhorn" ought to find it.
 */
function instrumentCount(w, key) {
  const printed = w.counts?.[key] ?? 0;
  if (printed > 0) return printed;
  return needs(w, key) ? 1 : 0;
}

/** Count constraints offered per instrument, keyed by their URL token. */
const COUNT_OPTIONS = [
  ['any', 'any number'],
  ['eq0', 'none'],
  ['eq1', 'exactly 1'],
  ['eq2', 'exactly 2'],
  ['eq3', 'exactly 3'],
  ['eq4', 'exactly 4'],
  ['ge2', '2 or more'],
  ['ge3', '3 or more'],
  ['ge4', '4 or more'],
  ['ge5', '5 or more'],
];

/**
 * Does the work satisfy every instrument constraint at once?
 *
 * A selected instrument normally has to be present, optionally in a given
 * number. "none" reverses that for its instrument: the work must not call for it
 * at all. That cannot be expressed as a count on top of a presence test, so
 * presence and quantity are decided together here.
 */
function matchesInstruments(w) {
  for (const key of state.required) {
    const rule = state.counts[key];
    const n = instrumentCount(w, key);

    if (rule === 'eq0') {          // must not appear, doublings included
      if (n !== 0) return false;
      continue;
    }
    if (n === 0) return false;     // every other rule implies presence

    const m = rule && /^(eq|ge)(\d+)$/.exec(rule);
    if (!m) continue;
    if (m[1] === 'eq' ? n !== Number(m[2]) : n < Number(m[2])) return false;
  }
  return true;
}

/** "exactly two trumpets", "three or more trumpets", or just the instrument name. */
function describeRequirement(key) {
  const meta = FAMILY[key];
  const rule = state.counts[key];
  if (rule === 'eq0') return `no ${meta.label}`;
  const m = rule && /^(eq|ge)(\d+)$/.exec(rule);
  if (!m) return meta.label;
  const n = Number(m[2]);
  const word = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][n] ?? String(n);
  if (m[1] === 'eq') return n === 1 ? `exactly one ${meta.label}` : `exactly ${word} ${meta.plural}`;
  return `${word} or more ${meta.plural}`;
}

function worksFor(composerId) {
  let list = state.data.works.filter((w) => w.c === composerId);

  if (!state.arrangements) list = list.filter((w) => !w.arr);
  if (!state.estimated) list = list.filter((w) => !w.est);
  if (state.required.size) {
    // `req` counts doubled instruments too: a score where the third trumpet
    // picks up a flugelhorn has no separate flugelhorn part, but it
    // unquestionably needs a flugelhorn player.
    list = list.filter(matchesInstruments);
  }

  const sectionSize = (w) => FAMILY_KEYS.reduce((sum, k) => sum + (w.counts?.[k] ?? 0), 0);
  const cmpTitle = (a, b) => a.t.localeCompare(b.t);

  switch (state.sort) {
    case 'title': list.sort(cmpTitle); break;
    case 'year': list.sort((a, b) => (a.y ?? 9999) - (b.y ?? 9999) || cmpTitle(a, b)); break;
    case 'size': list.sort((a, b) => sectionSize(b) - sectionSize(a) || cmpTitle(a, b)); break;
    default: list.sort((a, b) => a.g.localeCompare(b.g) || (a.y ?? 9999) - (b.y ?? 9999) || cmpTitle(a, b));
  }
  return list;
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderWork(w) {
  const titleText = w.cat ? `${w.t}, ${w.cat}` : w.t;
  const title = document.createTextNode(titleText);

  const metaBits = [];
  if (w.y) metaBits.push(String(w.y));
  if (w.g && w.g !== 'Other') metaBits.push(w.g);

  const left = el('div', {},
    el('h3', { className: 'work-title' }, title,
      w.arr ? el('span', { className: 'badge', textContent: 'arrangement' }) : null),
    metaBits.length ? el('p', { className: 'work-meta', textContent: metaBits.join(' · ') }) : null,
    w.full ? el('p', { className: 'work-full', textContent: w.full }) : null,
    w.note ? el('p', { className: 'work-note', textContent: w.note }) : null,
  );

  const flags = [];
  if (w.est) flags.push('count inferred from a plural');

  const right = el('div', { className: 'scoring' },
    w.s || '—',
    flags.length ? el('span', { className: 'flags', textContent: flags.join(' · ') }) : null,
  );

  return el('article', { className: 'work' }, left, right);
}

function renderResults(composer, list) {
  const results = $('#results');
  results.replaceChildren();
  $('#intro').hidden = true;
  $('#filters').hidden = false;

  // Summary bar
  const summary = $('#summary');
  summary.hidden = false;
  const tally = FAMILY_KEYS
    .map((k) => {
      const n = list.filter((w) => needs(w, k)).length;
      return n ? `${n} with ${FAMILY[k].label}` : null;
    })
    .filter(Boolean)
    .join(' · ');

  summary.replaceChildren(
    el('h2', {}, composer.name,
      composer.dates ? el('span', { className: 'dates', textContent: ` (${composer.dates})` }) : null),
    el('span', { className: 'tally', textContent: `${list.length} work${list.length === 1 ? '' : 's'}${tally ? ` — ${tally}` : ''}` }),
    el('div', { className: 'actions' },
      el('button', {
        type: 'button',
        textContent: 'Copy list',
        onclick: () => copyList(`${composer.name} — works including trumpet / cornet`, list),
      }),
      el('button', {
        type: 'button',
        textContent: 'Download CSV',
        onclick: () => downloadCsv(list, `${fold(composer.name).replace(/ /g, '-')}-trumpet-works.csv`),
      }),
    ),
  );

  if (!list.length) {
    results.append(el('div', { className: 'empty' },
      el('p', {}, el('strong', { textContent: 'No works match those filters.' })),
      el('p', { className: 'muted', textContent: 'Try clearing the “must include” chips, or allow arrangements.' }),
    ));
    return;
  }

  if (!state.group || state.sort !== 'default') {
    results.append(...list.map(renderWork));
    return;
  }

  const byGenre = new Map();
  for (const w of list) {
    if (!byGenre.has(w.g)) byGenre.set(w.g, []);
    byGenre.get(w.g).push(w);
  }
  for (const [genre, items] of byGenre) {
    results.append(
      el('h2', { className: 'genre-heading', textContent: `${genre} (${items.length})` }),
      ...items.map(renderWork),
    );
  }
}

// ── Catalogue-wide search ─────────────────────────────────────────────────────
/** Every work matching the chosen instruments, regardless of composer. */
function catalogueMatches() {
  let list = state.data.works;
  if (!state.arrangements) list = list.filter((w) => !w.arr);
  if (!state.estimated) list = list.filter((w) => !w.est);
  // Several chips mean *all* of them: "trumpet + cornet" is an AND.
  if (state.required.size) {
    list = list.filter(matchesInstruments);
  } else {
    list = [...list];
  }

  const sectionSize = (w) => FAMILY_KEYS.reduce((s, k) => s + (w.counts?.[k] ?? 0), 0);
  const cmpTitle = (a, b) => a.t.localeCompare(b.t);
  const cmpComposer = (a, b) =>
    String(composerOf(a.c)?.sort ?? '').localeCompare(String(composerOf(b.c)?.sort ?? ''));

  switch (state.sort) {
    case 'title': list.sort((a, b) => cmpTitle(a, b) || cmpComposer(a, b)); break;
    case 'year': list.sort((a, b) => (a.y ?? 9999) - (b.y ?? 9999) || cmpComposer(a, b)); break;
    case 'size': list.sort((a, b) => sectionSize(b) - sectionSize(a) || cmpComposer(a, b)); break;
    default: list.sort((a, b) => cmpComposer(a, b) || cmpTitle(a, b));
  }
  return list;
}

const includedKeys = () => FAMILY_KEYS.filter((k) => state.required.has(k) && state.counts[k] !== 'eq0');
const excludedKeys = () => FAMILY_KEYS.filter((k) => state.required.has(k) && state.counts[k] === 'eq0');

/** "trumpet + cornet", or a plain description when nothing is selected. */
function requirementLabel() {
  if (!state.required.size) return 'any trumpet-family instrument';
  const inc = includedKeys().map(describeRequirement).join(' + ');
  const exc = excludedKeys().map((k) => FAMILY[k].label).join(' or ');
  if (inc && exc) return `${inc}, without ${exc}`;
  return inc || `no ${exc}`;
}

/** Headline for a catalogue search, phrased for whichever kinds are in play. */
function summaryHeading() {
  const inc = includedKeys();
  const exc = excludedKeys();
  if (!inc.length && !exc.length) return 'Works including any trumpet-family instrument';
  const without = exc.map((k) => FAMILY[k].label).join(' or ');
  if (!inc.length) return `Works without ${without}`;
  const base = `Works including ${inc.map(describeRequirement).join(' + ')}`;
  return exc.length ? `${base}, without ${without}` : base;
}

function renderCatalogue(list) {
  const results = $('#results');
  $('#intro').hidden = true;
  $('#filters').hidden = false;

  const label = requirementLabel();
  const composerCount = new Set(list.map((w) => w.c)).size;

  const summary = $('#summary');
  summary.hidden = false;
  summary.replaceChildren(
    el('h2', {}, summaryHeading()),
    el('span', {
      className: 'tally',
      textContent: `${list.length.toLocaleString()} work${list.length === 1 ? '' : 's'}`
        + ` by ${composerCount.toLocaleString()} composer${composerCount === 1 ? '' : 's'}`,
    }),
    el('div', { className: 'actions' },
      el('button', { type: 'button', textContent: 'Copy list', onclick: () => copyList(summaryHeading(), list, true) }),
      el('button', {
        type: 'button',
        textContent: 'Download CSV',
        onclick: () => downloadCsv(list, `works-${[...state.required].join('-') || 'all'}.csv`),
      }),
    ),
  );

  results.replaceChildren();
  if (!list.length) {
    // Spell the query out as removable pieces. An empty result is nearly always
    // one requirement too many, and naming them makes the culprit obvious.
    const active = FAMILY_KEYS.filter((k) => state.required.has(k));
    results.append(el('div', { className: 'empty' },
      el('p', {}, el('strong', { textContent: `No works match all ${active.length} requirements.` })),
      el('p', { className: 'muted', textContent: 'Every one of these must be true at once — drop any to widen the search:' }),
      el('div', { className: 'popular' }, active.map((k) => el('button', {
        type: 'button',
        className: 'chip',
        'aria-pressed': 'true',
        textContent: `${describeRequirement(k)} ✕`,
        onclick() {
          state.required.delete(k);
          state.explicit.delete(k);
          delete state.counts[k];
          syncInstrumentControls();
          refine();
        },
      }))),
    ));
    return;
  }

  // Rendered in batches: "includes trumpet" alone matches thousands of works, and
  // building every row up front makes the page crawl.
  const batch = list.slice(0, state.shown);
  const groups = new Map();
  for (const w of batch) {
    if (!groups.has(w.c)) groups.set(w.c, []);
    groups.get(w.c).push(w);
  }

  for (const [composerId, items] of groups) {
    const c = composerOf(composerId);
    const heading = c?.dates ? `${c.name} (${c.dates})` : composerLabel(composerId);
    results.append(
      el('h2', { className: 'genre-heading', textContent: `${heading} — ${items.length}` }),
      ...items.map(renderWork),
    );
  }

  const remaining = list.length - batch.length;
  if (remaining > 0) {
    results.append(el('div', { className: 'more' },
      el('button', {
        type: 'button',
        className: 'secondary',
        textContent: `Show ${Math.min(CATALOGUE_PAGE, remaining)} more (${remaining.toLocaleString()} remaining)`,
        onclick() { state.shown += CATALOGUE_PAGE; rerender(); },
      })));
  }
}

function rerender() {
  if (state.mode === 'catalogue') return renderCatalogue(catalogueMatches());
  if (state.composer) return renderResults(state.composer, worksFor(state.composer.id));
}

/** Canonical, order-stable URL for the current instrument selection. */
const requiredHash = () => {
  const parts = FAMILY_KEYS.filter((k) => state.required.has(k)).map((k) => {
    const rule = state.counts[k];
    return rule && rule !== 'any' ? `${k}:${rule}` : k;
  });
  return `#i=${parts.join(',')}`;
};

/** Re-run the current query from the top after the criteria change. */
function refine() {
  state.shown = CATALOGUE_PAGE;
  // Keep the URL in step, or a link copied after adjusting the chips would
  // reproduce the previous search rather than the one on screen.
  if (state.mode === 'catalogue' && location.hash !== requiredHash()) {
    history.replaceState(null, '', requiredHash());
  }
  rerender();
}

/**
 * The two workflows are peers, so switching between them is a first-class
 * action rather than a link tucked inside the filters. The instrument grid is
 * shared by both — it narrows a composer's list in one mode and *is* the query
 * in the other — so only the composer field and the framing text change.
 */
function setTab(tab, { focus = false } = {}) {
  state.tab = tab;
  const onComposer = tab === 'composer';
  $('#tab-composer').setAttribute('aria-selected', String(onComposer));
  $('#tab-instrument').setAttribute('aria-selected', String(!onComposer));
  $('#composer-panel').hidden = !onComposer;

  const note = $('#scope-note');
  if (onComposer) {
    note.textContent = state.composer
      ? `Narrowing ${state.composer.name}'s works.`
      : 'Choose a composer above, then narrow their works by instrument.';
  } else {
    const total = state.data?.stats?.composers ?? 0;
    note.textContent = `Searching all ${total.toLocaleString()} composers.`;
  }
  if (focus && onComposer) input.focus();
}

function showComposerTab({ focus = false } = {}) {
  setTab('composer', { focus });
}

/** Switch to instrument-wide searching and run whatever is currently selected. */
function showInstrumentTab({ silent = false } = {}) {
  setTab('instrument');
  searchCatalogue({ silent });
}

function searchCatalogue({ silent = false } = {}) {
  state.mode = 'catalogue';
  state.composer = null;
  state.shown = CATALOGUE_PAGE;
  input.value = '';
  closeSuggestions();
  setTab('instrument');
  if (location.hash !== requiredHash()) history.replaceState(null, '', requiredHash());
  rerender();
  if (!silent) $('#summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Export ────────────────────────────────────────────────────────────────────
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** Exports the whole match set, not just the batch currently on screen. */
function downloadCsv(list, filename) {
  const rows = [
    ['Composer', 'Work', 'Catalogue', 'Year', 'Genre', 'Trumpet-family scoring', 'Full instrumentation', 'Arrangement'],
    ...list.map((w) => [composerLabel(w.c), w.t, w.cat, w.y, w.g, w.s, w.full, w.arr ? 'yes' : 'no']),
  ];
  const blob = new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyList(heading, list, withComposer = false) {
  const line = (w) => {
    const title = w.cat ? `${w.t}, ${w.cat}` : w.t;
    return withComposer ? `${composerLabel(w.c)} — ${title} — ${w.s}` : `${title} — ${w.s}`;
  };
  const text = [heading, ''].concat(list.map(line)).join('\n');
  try {
    await navigator.clipboard.writeText(text);
    flash('Copied to clipboard');
  } catch {
    flash('Copy failed — your browser blocked clipboard access');
  }
}

let flashTimer;
function flash(message) {
  let node = $('#flash');
  if (!node) {
    node = el('div', { id: 'flash' });
    Object.assign(node.style, {
      position: 'fixed', bottom: '1.25rem', left: '50%', transform: 'translateX(-50%)',
      background: 'var(--ink)', color: 'var(--bg)', padding: '.55rem 1.1rem',
      borderRadius: '999px', fontSize: '.88rem', zIndex: '50', boxShadow: '0 8px 24px rgb(0 0 0 / .25)',
    });
    document.body.append(node);
  }
  node.textContent = message;
  node.style.opacity = '1';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { node.style.opacity = '0'; }, 2200);
}

// ── Typeahead wiring ──────────────────────────────────────────────────────────
const input = $('#composer');
const suggestionList = $('#suggestions');
let activeIndex = -1;
let current = [];

/** Match the default view: originals, falling back to arrangements-only. */
const countLabel = (c) => (c.n
  ? `${c.n} work${c.n === 1 ? '' : 's'}`
  : `${c.nArr} arrangement${c.nArr === 1 ? '' : 's'}`);

function closeSuggestions() {
  suggestionList.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}

function showSuggestions(matches) {
  current = matches;
  if (!matches.length) return closeSuggestions();
  suggestionList.replaceChildren(...matches.map((c, i) =>
    el('li', {
      role: 'option',
      id: `sug-${i}`,
      onclick: () => select(c),
    },
      el('span', { textContent: c.dates ? `${c.name} (${c.dates})` : c.name }),
      el('span', { className: 'count', textContent: countLabel(c) }),
    )));
  suggestionList.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  setActive(-1);
}

function setActive(i) {
  activeIndex = i;
  [...suggestionList.children].forEach((li, idx) =>
    li.setAttribute('aria-selected', String(idx === i)));
  input.setAttribute('aria-activedescendant', i >= 0 ? `sug-${i}` : '');
}

function select(composer, { silent = false } = {}) {
  state.composer = composer;
  state.mode = 'composer';
  setTab('composer');
  input.value = composer.name;
  closeSuggestions();
  if (location.hash.slice(1) !== encodeURIComponent(composer.id)) {
    history.replaceState(null, '', `#${encodeURIComponent(composer.id)}`);
  }
  rerender();
  if (!silent) $('#summary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

input.addEventListener('input', () => {
  const matches = matchComposers(input.value);
  showSuggestions(matches);
});

input.addEventListener('keydown', (e) => {
  if (suggestionList.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); setActive((activeIndex + 1) % current.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((activeIndex - 1 + current.length) % current.length); }
  else if (e.key === 'Enter' && activeIndex >= 0) { e.preventDefault(); select(current[activeIndex]); }
  else if (e.key === 'Escape') closeSuggestions();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.combo')) closeSuggestions();
});

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const matches = matchComposers(input.value, 1);
  if (matches.length) return select(matches[0]);
  closeSuggestions();
  $('#summary').hidden = true;
  $('#intro').hidden = true;

  const near = nearestComposers(input.value);
  $('#results').replaceChildren(el('div', { className: 'empty' },
    el('p', {}, el('strong', { textContent: `No composer found for “${input.value}”.` })),
    near.length
      ? el('div', {},
        el('p', { className: 'muted', textContent: 'Did you mean:' }),
        el('div', { className: 'popular' }, near.map((c) => el('button', {
          type: 'button', className: 'chip', textContent: c.name, onclick: () => select(c),
        }))))
      : el('p', { className: 'muted', textContent: 'Check the spelling, or try the surname on its own. The index covers composers with at least one catalogued trumpet-family work.' }),
  ));
});

/** Put the page back exactly as it loads, filters included. */
function resetApp() {
  state.composer = null;
  state.mode = null;
  state.shown = CATALOGUE_PAGE;
  state.required.clear();
  state.explicit.clear();
  state.counts = {};
  state.arrangements = false;
  state.estimated = true;
  state.group = true;
  state.sort = 'default';

  input.value = '';
  closeSuggestions();

  for (const chip of document.querySelectorAll('#instrument-filters .chip')) {
    chip.setAttribute('aria-pressed', 'false');
  }
  renderCountFilters();
  $('#opt-arrangements').checked = false;
  $('#opt-estimated').checked = true;
  $('#opt-group').checked = true;
  $('#sort').value = 'default';

  $('#results').replaceChildren();
  $('#summary').hidden = true;
  $('#intro').hidden = false;
  showComposerTab();

  // Drop the composer from the URL so a reload also starts clean.
  history.replaceState(null, '', location.pathname + location.search);
  input.focus();
}

$('#clear').addEventListener('click', resetApp);

$('#browse-all').addEventListener('click', () => {
  input.value = '';
  showSuggestions([...state.data.composers].sort((a, b) => b.n - a.n).slice(0, 40));
  input.focus();
});

// ── Filter wiring ─────────────────────────────────────────────────────────────
/** Reflect state onto the chips and quantity selects without rebuilding them. */
function syncInstrumentControls() {
  for (const chip of document.querySelectorAll('#instrument-filters .chip')) {
    const key = chip.dataset.instrument;
    chip.setAttribute('aria-pressed', String(state.required.has(key)));
    // "none" is still an active constraint, but the opposite one, so it must not
    // look like the instrument is being asked for.
    chip.classList.toggle('exclude', state.counts[key] === 'eq0');
  }
  for (const sel of document.querySelectorAll('#instrument-filters select[data-instrument]')) {
    sel.value = state.counts[sel.dataset.instrument] ?? 'any';
  }
}

/** Kept for the deep-link path, which used to rebuild a separate counts row. */
const renderCountFilters = syncInstrumentControls;

/**
 * One row per instrument: whether a work must use it, and how many. Both live
 * here from the moment the page loads — an earlier version only revealed the
 * quantity control after an instrument was ticked, which meant arriving at the
 * page showed no sign the feature existed at all.
 */
function buildInstrumentChips() {
  const holder = $('#instrument-filters');
  holder.replaceChildren(...FAMILY_KEYS.map((key) => el('div', { className: 'instrument-row' },
    el('button', {
      type: 'button',
      className: 'chip',
      textContent: FAMILY[key].label,
      dataset: { instrument: key },
      'aria-pressed': 'false',
      onclick(e) {
        const on = e.currentTarget.getAttribute('aria-pressed') === 'true';
        if (on) {
          state.required.delete(key);
          state.explicit.delete(key);
          delete state.counts[key]; // a rule without its instrument means nothing
        } else {
          state.required.add(key);
          state.explicit.add(key);
        }
        syncInstrumentControls();
        // On the instrument tab, or before anything has been searched, picking
        // an instrument is itself the query.
        if (state.tab === 'instrument' || !state.mode) return searchCatalogue({ silent: true });
        refine();
      },
    }),
    el('select', {
      dataset: { instrument: key },
      'aria-label': `How many ${FAMILY[key].plural}`,
      onchange(e) {
        const rule = e.target.value;
        if (rule === 'any') {
          delete state.counts[key];
          // Setting a quantity implies the instrument; taking it away again has
          // to release it, or an abandoned experiment silently keeps narrowing
          // every later search — "2 trumpets + 1 cornet" then finds nothing
          // because a forgotten flugelhorn is still required.
          if (!state.explicit.has(key)) state.required.delete(key);
        } else {
          state.counts[key] = rule;
          // Asking for a quantity plainly means requiring the instrument, so
          // don't make the user tick it separately.
          state.required.add(key);
        }
        syncInstrumentControls();
        if (state.tab === 'instrument' || !state.mode) return searchCatalogue({ silent: true });
        refine();
      },
    }, COUNT_OPTIONS.map(([value, text]) => el('option', { value, textContent: text }))),
  )));
  syncInstrumentControls();
}

$('#opt-arrangements').addEventListener('change', (e) => { state.arrangements = e.target.checked; refine(); });
$('#opt-estimated').addEventListener('change', (e) => { state.estimated = e.target.checked; refine(); });
$('#opt-group').addEventListener('change', (e) => { state.group = e.target.checked; refine(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; refine(); });

$('#tab-composer').addEventListener('click', () => showComposerTab({ focus: true }));
$('#tab-instrument').addEventListener('click', () => showInstrumentTab());

// Left/right arrows move between tabs, as a tablist is expected to.
for (const tab of document.querySelectorAll('.mode-tabs [role="tab"]')) {
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = state.tab === 'composer' ? 'instrument' : 'composer';
    if (next === 'composer') showComposerTab({ focus: false });
    else showInstrumentTab();
    $(`#tab-${next}`).focus();
  });
}

/**
 * Tell the visitor when they are looking at a superseded build.
 *
 * Pages caches for ten minutes and its headers cannot be changed, so a visitor
 * arriving inside that window can be served a stale page with no signal at all.
 * version.json is fetched with `cache: 'no-store'`, which bypasses the HTTP
 * cache entirely — the one request guaranteed to describe what is actually
 * published — and the page compares it with the build stamped into itself.
 */
async function checkForNewerBuild() {
  if (window.__WORKS_DATA__) return;      // the standalone copy is self-contained
  const current = window.__BUILD__;
  if (!current) return;
  try {
    const res = await fetch('data/version.json', { cache: 'no-store' });
    if (!res.ok) return;
    const latest = await res.json();
    if (latest.build && latest.build !== current) announceUpdate(latest.build);
  } catch {
    // Offline, or the file is not published yet: leave the page alone.
  }
}

function announceUpdate(build) {
  if (document.querySelector('.update-bar')) return;   // already showing
  const reload = () => {
    // A URL the browser has never seen, so the markup itself cannot come from
    // cache; the hash is carried over so the visitor keeps their search.
    location.replace(`${location.pathname}?v=${encodeURIComponent(build)}${location.hash}`);
  };
  document.body.prepend(el('div', { className: 'update-bar', role: 'status' },
    el('span', { textContent: 'A newer version of this index has been published.' }),
    el('button', { type: 'button', className: 'secondary', textContent: 'Load it', onclick: reload }),
  ));
}

// ── Boot ──────────────────────────────────────────────────────────────────────
try {
  const data = await loadData();
  data.composers = indexComposers(data.composers);
  state.data = data;
  composersById = new Map(data.composers.map((c) => [c.id, c]));

  buildInstrumentChips();
  setTab('composer');

  $('#provenance').textContent =
    `Index built ${new Date(data.generated).toLocaleDateString()} — ` +
    `${data.stats.works.toLocaleString()} works by ${data.stats.composers.toLocaleString()} composers.`
    + (window.__BUILD__ ? ` Build ${window.__BUILD__}.` : '');

  checkForNewerBuild();
  // A tab left open for hours would otherwise never look again, since the check
  // runs at load. Re-checking when the tab is brought back to the front covers
  // that without polling.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForNewerBuild();
  });

  // A few well-stocked composers as one-click starting points.
  const popular = [...data.composers].sort((a, b) => b.n - a.n).slice(0, 10);
  $('#popular').replaceChildren(
    el('span', { className: 'label', textContent: 'Try:' }),
    ...popular.map((c) => el('button', {
      type: 'button', className: 'chip', textContent: c.name,
      onclick: () => select(c),
    })),
  );

  // Deep link: #composer-id, kept live so shared links, the back button and
  // hash edits all land on the right composer rather than only working on boot.
  const selectFromHash = () => {
    const hash = decodeURIComponent(location.hash.slice(1));
    if (!hash) return false;

    // #i=trumpet,cornet — a shareable catalogue-wide instrument search.
    if (hash.startsWith('i=')) {
      state.required = new Set();
      state.explicit = new Set();
      state.counts = {};
      for (const token of hash.slice(2).split(',')) {
        const [key, rule] = token.split(':');
        if (!FAMILY_KEYS.includes(key)) continue;
        state.required.add(key);
        state.explicit.add(key);
        if (rule && COUNT_OPTIONS.some(([v]) => v === rule)) state.counts[key] = rule;
      }
      for (const chip of document.querySelectorAll('#instrument-filters .chip')) {
        chip.setAttribute('aria-pressed', String(state.required.has(chip.dataset.instrument)));
      }
      renderCountFilters();
      showInstrumentTab({ silent: true });
      return true;
    }

    const linked = data.composers.find((c) => c.id === hash);
    if (linked && linked !== state.composer) select(linked, { silent: true });
    return !!linked;
  };
  window.addEventListener('hashchange', selectFromHash);
  selectFromHash();
} catch (err) {
  $('#results').replaceChildren(el('div', { className: 'error' },
    el('p', {}, el('strong', { textContent: 'The work index could not be loaded.' })),
    el('p', { className: 'muted', textContent: err.message }),
    el('p', { className: 'muted', textContent: 'If you opened this file directly from disk, use the standalone build (dist/trumpet-finder.html) instead — browsers block module and data loading over file:// URLs.' }),
  ));
}
