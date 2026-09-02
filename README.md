# Trumpet & Cornet Repertoire Finder

Type a classical composer's name into a web browser and get back every
catalogued work whose scoring includes an instrument of the trumpet family —
with the exact instrumentation for each: *two trumpets, two cornets*,
*three trumpets*, *piccolo trumpet*, and so on.

Nothing is installed. The end user opens a URL in Chrome or Edge and searches.

| | |
|---|---|
| **Works indexed** | 11,431 |
| **Composers** | 2,007 |
| **Works needing a cornet** | 650 |
| **Works needing a flugelhorn** | 784 |
| **Sources** | 133 hand-checked · 741 from Wikipedia · 10,557 from IMSLP |
| **Family members covered** | trumpet · cornet · flugelhorn · piccolo trumpet |

---

## Three rules about what counts

This index is opinionated in three specific ways, and the rules are enforced in
`lib/instrumentation.mjs` rather than left to whoever typed a catalogue entry.

**Transposition is ignored.** A trumpet in C and a trumpet in B♭ are both simply
a *trumpet*. Sources are wildly inconsistent about whether they name the key at
all, so recording it would split one instrument into a dozen search terms that
mean the same thing to the person holding it.

This is not only a display choice — it is a correctness one. The key is stripped
*before* counting, because leaving it in strands the number from the noun:

```
"3 B-flat trumpets"   → stripped   → "3 trumpets"  → three
                      → unstripped                 → two    ✗
```

Unstripped, `3` no longer sits against `trumpets`, so the parser falls back to
plurality and guesses two. The same strip handles `trumpet in B♭`, `in Bb`,
`in C`, `E-flat cornet` and `4 trumpets in F or B-flat`. It runs per segment,
after the scoring has been split on its commas, so it can never reach across a
comma and weld two instruments together — a naive strip turns
`trumpet in C, E-flat clarinet` into `trumpet clarinet`.

A note name is only treated as a key when nothing follows it, so
`trumpet in Concert pitch` survives intact.

**Cornet is a separate instrument.** Not a kind of trumpet, and not
interchangeable with one. Berlioz, Tchaikovsky, Franck and Debussy all write for
trumpets *and* cornets at the same time, in the same score, doing different
jobs — the *Symphonie fantastique* gives the cornets their own obbligato. A band
score makes the split plainer still: Holst's *First Suite* gives the cornets the
melody and the trumpets the fanfares.

One trap this creates, and the code guards it: the **cornett** (or *cornetto*,
or *Zink*) is a Renaissance wooden instrument with nothing to do with the valved
cornet. Gabrieli's canzonas are not cornet repertoire. The pattern's word
boundary already excludes `cornetti`, and the exclusion is written down
explicitly so it stays deliberate rather than accidental.

**Bass trumpet is out of scope**, along with the trumpet marine and the organ
stop called *Trumpet*. Excluding it takes real work, because the name contains
the word being searched for. Skipping it during matching is not enough —
`bass trumpet` still holds `trumpet` for a later pattern to find. So out-of-scope
names are *erased from the text* before anything else looks at it. Without that,
Wagner's *Ride of the Valkyries* would read as four trumpets rather than three.

---

## Two ways to search

The two workflows are peers, chosen with a tab pair of equal weight rather than
one being a link inside the other's filter panel. The instrument grid is shared:
it narrows a composer's list in one mode and *is* the query in the other, so a
selection carries over when you switch and the scope note above it says which
applies. `Clear` sits outside both panels, since a search needs clearing from
either.

**By composer.** Type a name; accents are optional and near-misses are
suggested. Results group by genre, and the instrument grid then narrows them.

**By instrumentation, across every composer.** Pick one or more chips under *Must
include* and the whole catalogue is searched. Several chips mean **all** of them
— *trumpet + cornet* returns only the works needing both, not the union.
Doublings count: a flugelhorn picked up by the third trumpeter answers a
flugelhorn search even though there is no separate flugelhorn part.

