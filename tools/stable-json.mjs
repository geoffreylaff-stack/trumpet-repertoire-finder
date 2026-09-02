import fs from 'node:fs/promises';

/**
 * Write a data file only when its substance has actually changed.
 *
 * Every harvest stamps its output with the time it ran, and records how many
 * requests it made. Those move on every run even when the upstream catalogues
 * are identical, and that is enough to cascade: the timestamp changes
 * works.json, which changes the build id, which tells every visitor a new
 * version exists and asks them to re-download the index. A scheduled run that
 * found nothing new would still push a branch of pure churn for someone to
 * review.
 *
 * Comparing the substance — the works, and the composers where a file carries
 * them — makes an unchanged harvest a genuine no-op: the file is left exactly
 * as it was, timestamp included.
 *
 * @returns {Promise<boolean>} true when the file was rewritten.
 */
export async function writeIfChanged(file, payload) {
  // Every payload key that carries data has to be compared. Listing only works
  // and composers meant a file built around some other key — the composer dates
  // are keyed on `dates` — compared equal to itself no matter what changed, so
  // it was written once and then silently never again. The harvest kept finding
  // new composers and the file kept throwing them away.
  const substance = (o) => JSON.stringify({
    works: o?.works ?? null,
    composers: o?.composers ?? null,
    dates: o?.dates ?? null,
  });

  try {
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    if (substance(previous) === substance(payload)) return false;
  } catch {
    // No readable previous file: fall through and write.
  }

  await fs.writeFile(file, JSON.stringify(payload, null, 1));
  return true;
}
