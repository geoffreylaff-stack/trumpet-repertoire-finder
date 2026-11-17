import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSortYears, compareTitles, seriesOf, catalogueOf } from '../lib/chronology.mjs';
import { imslpYear, wikipediaYear } from './harvest-years.mjs';

const order = (works) => [...assignSortYears(works)]
  .sort((a, b) => (a.sy ?? 9999) - (b.sy ?? 9999) || compareTitles(a.t, b.t))
  .map((w) => w.t);

test('undated symphonies take their place in the numbered series', () => {
  const works = [
    { c: 'x', t: 'Symphony No. 8 in C minor', y: 1943 },
    { c: 'x', t: 'Symphony No. 5 in D minor', y: 1937 },
    { c: 'x', t: 'Symphony No. 10 in E minor', y: 1953 },
    ...[15, 1, 2, 3, 4, 6, 7, 9, 11, 12, 13].map((n) => ({ c: 'x', t: `Symphony No. ${n}`, y: null })),
  ];
  assert.deepEqual(order(works).map((t) => Number(/No\. (\d+)/.exec(t)[1])),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15]);
  const six = works.find((w) => w.t === 'Symphony No. 6');
  assert.equal(Math.round(six.sy), 1939); // between 1937 (No. 5) and 1943 (No. 8)
});

test('the estimate orders but is never shown as a year', () => {
  const works = assignSortYears([{ c: 'x', t: 'Symphony No. 1', y: 1925 }, { c: 'x', t: 'Symphony No. 2', y: null }]);
  assert.equal(works[1].y, null);
  assert.ok(works[1].sy > 1925);
});

test('opus numbers place undated works; BWV does not', () => {
  const works = [
    { c: 'x', t: 'Suite', cat: 'Op. 10', y: 1900 },
    { c: 'x', t: 'Overture', cat: 'Op. 5', y: null },
    { c: 'x', t: 'Cantata', cat: 'BWV 12', y: null },
  ];
  assert.deepEqual(order(works), ['Overture', 'Suite', 'Cantata']);
  assert.equal(catalogueOf('BWV 12'), null);
});

test('series stay apart by composer and by kind of work', () => {
  assert.deepEqual(seriesOf('Piano Concerto No. 2 in C minor'), { stem: 'piano concerto', n: 2 });
  const works = assignSortYears([
    { c: 'x', t: 'Symphony No. 1', y: 1900 },
    { c: 'y', t: 'Symphony No. 2', y: null },
    { c: 'x', t: 'String Quartet No. 2', y: null },
  ]);
  assert.equal(works[1].sy, undefined);
  assert.equal(works[2].sy, undefined);
});

test('undated works with nothing to go on sort by title, numbers as numbers', () => {
  assert.deepEqual(order([{ c: 'x', t: 'Sonata No. 15' }, { c: 'x', t: 'Sonata No. 2' }]), ['Sonata No. 2', 'Sonata No. 15']);
});

test('reads composition years from IMSLP and Wikipedia', () => {
  assert.equal(imslpYear('|Opus/Catalogue Number=Op.47\n|Year/Date of Composition=1937 (between April and July)\n|Year of First Publication=1939'), 1937);
  assert.equal(imslpYear('|Year/Date of Composition=\n|Year of First Publication=1939'), null);
  assert.deepEqual(wikipediaYear('{{Infobox musical composition\n| premiere_date = 1928\n| year = 1924–25\n}}'), { year: 1925, how: 'infobox' });
  assert.deepEqual(wikipediaYear('| composed            = 1946–1951/53'), { year: 1953, how: 'infobox' });
  assert.equal(wikipediaYear('Lohengrin was written for the court theatre and first performed in 1850.'), null);
  assert.deepEqual(wikipediaYear('It was composed between 1846 and 1848.'), { year: 1846, how: 'lead' });
  assert.deepEqual(wikipediaYear("The '''Symphony No. 7''' was composed in 1941 in Leningrad."), { year: 1941, how: 'lead' });
  assert.equal(wikipediaYear('It was premiered in 1928.'), null);
});
