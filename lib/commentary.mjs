// Strips commentary from harvested instrumentation text — movement counts,
// durations, premieres, which instrument carries the tune — and keeps the
// scoring. Display text only: counts are parsed from the unfiltered source.
import { firstFamilyMentionIndex } from './instrumentation.mjs';

const INSTRUMENT = String.raw`(?:piccolos?|flutes?|recorders?|oboes?|cor\s+anglais|english\s+horns?|clarinets?|basset\s+horns?|bassoons?|contrabassoons?|sarrusophones?|saxophones?|saxes|saxhorns?|horns?|trumpets?|cornets?|flugelhorns?|bugles?|buccin[ae]|posthorns?|trombones?|tubas?|bombardon|euphoniums?|cimbasso|ophicleides?|serpents?|timpani|timpanis|percussion(?:ists?)?|drums?|snare|tom-?toms?|toms|bongos|congas|timbales|cajon|cymbals?|cymb|hi-?hat|triangles?|tambourines?|castanets?|claves|maracas|shakers?|guiro|cabasa|wood\s*-?blocks?|woodblocks?|temple\s+blocks?|sand-?blocks?|whip|slap-?sticks?|ratchet|rute|anvils?|gongs?|tam-?tams?|bells?|chimes|crotales|glockenspiel|glock|xylophones?|xylorimba|marimbas?|vibraphones?|vibes|mallets|almglocken|cowbells?|flexatone|vibraslap|celesta|celeste|harpsichords?|organs?|pianos?|pianino|harmonium|harmonica|keyboards?|synthesi[sz]ers?|samplers?|harps?|guitars?|mandolins?|banjos?|cimbalom|accordions?|violins?|violas?|cellos?|violoncellos?|celli|basses|contrabass(?:es)?|strings?|woodwinds?|winds?|brass|continuo|sopranos?|altos?|contralto|mezzo-sopranos?|tenors?|baritones?|bass|chorus(?:es)?|semichorus|semi-chorus|choirs?|voices?|soloists?|singers|narrator|SATB\w*|tape|electronics)`;
const INSTR_RE = new RegExp(String.raw`\b${INSTRUMENT}\b`, 'gi');
const NUM = String.raw`(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
const COUNT_INSTR_G = new RegExp(String.raw`\b${NUM}\s+(?:[\w-]+\s+){0,2}${INSTRUMENT}\b`, 'gi');

// Prose: a finite verb, a pronoun or a discourse word. A list item has none.
const PROSE = /\b(?:is|are|was|were|has|have|had|been|being|be|does|did|will|would|can|could|may|might|should|it|its|this|these|those|which|who|whose|he|she|his|her|they|their|there|however|although|though|while|because|indeed|unusually|typical(?:ly)?|usually|notable|minutes|composed|composer|premiered?|performances?|performed|lasts?|lasting|dedicated|commissioned|published|recorded)\b/i;
// Reception, narrative and history: commentary whatever instruments it names.
const NARRATIVE = /\b(?:notes|noted|calls(?!\s+for)|called(?!\s+for)|commented|recalled|praised|wrote|said|remarked|describes?|described|considered|regarded|misnomer|tributes?|inspired|admired|seems?|likely|apparently|according|performances?|premiere[ds]?|recorded|recordings?|biography|letter|audience|critics?|minutes|duration|dedicated|commissioned|published|transcription)\b/i;
// Musical content — what the music does, not what it is scored for.
const MUSICAL = /\b(?:opens|opening|begins|beginning|closes|features|featuring|melod\w*|themes?|thematic|motifs?|harmon(?:y|ies|ic)|fanfares?(?!\s+trumpets?)|passages?|drones?|to\s+provide|imitat\w*|evok\w*|depict\w*|traditional|rich|lively|colou?rful|brilliant|lush|sombre|somber|carries|introduction|cadenzas?|tempo|key\s+of|structur\w*|virtuosic|programmatic|abstract|movements?\s+(?:is|are|last))\b/i;
// Prose that states the scoring, or another version's scoring.
const SCORING = /\b(?:scored|scoring|instrumentation|orchestration|calls?\s+for|called\s+for|requires?|required|includes?|included|including|adds?|added|plus|option(?:al)?|absent|omits?|omitted|without|doubl\w*|replac\w*|substitut\w*|dropped|reduced|reduction|revision|revised|arrangements?|arranged|version|consist\w*|compris\w*|written\s+for|sung\s+by|shared|divided|divisi|cued|cross-cued|dispensable|ad\s+lib\w*)\b/i;
const SCORING_OBJECT = /\b(?:forces|players|instruments|orchestra|ensemble|parts?\s+for)\b/i;
const LEAD_IN = /\b(?:as\s+follows|the\s+following(?:\s+\w+){0,2}|instrumentation(?:\s+is)?|orchestration(?:\s+is)?|scored\s+for|consist(?:s|ing)\s+of)\s*$/i;
const COMMENT_LABEL = /^\W*(?:movements?|the\s+music|program(?:me)?\s+notes?|about\s+the\s+(?:music|piece|work)|duration|premiere|source)\s*$/i;
const JUNK = /\{\||\|\}|wikitable|class\s*=|<!--/i;
const LIST_START = new RegExp(String.raw`^\W*(?:and\s+|plus\s+)?(?:(?:${NUM}|an?|solo|optional|offstage|onstage)\s+){0,2}(?:(?!(?:the|this|these|that|its|his|her|their)\b)[\w-]+\s+)?${INSTRUMENT}\b|^\W*\d`, 'i');
const CALL_TO_ACTION = /^\W*(?:view|click|download|listen|watch|buy|order|purchase|visit)\b/i;

const words = (s) => s.split(/\s+/).filter(Boolean).length;
const noParens = (s) => {
  let out = '', depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
};
const instrHits = (s) => (s.match(INSTR_RE) || []).length + (firstFamilyMentionIndex(s) >= 0 ? 1 : 0);
const countHits = (s) => (s.match(COUNT_INSTR_G) || []).length;

// Segments at commas, semicolons, colons and sentence ends outside brackets,
// each keeping its own trailing separator.
export function split(text) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') { depth++; continue; }
    if ((ch === ')' || ch === ']') && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    let kind = null;
    const rest = text.slice(i + 1);
    if (ch === ',' || ch === ';' || ch === ':') kind = ch;
    else if (ch === '.' && (/^\s+["“'(A-Z0-9]/.test(rest) || /^,/.test(rest)) && !ABBREV.test(text.slice(start, i))) kind = '.';
    if (!kind) continue;
    let j = i + 1;
    if ((kind === ':' || kind === '.') && /^\s*,/.test(text.slice(j))) j += text.slice(j).indexOf(',') + 1; // "follows:, Woodwinds" / "acceptable., piccolo"
    j += /^\s*/.exec(text.slice(j))[0].length;
    out.push({ text: text.slice(start, i), sep: text.slice(i, j), kind });
    start = j;
    i = j - 1;
  }
  if (start < text.length) out.push({ text: text.slice(start), sep: '', kind: null });
  return out;
}

// "S.D. B.D. Xylo. Cymb." — an abbreviated item, not the end of a sentence.
const ABBREV = /(?:^|[\s(,])(?:[A-Za-z]{1,3}(?:\.[A-Za-z]{1,3})+|Xylo|Cymb|Glock|Tamb|Sus|Susp|Bari|Eng|Ob|Perc|Timp|Vib|Vibr|Mar|Sax|Tpt|Tpts|Hn|Hns|Tbn|Tbns|Cl|Fl|Bsn|Picc|Euph|Cbsn|Trgl|Tri|Chim|Approx|approx|ca|St|Mr|Dr)$/;
// A part for this index's family added, dropped or made optional is a scoring fact
// even when told as history ("Fauré added horn and trumpet parts").
const FAMILY_SCORING = /\b(?:add(?:s|ed)?|parts?|omit\w*|scored|without|optional|transcri\w*|arrange\w*|versions?)\b/i;

const ENDS_SENTENCE = new Set(['.', ';', ':']);

// A comma-joined segment that is really the start of a new sentence — the
// harvest flattened "strings. The work lasts…" into "strings, The work lasts…".
function startsFlattenedSentence(seg) {
  if (JUNK.test(seg.text)) return true;
  const s = noParens(seg.text).trim();
  const n = words(s);
  const hits = instrHits(s);
  if (NARRATIVE.test(s) && (n >= 3 || hits === 0)) return true;
  if (/^["“]?[A-Z]/.test(s) && n >= 4 && (PROSE.test(s) || hits === 0)) return true;
  return n >= 5 && PROSE.test(s) && hits === 0;
}

function judge(sentenceText, isLabelOnly, afterDrop) {
  let core = sentenceText.trim();
  const whollyBracketed = /^\(.*\)\.?$/.test(core);
  core = whollyBracketed ? core.replace(/^\(|\)\.?$/g, '') : noParens(core);
  const n = words(core);
  const hits = instrHits(core);
  if (n === 0) return 'drop';
  if (isLabelOnly && COMMENT_LABEL.test(core)) return 'drop';
  if (CALL_TO_ACTION.test(core) || JUNK.test(sentenceText)) return 'drop';
  const many = countHits(core) >= 2; // an instrument list glued into the sentence
  const prosey = n >= 5 && PROSE.test(core);
  if (firstFamilyMentionIndex(core) >= 0 && FAMILY_SCORING.test(core) && !MUSICAL.test(core)) return 'keep';
  if ((NARRATIVE.test(core) || MUSICAL.test(core)) && !many && (prosey || hits <= 2)) return 'drop';
  if (MUSICAL.test(core) && countHits(core) === 0 && /\b(?:play(?:s|ed|ing)?|against|carr(?:y|ies))\b/i.test(core)) return 'drop'; // "a bassoon theme played against plucked strings"
  if (prosey) {
    if (SCORING.test(core) && (hits >= 1 || SCORING_OBJECT.test(core))) return 'keep';
    if (hits >= 2 || countHits(core) >= 1) return 'keep';
    return 'drop';
  }
  if (afterDrop && !LIST_START.test(core) && hits < 2 && countHits(core) === 0) return 'drop';
  return hits >= 1 ? 'keep' : 'drop';
}

export function stripCommentary(text, debug = false) {
  if (!text) return text;
  const original = text;
  text = text.replace(/\s*<!--[\s\S]*?(?:-->|$)/g, '');
  const segs = split(text);

  // Group into sentences.
  const sentences = [];
  segs.forEach((s, i) => {
    const prev = segs[i - 1];
    if (i === 0 || ENDS_SENTENCE.has(prev.kind) || (prev.kind === ',' && startsFlattenedSentence(s))) sentences.push([]);
    sentences.at(-1).push(i);
  });

  const info = [];
  for (const idxs of sentences) {
    const body = idxs.map((i, k) => segs[i].text + (k < idxs.length - 1 ? segs[i].sep : '')).join('');
    const last = segs[idxs.at(-1)];
    const core = noParens(body).trim();
    const isLeadIn = last.kind === ':' && (LEAD_IN.test(core) || SCORING.test(core));
    const proseLeadIn = isLeadIn && LEAD_IN.test(core) && words(core) >= 3 && /^\W*[A-Z]/.test(core);
    const afterDrop = info.length > 0 && info.at(-1).verdict === 'drop' && info.at(-1).commentary;
    const verdict = judge(body, idxs.length === 1 && last.kind === ':', afterDrop);
    const commentary = verdict === 'drop' && (NARRATIVE.test(core) || MUSICAL.test(core) || (words(core) >= 5 && PROSE.test(core)) || JUNK.test(body) || (afterDrop));
    info.push({ idxs, body, isLeadIn, proseLeadIn, verdict, commentary });
  }
  // A short sub-label between two kept sentences ("P I:", "Girls (...) Boys:")
  // is part of the list's structure, not commentary.
  info.forEach((x, k) => {
    if (x.verdict === 'drop' && !x.commentary && words(noParens(x.body).trim()) <= 3
      && !COMMENT_LABEL.test(noParens(x.body).replace(/[:'\s]+$/, ''))
      && (k === 0 || info[k - 1]?.verdict === 'keep') && info[k + 1]?.verdict === 'keep') x.verdict = 'keep';
  });
  // The harvest cut long text at a fixed length; a closing sentence that is
  // prose cut off mid-word ("The additional percussion and timpani ar") is
  // dropped rather than shipped half-said.
  info.forEach((x, k) => {
    const core = noParens(x.body).trim();
    if (k === info.length - 1 && k > 0 && x.verdict === 'keep' && /^\W*(?:The|This|These|It|In|A|An)\s/.test(core)
      && countHits(core) < 2 && instrHits(core) < 3) x.verdict = 'drop';
  });
  // A bare lead-in stands or falls with the list it introduces. One that is
  // itself a list ("…, timpani + 3 percussion, percussion instrumentation:")
  // keeps its own verdict.
  for (let k = info.length - 1; k >= 0; k--) {
    const x = info[k];
    const core = noParens(x.body);
    const isList = instrHits(core) >= 3 || countHits(core) >= 2;
    if (x.isLeadIn && !isList && !NARRATIVE.test(x.body) && !MUSICAL.test(x.body)) {
      x.verdict = info[k + 1]?.verdict === 'keep' ? 'keep' : 'drop';
    }
  }
  if (debug === true) for (const x of info) console.log(x.verdict.padEnd(5), x.isLeadIn ? 'LEAD' : '    ', x.commentary ? 'COMM' : '    ', '|', x.body.slice(0, 110));
  if (info.every((x) => x.verdict === 'keep')) {
    const same = text === original ? text : text.replace(/[\s,;:–—-]+$/, '');
    return debug === 'collect' ? { out: same, dropped: [] } : same;
  }

  // Commentary ahead of an explicit "instrumentation is as follows:" means the
  // list proper starts after that lead-in.
  let from = 0;
  const lead = info.findIndex((x, k) => x.proseLeadIn && x.verdict === 'keep' && info.slice(0, k).some((p) => p.commentary));
  if (lead > 0 && !info.slice(0, lead).some((p) => p.verdict === 'keep' && countHits(noParens(p.body)) >= 2)) {
    const hitsOf = (arr) => arr.filter((x) => x.verdict === 'keep').reduce((a, x) => a + instrHits(noParens(x.body)), 0);
    if (hitsOf(info.slice(lead + 1)) > hitsOf(info.slice(0, lead))) from = lead + 1;
  }

  // Reassemble: original separators inside a run of kept sentences, ". "
  // across a gap; a kept sentence just before a cut sheds trailing segments
  // that name no instrument (a dangling name, label or numeral).
  const kept = info.map((x, k) => ({ ...x, k })).filter((x) => x.k >= from && x.verdict === 'keep');
  let out = '';
  kept.forEach((x, n) => {
    const nextKept = kept[n + 1];
    const cutAfter = !nextKept || nextKept.k !== x.k + 1;
    let idxs = x.idxs;
    if (cutAfter && x.k < info.length - 1) {
      idxs = [...idxs];
      while (idxs.length > 1 && instrHits(noParens(segs[idxs.at(-1)].text)) === 0) idxs.pop();
    }
    out += idxs.map((i, m) => segs[i].text + (m < idxs.length - 1 ? segs[i].sep : '')).join('');
    if (nextKept) out += cutAfter ? '. ' : segs[idxs.at(-1)].sep;
  });
  const result = out.replace(/[\s,;:–—-]+$/, '').replace(/\s+(?:and|but|plus|with)$/i, '').trim();
  if (debug === 'collect') return { out: result, dropped: info.filter((x, k) => k < from || x.verdict === 'drop').map((x) => x.body) };
  return result;
}