Each instrument sits on its own row with a quantity beside it — *exactly 2*,
*3 or more*, and so on. Both controls are present from the moment the page
loads, and setting a quantity also selects the instrument, so neither control is
a prerequisite for the other.

**none** is the other end of the same control, and it excludes rather than
requires: *exactly 2 trumpets* with *none* against cornet finds works for a pair
of trumpets with no cornet anywhere, doublings included. An excluded instrument
is struck through in the panel and named separately in the heading — "Works
including exactly two trumpets, without cornet" — because it is a different kind
of clause from the requirements beside it.

A count means players, not printed parts. Deselecting an instrument drops its
count with it, so a rule can never outlive the instrument it applied to. Results
group by composer and render in batches of 150, since *trumpet* alone matches
thousands of works and building every row up front makes the page crawl. The
selection lives in the URL as `#i=trumpet,cornet`, so a search can be shared;
CSV export covers the whole match set rather than the batch on screen.

## Running it

**Hosted (what end users get):** <https://geoffreylaff-stack.github.io/trumpet-repertoire-finder/>

Any static host works; the repository is laid out for GitHub Pages, and
`.github/workflows/pages.yml` publishes `index.html`, `assets/`, `lib/`,
`data/works.json` and the standalone build on every push to the default branch.
A manual run publishes any branch, which is how a working branch gets reviewed
before it is merged.

Two settings have to be switched on by hand once, because they are repository
settings rather than code: the repository must be **public** (Pages on a private
repository needs a paid plan), and **Settings → Pages → Source** must be set to
**GitHub Actions**. Until Pages is enabled the build job still succeeds and only
the `deploy-pages` step fails, which is the signature of that missing setting
rather than of a broken workflow.

**Locally**, because ES modules and `fetch` need a real origin:

```bash
npm run build     # regenerate data/works.json + dist/trumpet-finder.html
python3 -m http.server 8765
# open http://localhost:8765
```

**As a single file with no server at all.** `dist/trumpet-finder.html` inlines
the markup, styles, code and the entire index into one file. Double-click it and
it runs from `file://`, offline, forever.

## Making sure a visitor has the current build

GitHub Pages serves everything with `Cache-Control: max-age=600` and an ETag,
and gives no way to set headers. A visitor returning the next day revalidates
and gets current files. Two things would otherwise go wrong inside that
ten-minute window, and both are closed without asking anyone to clear a cache:

**Content hashes in every asset URL.** `tools/build.mjs` hashes each asset and
rewrites the references — `app.js?v=6093b2dbae`, and the same for the stylesheet,
the shared parser and `works.json`. New markup therefore *cannot* load old
assets: the URL it asks for did not exist before. The hash is of file content, so
editing the CSS does not re-download the index.

**A freshness check the cache cannot answer.** `data/version.json` is a few bytes
holding the build id, fetched on load with `cache: 'no-store'`, which bypasses
the HTTP cache outright. The page compares it with the id stamped into itself and
offers a bar — *"A newer version of this index has been published. Load it"* —
when they differ. The button navigates to `?v=<newbuild>`, a URL the browser has
never seen. A `visibilitychange` listener repeats the check for a tab left open
all day, and the build id sits in the footer so it can be read off directly.

Builds are byte-identical when nothing changed, which matters more than it
sounds: a CI run that changes nothing must produce the same id, or every run
would prompt every visitor to re-download the index for nothing. The harvesters
and the build compare the *substance* — the works and composers — and leave the
file untouched when it matches (`tools/stable-json.mjs`), so a month with no
upstream change writes nothing, pushes no branch, and prompts nobody.

---

## The design problem, and why it is shaped this way

The obvious approach — a page that queries a music database live — does not
work, for two independent reasons.

**1. IMSLP sends no CORS header.** IMSLP's MediaWiki API is the best public
source of instrumentation data, and it answers happily over HTTPS. But it
returns no `Access-Control-Allow-Origin`, so a browser will refuse to hand the
response to a page on another origin. A pure client-side app cannot read it at
runtime.

