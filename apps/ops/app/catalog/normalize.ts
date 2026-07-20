// PR384 — Effect standard (shared by the save path AND the Browse facet so they never drift):
//  • each effect token is SENTENCE CASE — first letter up, the rest down ("Glow in the dark").
//  • multiple effects are split on , + / &, de-duped, sorted alphabetically (case-insensitive),
//    and re-joined with " + "  →  "Glow in the dark + Silhouette".
// Idempotent: normalising an already-canonical value returns it unchanged. Returns '' for empty input.
export function normalizeEffect(raw: string | null | undefined): string {
  const toks = String(raw ?? '')
    .split(/\s*[,+/&]\s*/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  const uniq = [...new Set(toks)]; // tokens are already canonical-cased, so this dedupes case variants too
  uniq.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return uniq.join(' + ');
}
