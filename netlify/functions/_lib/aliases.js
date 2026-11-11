// Hand-set candidate -> board-item overrides (added 2026-10-05).
//
// The tracker links each HomeSí Pipeline item to its Supreme HR / Onboarding
// Pipeline / New Hire Form items automatically (monday item ID remembered in
// the link registry, else by name — see _lib/monday.js resolveRecord()). When
// Supreme renames someone so drastically that no automatic rule can bridge
// the two spellings, pin the link here instead. Keys are HomeSí Pipeline item
// IDs; values are the monday item IDs on the other boards (any may be omitted).
// An ID here beats everything else, and survives any later rename because IDs
// never change.
//
// Example:
//   "13074957205": { supremeId: "1234567890", onboardingId: "1234567891", formId: "1234567892" },
//
// Redeploy after editing. Leave `{}` when there is nothing to pin.
module.exports = {
  // Angel Espinoza — re-hire (first cycle cancelled in May, active again since
  // September). The plain name also belongs to the cancelled records, so pin the
  // live ones: Supreme HR "Angel Espinoza Davalos" and the September Onboarding item.
  "13027963801": { supremeId: "13027998422", onboardingId: "13020566372" },
};