**2. Where the data is good, it is good; where it matters most, it is absent.**
IMSLP's `Instrumentation` field is exact for chamber music. For orchestral works
it collapses to a single word:

```
Beethoven, Symphony No. 9       →  Instrumentation = "orchestra"
Berlioz, Symphonie fantastique  →  Instrumentation = "orchestra"
```

That is precisely the case where a trumpeter needs the detail — orchestral
scoring is where "2 trumpets + 2 cornets" is a fact worth looking up.
**Wikipedia** fills the gap: its article on an individual work usually carries an
`Instrumentation` section giving the full brass complement.

So the app is built as **a pre-computed index, shipped with the page**, drawing
on three sources in order of authority:

```
  build time (a laptop or CI, never the user's browser)
  ┌──────────────────────────────────────────────────────────┐
  │  data/curated.json          hand-checked orchestral       │  ← wins
  │  tools/harvest-wikipedia.mjs → data/wikipedia.json        │
  │      Instrumentation section, or a "scored for" sentence  │
  │  tools/harvest-imslp.mjs     → data/imslp.json            │  ← breadth
  │      pass A: category names encode exact scoring          │
  │      pass B: |Instrumentation= field, 50 pages/call       │
  │                                                           │
  │  tools/build.mjs  merges all three → data/works.json      │
  └──────────────────────────────────────────────────────────┘
                              │
  run time                    ▼
  ┌──────────────────────────────────────────────────────────┐
  │  index.html + assets/app.js  fetch data/works.json        │
  │  every search runs in memory, same origin, no network     │
  └──────────────────────────────────────────────────────────┘
```

Provenance drives the merge and the build-time checks, but it is deliberately
not shipped: `tools/build.mjs` drops the `src` and `url` fields when it writes
`data/works.json`, and the interface names no upstream catalogue.

### The harvest trick

IMSLP files works under categories whose *name is the instrumentation*:

```
Category:For 2 trumpets, cornet, trombone
Category:For trumpet, violin, viola, cello
Category:For 4 trumpets (arr)
```

Enumerating every `For …` category and keeping the ones that mention a
trumpet-family instrument yields exact scoring for thousands of chamber works
from a few hundred API calls, rather than fetching thousands of pages. A `(arr)`
suffix marks an arrangement by another hand; those are tagged and hidden by
default, so a transcription of Beethoven 9 for trumpet quartet does not
masquerade as Beethoven scoring for trumpet quartet.

### Counting: first explicit number wins

