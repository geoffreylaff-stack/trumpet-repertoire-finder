/**
 * A sort position in time for every work, including the undated ones.
 *
 * Most harvested works carry no year. Sorting those by title put a composer's
 * Symphony No. 15 before No. 2, and after every dated work, so a list read
 * 5, 8, 10, 1, 11, 12, … A work's place can usually be worked out from its
 * neighbours even when its own year is unknown:
 *
 *   - A numbered series (Symphony No. 1, No. 2, …) was written in order. An
 *     undated member sits between its nearest dated neighbours in the series,
 *     interpolated by number: with No. 5 dated 1937 and No. 8 dated 1943,
 *     No. 6 goes at 1939.
 *   - Opus numbers, and the Köchel and Deutsch catalogues, were assigned in
 *     order of composition (BWV, HWV, RV and Hoboken were not, so they are
 *     not used).
 *
 * The estimate decides only the order. The interface still shows a year only
 * where a source gave one.
 */

// "Symphony No. 5 in D minor" -> stem "symphony", number 5.
const SERIES = /^(.*?)\bNo\.?\s*(\d+)\b/i;
// Chronological catalogues only.
const CATALOGUE = /^\s*(Op|K|D)\.?\s*(\d+)/i;

const fold = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function seriesOf(title) {
  const m = SERIES.exec(String(title ?? ''));
  if (!m) return null;
  const stem = fold(m[1]);
  return stem ? { stem, n: Number(m[2]) } : null;
}

export function catalogueOf(cat) {
  const m = CATALOGUE.exec(String(cat ?? ''));
  return m ? { system: m[1].toLowerCase(), n: Number(m[2]) } : null;
}

/**
 * Estimate years for the undated members of one sequence, from its dated
 * members. `items` are { w, n }; returns Map(work -> estimated year).
 */
function interpolate(items) {
  const anchors = items.filter((x) => x.w.y).sort((a, b) => a.n - b.n);
  const out = new Map();
  if (!anchors.length) return out;
  for (const x of items) {
    if (x.w.y) continue;
    let prev = null, next = null;
    for (const a of anchors) {
      if (a.n <= x.n) prev = a;
      else { next = a; break; }
    }
    let est;
    if (prev && next) {
      est = prev.w.y <= next.w.y
        ? prev.w.y + (next.w.y - prev.w.y) * (x.n - prev.n) / (next.n - prev.n)
        : prev.w.y; // numbering out of order with the dates: stay beside the earlier one
      if (est === prev.w.y) est += 0.001 * (x.n - prev.n);
    } else if (prev) {
      est = prev.w.y + 0.001 * (x.n - prev.n);
    } else {
      est = next.w.y - 0.001 * (next.n - x.n);
    }
    out.set(x.w, est);
  }
  return out;
}

/**
 * Set `sy` on every work: its year if it has one, otherwise an estimate from a
 * numbered series or a chronological catalogue, otherwise absent (sorted last).
 */
export function assignSortYears(works) {
  const groups = new Map();
  const add = (key, w, n) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ w, n });
  };
  for (const w of works) {
    // Arrangements are dated by their source work's numbering only loosely;
    // keep them out of the sequences the originals are placed by.
    if (w.arr) continue;
    const s = seriesOf(w.t);
    if (s) add(`series|${w.c}|${s.stem}`, w, s.n);
    const cat = catalogueOf(w.cat);
    if (cat) add(`cat|${w.c}|${cat.system}`, w, cat.n);
  }

  const bySeries = new Map();
  const byCatalogue = new Map();
  for (const [key, items] of groups) {
    const target = key.startsWith('series|') ? bySeries : byCatalogue;
    for (const [w, est] of interpolate(items)) target.set(w, est);
  }

  for (const w of works) {
    const sy = w.y ?? bySeries.get(w) ?? byCatalogue.get(w) ?? null;
    if (sy == null) delete w.sy; // absent sorts last; no need to ship a null on every work
    else w.sy = Math.round(sy * 1000) / 1000;
  }
  return works;
}

/** Title order with numbers compared as numbers: No. 2 before No. 15. */
export const compareTitles = (a, b) =>
  String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
