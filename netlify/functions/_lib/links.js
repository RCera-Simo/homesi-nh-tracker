// Persistent cross-board link registry (added 2026-10-05, per Ricardo).
//
// Problem: every HomeSí Pipeline item is tied to its Supreme HR item, its
// Onboarding Pipeline item and its New Hire Form item by NAME only (the
// board_relation column is empty on almost every row, and populating it would
// also switch on the "Sync HR Complete" scheduled task for those rows — a much
// bigger side effect than just "show their data"). But Supreme keeps editing
// candidate names — adding a second name, a nickname in quotes, a corrected
// spelling — whenever they find a variation in public records. The moment that
// happens, a name-only match silently breaks and the candidate's updates
// (equipment, access, background check, ...) stop showing up.
//
// Fix: the first time a candidate is successfully matched by name, remember
// the matched record's monday item ID here, keyed by the HomeSí item ID.
// monday item IDs never change when an item is renamed, so every later lookup
// resolves by ID first and only falls back to name matching for candidates
// that have never been linked. Per-board IDs + the name each had when linked
// are stored, so a later rename is also detectable (see nameChange in
// monday.js's buildCandidateBase()).
//
// Single-writer rule, same as followups: ONLY dashboard.js writes this
// registry (it already loads every candidate on each call); status.js and
// pipeline.js only read it. A registry read failing must never break a page,
// so getLinkMap() swallows errors and returns an empty Map (= pure name
// matching, i.e. exactly the behavior from before this file existed).
const { openStore } = require("./blobs");
const ALIASES = require("./aliases");

const STORE_NAME = "links";
const KEY = "all";

function store() {
  return openStore(STORE_NAME);
}

async function getLinkObject() {
  try {
    const data = await store().get(KEY, { type: "json" });
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {};
  }
}

// Map(homesiItemId -> { supremeId, supremeName, onboardingId, onboardingName,
//                        formId, formName, updatedAt })
//
// Hand-set overrides from aliases.js are layered on top: they win over a
// remembered ID (a human knows better than the first automatic match did), and
// work even when the Blobs store is unreachable.
async function getLinkMap() {
  const obj = await getLinkObject();
  const map = new Map(Object.entries(obj));
  for (const [itemId, alias] of Object.entries(ALIASES || {})) {
    const prev = map.get(String(itemId)) || {};
    map.set(String(itemId), {
      ...prev,
      supremeId: alias.supremeId ? String(alias.supremeId) : prev.supremeId || null,
      onboardingId: alias.onboardingId ? String(alias.onboardingId) : prev.onboardingId || null,
      formId: alias.formId ? String(alias.formId) : prev.formId || null,
    });
  }
  return map;
}

function sameLink(a, b) {
  if (!a || !b) return false;
  return (
    a.supremeId === b.supremeId && a.supremeName === b.supremeName &&
    a.onboardingId === b.onboardingId && a.onboardingName === b.onboardingName &&
    a.formId === b.formId && a.formName === b.formName
  );
}

// Merges freshly-resolved links into the stored registry and writes it only
// when something actually changed. `updates` is an object of
// homesiItemId -> link (missing sides are null); a null side NEVER erases a
// previously-remembered ID — a candidate that temporarily fails to match
// (say, the other board's item was just renamed to something unmatchable)
// keeps its last known good link rather than losing it. Returns the number
// of entries written.
async function upsertLinks(updates) {
  const current = await getLinkObject();
  let changed = 0;
  const nowIso = new Date().toISOString();
  for (const [itemId, fresh] of Object.entries(updates || {})) {
    const prev = current[itemId] || {};
    const merged = {
      supremeId: fresh.supremeId || prev.supremeId || null,
      supremeName: fresh.supremeId ? fresh.supremeName : (prev.supremeName || null),
      onboardingId: fresh.onboardingId || prev.onboardingId || null,
      onboardingName: fresh.onboardingId ? fresh.onboardingName : (prev.onboardingName || null),
      formId: fresh.formId || prev.formId || null,
      formName: fresh.formId ? fresh.formName : (prev.formName || null),
    };
    if (!merged.supremeId && !merged.onboardingId && !merged.formId) continue;
    if (sameLink(prev, merged)) continue;
    current[itemId] = { ...merged, updatedAt: nowIso };
    changed += 1;
  }
  if (changed) await store().setJSON(KEY, current);
  return changed;
}

module.exports = { getLinkMap, upsertLinks };