An instrument gets named more than once all the time — a reduced orchestration
listed after the main one, or plain narrative ("the trumpets are silent until
the finale"). Adding those up inflates the section. So counts are never
accumulated. Each instrument takes the **first explicit number** it is given; a
bare plural is recorded separately and only used when no number appears
anywhere, in which case the row is marked *count inferred from a plural*.

`tools/build.mjs` prints any non-curated work with more than five trumpet-family
players at build time, since that is what a counting failure looks like from the
outside.

One transport note worth recording: Wikipedia's `api.php` rate-limits this
network path hard — 429 within a handful of requests even at one per 1.2
seconds, because the address is shared rather than because of our pace. The
CDN-cached paths are not throttled at all, so the harvester reads article text
from `index.php?action=raw` and category membership from the rendered category
page.

### The curated layer

`data/curated.json` supplies what IMSLP cannot: hand-checked works concentrated
on the orchestral repertoire, each with full brass-section context and a note
where the instrument does something notable. Curated entries override harvested
ones for the same work.

Counts there are **players, not parts**, which is why a concerto counts its
soloist alongside the orchestra's own section — Haydn's Trumpet Concerto needs
three trumpeters, not one. It is deliberately a separate, human-editable file;
adding a work means adding one line, because the scoring string is parsed rather
than hand-encoded:

```json
{ "c": "berlioz-hector", "title": "Symphonie fantastique",
  "cat": "Op. 14", "year": 1830, "genre": "Symphony",
  "trumpets": "2 trumpets, 2 cornets",
  "full": "2 trumpets, 2 cornets, 4 horns, 3 trombones, 2 tubas, …" }
```

---

## Doublings are the interesting case

A flugelhorn taken up by the third trumpeter has no separate part, but somebody
still has to own one. Getting this right matters in two opposite directions, and
the app handles both:

- **It is still a flugelhorn work.** Filter by "flugelhorn" and it appears. The
  parser records doublings as *required instruments* distinct from *part counts*.
- **It is still three players**, not four. Sorting by section size does not
  promote it above a genuine four-trumpet work.

Rendered, the distinction is explicit — the doubling sits with the instrument
that actually doubles:

```
Symphonie fantastique      two trumpets, two cornets
The Rite of Spring         piccolo trumpet, four trumpets
Sinfonietta                12 trumpets
Lieutenant Kijé Suite      two trumpets, cornet
Symphony No. 9 (VW)        three trumpets, flugelhorn
```

---

## Layout

```
index.html                     app shell
assets/app.js                  search, filtering, rendering
assets/styles.css              light/dark, no external assets
lib/instrumentation.mjs        the parser — runs in Node and the browser alike
tools/harvest-imslp.mjs        build-time IMSLP harvester
tools/harvest-wikipedia.mjs    build-time Wikipedia harvester
tools/build.mjs                merge + single-file bundle
tools/test-instrumentation.mjs regression tests (npm test)
data/curated.json              hand-checked works  (edit this)
data/wikipedia.json            harvest output      (generated)
data/imslp.json                harvest output      (generated)
data/works.json                merged index the app loads (generated)
dist/trumpet-finder.html       standalone offline build (generated)
```

`lib/instrumentation.mjs` is deliberately shared rather than duplicated: the
harvester and the browser must agree on what "3 tpt." means, or filters silently
disagree with the text on screen. Everything family-specific in it lives in one
table and one pattern list at the top — which is how this repository came to
exist, as a sibling of the oboe finder with those two blocks rewritten.

## Refreshing the data

```bash
npm run harvest              # both sources
npm run harvest:imslp
npm run harvest:wikipedia
npm run build
npm test
```

The Wikipedia sweep saves after every composer and takes `--resume`, so an
interrupted run picks up where it stopped instead of starting over.

`.github/workflows/refresh-data.yml` does this monthly. It pushes the result to
a branch and links a pull request from the run summary rather than opening one
itself: creating pull requests is off by default for GitHub Actions, and a
refresh should not depend on a setting nobody remembers. Nothing is published
straight to the live site, and the run refuses a refresh that loses more than a
fifth of the index, since a renamed upstream category can gut a harvest while
every step still reports success.

---

## Known limits

Worth being straight about:

- **Coverage follows the sources.** The Wikipedia sweep covers a fixed list of
  composers (see `COMPOSERS` in the harvester) — adding a name there and
  re-running is the way to extend it. Outside that list, coverage falls back to
  IMSLP, which is public-domain-weighted and thin on recent composers.
- **A work needs an article to be found.** Wikipedia only yields a scoring where
  the individual work has its own page with an instrumentation section or a
  "scored for…" sentence.
- **Wikipedia is taken at face value.** Its scorings are used as given, without
  checking them against a score.
- **A bare plural is a guess.** `"trumpets, trombones, strings"` gives no number;
  the parser records two and flags the row *count inferred from a plural*. A
  checkbox hides these.
- **Cornet parts are often played on trumpet.** The index records what the score
  asks for, not what an orchestra does on the night. Stravinsky writes *cornet à
  pistons* in *L'Histoire du soldat*; it is nearly always played on a trumpet.
- **Editions differ.** Stravinsky's *Petrushka* has two cornets in 1911 and none
  in 1947; the curated entries say which. Confirm against a published score
  before hiring players.

Corrections belong in `data/curated.json` — they will survive the next harvest,
which is exactly why that file is separate.

## Licence

App code MIT. Work metadata derives from
[IMSLP / Petrucci Music Library](https://imslp.org), which publishes catalogue
data under CC-BY-SA.
