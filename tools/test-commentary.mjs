import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCommentary } from '../lib/commentary.mjs';

test('drops movement counts and durations after the list', () => {
  assert.equal(
    stripCommentary('2 flutes, 2 oboes, 2 trumpets, timpani and strings. It is in four movements. A typical performance lasts about 25 minutes'),
    '2 flutes, 2 oboes, 2 trumpets, timpani and strings',
  );
});

test('drops remarks on which instruments carry the music', () => {
  assert.equal(
    stripCommentary('2 flutes, oboe, 2 horns, trumpet, organ, harp, celesta, Strings, This is a slightly larger orchestra than for the 1923 Dance Suite. In particular, the organ is added in II.1 to provide a drone for the "bagpipe"'),
    '2 flutes, oboe, 2 horns, trumpet, organ, harp, celesta, Strings',
  );
});

test('keeps abbreviated percussion items', () => {
  const s = 'Percussion Instruments needed: triangle, S.D., B.D., Xylo., Cymb. a2, Guiro, Tamb., H.H. (stand alone) Ocean Drum, Chimes';
  assert.equal(stripCommentary(s), s);
});

test('keeps a trumpet part added in a later version', () => {
  const s = 'harp, timpani, organ, strings. For a performance at the Madeleine in May 1888 Fauré added horn and trumpet parts';
  assert.equal(stripCommentary(s), s);
});

test('keeps scoring-variant labels and drops HTML comments', () => {
  const s = "''Orchestra (full):'' flute, 2 clarinets + 2 cornets, trombone + strings<br>''Orchestra (small):'' flute, cornet + strings";
  assert.equal(stripCommentary(s), s);
  assert.equal(stripCommentary('horn, trumpet, euphonium<!--The first version said "3 flutes"-->'), 'horn, trumpet, euphonium');
});

test('returns empty when nothing is instrumentation', () => {
  assert.equal(stripCommentary('a bassoon and clarinet theme played against plucked strings. The musical material comes from a gavotte for piano'), '');
  assert.equal(stripCommentary('The second, "Borghild\'s Dream", is an intermezzo contrasting a sensitive string melody with an agitated section. The third opens with trumpet fanfares before presenting its main subject'), '');
});
