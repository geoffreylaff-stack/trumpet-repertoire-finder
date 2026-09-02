#!/usr/bin/env node
/** Unit tests for the shared parser. Run with: node --test tools/ */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstrumentation, formatScoring, requiredInstruments,
  mentionsFamily, fromCategoryName, scoringKey,
} from '../lib/instrumentation.mjs';

const scoring = (text) => formatScoring(parseInstrumentation(text));
const counts = (text) => parseInstrumentation(text).counts;

test('counts written as digits, words, or bare plurals', () => {
  assert.equal(scoring('2 trumpets'), 'two trumpets');
  assert.equal(scoring('Three Trumpets'), 'three trumpets');
  assert.equal(scoring('trumpet'), 'trumpet');
  assert.equal(scoring('trumpets'), 'two trumpets'); // a guess, flagged below
  assert.equal(scoring('4 tpt.'), 'four trumpets');
});

test('a bare plural is uncertain, an explicit number is not', () => {
  assert.deepEqual(parseInstrumentation('trumpets').uncertain, ['trumpet']);
  assert.deepEqual(parseInstrumentation('2 trumpets').uncertain, []);
  // A singular is not a guess: "trumpet" means exactly one.
  assert.deepEqual(parseInstrumentation('trumpet').uncertain, []);
});

// ── The transposition rule ────────────────────────────────────────────────────
test('the key an instrument is pitched in is ignored', () => {
  assert.equal(scoring('Trumpet in C'), 'trumpet');
  assert.equal(scoring('Trumpet in B-flat'), 'trumpet');
  assert.equal(scoring('trumpet in B♭'), 'trumpet');
  assert.equal(scoring('trumpet in Bb'), 'trumpet');
  assert.equal(scoring('2 trumpets in D'), 'two trumpets');
  assert.equal(scoring('cornet in A'), 'cornet');
  // Both spellings of the same thing land on the same record.
  assert.equal(scoringKey(parseInstrumentation('Trumpet in C')),
               scoringKey(parseInstrumentation('Trumpet in B-flat')));
});

test('a key written in front of the instrument does not eat the count', () => {
  // The bug this guards: "3 B-flat trumpets" leaves the number stranded from
  // the noun, so without stripping it reads as an unnumbered plural — two.
  assert.equal(scoring('3 B-flat trumpets'), 'three trumpets');
  assert.equal(scoring('2 E-flat cornets'), 'two cornets');
  assert.equal(scoring('C trumpet'), 'trumpet');
  assert.deepEqual(parseInstrumentation('3 B-flat trumpets').uncertain, []);
});

// ── Part ranges ───────────────────────────────────────────────────────────────
test('a part range after the name is a section size', () => {
  // Band lists number their parts rather than counting them, so this is the
  // only statement of size such a list makes.
  assert.equal(scoring('Trumpet 1-4'), 'four trumpets');
  assert.equal(scoring('Trumpets 1-3'), 'three trumpets');
  assert.equal(scoring('Cornet 1-2'), 'two cornets');
  assert.deepEqual(parseInstrumentation('Trumpet 1-4').uncertain, []);
});

test('a range combines with other sections in one list', () => {
  const c = counts('Horn 1-4, Trumpet 1-3, Trombone 1-3, Tuba');
  assert.equal(c.trumpet, 3);
});

test('a lone part number is one player, not a range', () => {
  assert.equal(scoring('Trumpet 1'), 'trumpet');
  assert.equal(scoring('Trumpet 2'), 'trumpet');
});

test('a range is only read when it sits against the name', () => {
  // A duration or a grade elsewhere in the text must not become a section size.
  assert.equal(scoring('trumpet and piano, 3-4 minutes'), 'trumpet');
  assert.equal(scoring('Trumpet in B-flat 1'), 'trumpet');
});

test('a range end never becomes the next instrument\'s count', () => {
  // Run-on lists happen when a stripped line break leaves two entries touching.
  // Read forwards, the 3 of "trumpet 1-3" invents three flugelhorns.
  const c = counts('french horn 1-4 Bb trumpet 1-3 B flugelhorn trombone 1-3');
  assert.equal(c.flugelhorn, 1);
  // Properly separated, the same list reads in full.
  const ok = counts('french horn 1-4, Bb trumpet 1-3, B flugelhorn, trombone 1-3');
  assert.equal(ok.trumpet, 3);
  assert.equal(ok.flugelhorn, 1);
});

test('a descending or absurd range is ignored', () => {
  assert.equal(scoring('Trumpet 4-1'), 'trumpet');
  assert.equal(scoring('Trumpet 1-99'), 'trumpet');
});

test('alternative keys collapse to one instrument', () => {
  assert.equal(scoring('4 trumpets in F or B-flat'), 'four trumpets');
});

test('a note name only counts as a key when nothing follows it', () => {
  // "in Concert pitch" must not be read as the key of C.
  assert.equal(scoring('trumpet in Concert pitch'), 'trumpet');
});

test('stripping a key never welds two instruments together', () => {
  // The danger case: a naive strip of ", E-flat" would leave "trumpet clarinet".
  const c = counts('trumpet in C, E-flat clarinet, 2 cornets');
  assert.equal(c.trumpet, 1);
  assert.equal(c.cornet, 2);
});

// ── Family membership ─────────────────────────────────────────────────────────
test('cornet is a separate instrument from trumpet', () => {
  assert.equal(scoring('2 trumpets, 2 cornets'), 'two trumpets, two cornets');
  const c = counts('2 cornets');
  assert.equal(c.cornet, 2);
  assert.equal(c.trumpet ?? 0, 0);
});

test('the Renaissance cornett is not the valved cornet', () => {
  assert.equal(mentionsFamily('2 cornetti, 3 trombones'), false);
  assert.equal(mentionsFamily('cornett, sackbut'), false);
  assert.equal(mentionsFamily('zink'), false);
  assert.equal(scoring('cornetto, 4 viols'), '');
});

test('flugelhorn and piccolo trumpet are in scope', () => {
  assert.equal(scoring('flugelhorn'), 'flugelhorn');
  assert.equal(scoring('Flügelhorn'), 'flugelhorn');
  assert.equal(scoring('2 flugel horns'), 'two flugelhorns');
  assert.equal(scoring('piccolo trumpet'), 'piccolo trumpet');
  assert.equal(scoring('piccolo trumpet in A'), 'piccolo trumpet');
});

test('piccolo trumpet is matched before the bare trumpet pattern', () => {
  const c = counts('piccolo trumpet, 2 trumpets');
  assert.equal(c.piccoloTrumpet, 1);
  assert.equal(c.trumpet, 2);
});

test('bass trumpet is out of scope and is never counted as a trumpet', () => {
  assert.equal(mentionsFamily('bass trumpet'), false);
  assert.equal(scoring('bass trumpet'), '');
  // The real risk: it must not fall through and inflate a genuine count.
  assert.equal(scoring('3 trumpets, bass trumpet'), 'three trumpets');
  assert.equal(scoring('Basstrompete'), '');
});

test('the trumpet marine and the organ stop are not trumpets', () => {
  assert.equal(mentionsFamily('trumpet marine'), false);
  assert.equal(mentionsFamily('trumpet stop, 8 foot'), false);
});

test('other languages map onto the same instruments', () => {
  assert.equal(scoring('2 trombe'), 'two trumpets');
  assert.equal(scoring('3 Trompeten'), 'three trumpets');
  assert.equal(scoring('2 trompettes'), 'two trumpets');
  assert.equal(scoring('2 clarini'), 'two trumpets');   // Baroque trumpet parts
  assert.equal(scoring('tromba piccola'), 'piccolo trumpet');
  assert.equal(scoring('2 Kornetts'), 'two cornets');
});

test('"trumpeter" is not an instrument', () => {
  assert.equal(mentionsFamily('a trumpeter and a drummer'), false);
});

// ── Counting rules ────────────────────────────────────────────────────────────
test('a repeated mention does not add to the count', () => {
  // The scoring is stated first; later narrative must not double it.
  assert.equal(scoring('2 trumpets, strings. The trumpets rest in the slow movement.'),
    'two trumpets');
  assert.equal(scoring('3 trumpets and 3 trumpets'), 'three trumpets');
});

test('an explicit number outranks a bare plural stated elsewhere', () => {
  assert.equal(scoring('3 trumpets; reduced version for trumpets and organ'),
    'three trumpets');
});

test('doublings are players, not extra parts', () => {
  const p = parseInstrumentation('3 trumpets (3rd doubling flugelhorn)');
  assert.equal(formatScoring(p), 'three trumpets (3rd doubling flugelhorn)');
  assert.equal(p.counts.trumpet, 3);
  assert.equal(p.counts.flugelhorn ?? 0, 0);
  // ...but a doubled flugelhorn is still a flugelhorn somebody must own.
  assert.deepEqual(requiredInstruments(p), ['trumpet', 'flugelhorn']);
});

test('a doubling written in words gets an ordinal', () => {
  assert.equal(scoring('2 trumpets (second doubling piccolo trumpet)'),
    'two trumpets (2nd doubling piccolo trumpet)');
});

test('a doubling of a key, not an instrument, is not a doubling', () => {
  assert.equal(scoring('2 trumpets (both doubling in C)'), 'two trumpets');
});

test('instruments are listed in score order regardless of input order', () => {
  assert.equal(scoring('flugelhorn, 2 cornets, 3 trumpets, piccolo trumpet'),
    'piccolo trumpet, three trumpets, two cornets, flugelhorn');
});

test('numerals on request', () => {
  assert.equal(formatScoring(parseInstrumentation('3 trumpets'), { numerals: true }),
    '3 trumpets');
});

// ── Non-family text ───────────────────────────────────────────────────────────
test('works without the family parse to nothing', () => {
  assert.equal(mentionsFamily('violin, viola, cello'), false);
  assert.equal(mentionsFamily('2 oboes, strings'), false);
  assert.equal(parseInstrumentation('string quartet').total, 0);
  assert.equal(mentionsFamily('2 trumpets, strings'), true);
});

test('a real orchestral scoring parses end to end', () => {
  // Tchaikovsky writes trumpets and cornets at once — the case that makes
  // keeping the two apart worth the trouble.
  const p = parseInstrumentation(
    '3 flutes, 2 oboes, 2 clarinets, 2 bassoons, 4 horns, 2 cornets, 2 trumpets, '
    + '3 trombones, tuba, timpani, percussion, harp, strings');
  assert.equal(formatScoring(p), 'two trumpets, two cornets');
  assert.deepEqual(requiredInstruments(p), ['trumpet', 'cornet']);
  assert.equal(p.total, 4);
});

// ── Category names ────────────────────────────────────────────────────────────
test('category names become plain scorings', () => {
  assert.deepEqual(fromCategoryName('For 2 trumpets, cornet (arr)'),
    { text: '2 trumpets, cornet', arrangement: true });
  assert.deepEqual(fromCategoryName('For trumpet, violin, viola, cello'),
    { text: 'trumpet, violin, viola, cello', arrangement: false });
});
