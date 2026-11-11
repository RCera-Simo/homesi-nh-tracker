// Shared monday.com helpers used by every function in this project (status.js,
// recruiters.js, pipeline.js). Keeping the query/stage-derivation logic in one
// place means the "4-stage" tracker design only has to be maintained here.

const { computeStageClock, applyClock } = require("./stageclock");

const PIPELINE_BOARD_ID = process.env.HOMESI_PIPELINE_BOARD_ID || "18422043486";

const GROUPS = {
  RECENTLY_ADDED: "group_mm58vbsj",
  IN_PROCESS_SUPREME: "group_mm58pyra",
  COMPLETED: "group_mm585vq0",
  CANCELLED: "group_mm5hegfk",
};

// monday.com's "Estado General" / "Proceso HR Completo" status columns on this
// board carry Spanish, emoji-prefixed labels. The portal is English-facing
// (per Ricardo, 2026-09-21), so every label shown to a recruiter is translated
// here rather than passed through raw.
const STATUS_LABELS_EN = {
  "🔄 Reprogramado": "🔄 Rescheduled",
  "✅ Completado": "✅ Completed",
  "❌ Cancelado": "❌ Cancelled",
  "⏳ Pendiente": "⏳ Pending",
  "🔵 En Proceso": "🔵 In Process",
  "Pendiente": "Pending",
};
function translateStatus(label) {
  if (!label) return label;
  return STATUS_LABELS_EN[label] || label;
}

async function mondayQuery(query, variables) {
  const res = await fetch("https://api.monday.com/v2", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.MONDAY_API_TOKEN || "",
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("monday API error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

// display_value (mirrors/board-relations) > label (status) > text (everything
// else, including a plain checkbox's "v"/"" text representation) > null.
function colValue(columnValues, id) {
  const cv = columnValues.find((c) => c.id === id);
  if (!cv) return null;
  return cv.display_value ?? cv.label ?? cv.text ?? null;
}

function formatDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ---------------------------------------------------------------------------
// Supreme's own "Individual-Based HR Tracking" board (18403512766).
//
// NOTE (2026-09-21): Ricardo can't set up real mirror columns from this board
// onto the HomeSí Pipeline board for now, so — provisionally, at his request —
// we read Supreme's board directly instead of relying on mirrors. This is a
// stand-in: once mirrors exist on the HomeSí board this extra query can be
// dropped in favor of colValue() on the mirror columns.
//
// IMPORTANT (found 2026-09-21): the board_relation_mm58f8n7 link that was
// supposed to point each HomeSí item at its Supreme counterpart is only
// populated on 7 of 44 HomeSí items — it's effectively unmaintained. But
// every candidate that has reached Supreme DOES exist as an item on their
// board under a matching (or near-matching, e.g. "NAME - CANCELLED") name.
// So the primary match key here is the candidate's NAME, not the board
// relation — the relation is only used as a tie-breaker when present.
const SUPREME_HR_BOARD_ID = process.env.SUPREME_HR_BOARD_ID || "18403512766";

const SUPREME_COLS = {
  packetSent: "date_mm1gnfcv", // "New Hire Packet Sent"
  packetReceived: "date_mm1gynw0", // "Completed New Hire Packet Received"
  welcomeEmail: "date_mm1grzen", // "Informational Welcome Email" — best available closeout-date proxy
  backgroundCheck: "color_mm1gte1p", // Completed / Submitted / Consent Needed
  nmlsAccess: "color_mm1g4eey", // Yes / No / Requested
  i9: "color_mm1gxz5k", // Yes / No / Requested
  complete: "color_mm1qnsty", // "Complete" flag, label "Yes"
};

const SUPREME_BOARD_QUERY = `
query GetSupremeBoard($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 500, cursor: $cursor) {
      cursor
      items {
        id
        name
        created_at
        group { id title }
        column_values (ids: [
          "date_mm1gnfcv",
          "date_mm1gynw0",
          "date_mm1grzen",
          "color_mm1gte1p",
          "color_mm1g4eey",
          "color_mm1gxz5k",
          "color_mm1qnsty",
          "date4",
          "text_mm1g9agp",
          "text_mm1gwr",
          "color_mm1g3qct"
        ]) {
          id
          text
          ... on StatusValue { label }
        }
      }
    }
  }
}`;

// Lowercases, strips accents, collapses whitespace, drops quote marks (for
// nicknames like `Sondra "Sandy" Harrison`), drops a trailing status
// annotation Supreme sometimes appends to the name itself (e.g.
// "Juan Pazos - CANCELLED", "Alejandro Garza - NHP expired"), and drops
// middle-initial tokens (e.g. "C." in "Maria C. Oviedo-Clavijo") so a name
// recorded with a middle initial on one board still matches its
// initial-less counterpart on another — found 2026-09-23: Maria Oviedo-
// Clavijo's HomeSí item is "Maria C. Oviedo-Clavijo" but her Supreme HR
// item (created the same day her packet was sent) is just "Maria
// Oviedo-Clavijo", so the un-adjusted name key never matched and her
// "Sent to Supreme" update never showed up in the app.
function normalizeName(name) {
  if (!name) return "";
  let s = name
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/["']/g, "")
    .replace(/\s*-\s*(cancelled|on hold|nhp expired).*$/i, "")
    // A remaining hyphen is part of a compound surname ("Oviedo-Clavijo"),
    // which different boards write with a hyphen, a space, or neither —
    // treat it as a word break so all three read the same (2026-10-05).
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const withoutMiddleInitials = s.split(" ").filter((tok) => !/^[a-z]\.?$/.test(tok));
  if (withoutMiddleInitials.length >= 2) {
    s = withoutMiddleInitials.join(" ");
  }

  // Periods AND commas ("Jeovanni Diaz, Jr." vs "Jeovanni Diaz Jr.").
  return s.replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
}

// True when Supreme (or anyone) has tagged the name itself as cancelled/on
// hold — e.g. "Angel Espinoza - cancelled per Pier". normalizeName() strips
// that tag so the two spellings still key the same, which also means a
// candidate who was cancelled and later re-entered the process ends up with
// TWO Supreme items under the same key; this flag is what lets the lookup
// below prefer the right one (2026-10-05).
function hasCancelledTag(name) {
  return /\s*-\s*(cancelled|on hold|nhp expired)/i.test(name || "");
}

// Splits a normalized name into its tokens (e.g. "rosario lopez zamora" ->
// ["rosario","lopez","zamora"]).
function nameTokens(name) {
  const key = normalizeName(name);
  return key ? key.split(" ").filter(Boolean) : [];
}

// True when the shorter token list appears, in order, inside the longer one
// (not necessarily contiguous) — e.g. ["rosario","lopez"] inside
// ["rosario","lopez","zamora"]. Requires at least a first+last name (2
// tokens) on the shorter side so a single shared token never counts as a
// match on its own.
function isNameSubsetMatch(tokensA, tokensB) {
  if (tokensA.length === tokensB.length) return false; // exact match handles this case
  const [shorter, longer] = tokensA.length < tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shorter.length < 2) return false;
  let j = 0;
  for (const tok of longer) {
    if (j < shorter.length && tok === shorter[j]) j++;
  }
  return j === shorter.length;
}

// True when two words differ by at most ONE edit (a substituted, dropped,
// added or swapped-adjacent letter) — the typo/respelling class of variation
// ("Aretaga" vs "Arteaga" is a swapped pair).
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  while (i < la && i < lb && a[i] === b[i]) i++;
  if (i === la || i === lb) return true; // one is a prefix of the other, off by <=1 char
  if (la === lb) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true; // substitution
    if (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2)) return true; // swap
    return false;
  }
  return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1); // insertion/deletion
}

// SPELLING-variant fallback for when neither the exact key nor the in-order
// token-subset match finds anything (2026-10-05, per Ricardo: Supreme keeps
// re-spelling names as they find variations in public records — e.g. HomeSí
// has "Violeta Aretaga" while Supreme has "Violeta Arteaga"). Same in-order,
// every-token-of-the-shorter-side rule as isNameSubsetMatch, except a pair
// of tokens also counts as equal when both are 6+ letters and within one
// edit. Guard rails so it can't pair two DIFFERENT people (a wrong link
// would show someone else's HR status on a candidate — much worse than no
// link): the shorter side needs 2+ tokens, the FIRST name must match
// exactly (so "Maria"/"Mario"-type pairs never qualify), and callers only
// accept it when it resolves to exactly ONE record that isn't already the
// exact-name match of another pipeline candidate (see `claimedKeys` in
// resolveRecord()).
function isNameSimilarMatch(tokensA, tokensB) {
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shorter.length < 2) return false;
  if (shorter[0] !== longer[0]) return false;
  let j = 1;
  for (let k = 1; k < longer.length && j < shorter.length; k++) {
    const tok = longer[k];
    const want = shorter[j];
    if (tok === want || (tok.length >= 6 && want.length >= 6 && withinOneEdit(tok, want))) j++;
  }
  return j === shorter.length;
}

// ORDER-INSENSITIVE variant (2026-10-05): Supreme re-orders compound surnames
// when it finds a variation — HomeSí has "Matthew A Bruckner Gomez", Supreme
// has "Matthew Gomez-Bruckner". Same guard rails as isNameSimilarMatch (2+
// tokens on the shorter side, FIRST name exact, unique match only, never a
// record another pipeline candidate owns), but the remaining tokens of the
// shorter name may appear anywhere in the longer one, each used once, and may
// carry a one-letter respelling (6+ letter words).
function isNameTokenSetMatch(tokensA, tokensB) {
  const [shorter, longer] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  if (shorter.length < 2) return false;
  if (shorter[0] !== longer[0]) return false;
  const pool = longer.slice(1);
  for (let i = 1; i < shorter.length; i++) {
    const want = shorter[i];
    const at = pool.findIndex((tok) => tok === want || (tok.length >= 6 && want.length >= 6 && withinOneEdit(tok, want)));
    if (at < 0) return false;
    pool.splice(at, 1);
  }
  return true;
}

// Adds one record to a board index's name maps. `byNameAll` keeps EVERY record
// that shares a normalized name (key -> array, board order) — a candidate who
// was cancelled and later re-entered the process has two items under the same
// key, and picking "first one wins" blindly (the old behavior) could link the
// active candidate to the cancelled item. `all` is the flat list the fuzzy
// fallbacks scan.
function addToNameIndex(index, item, record) {
  const key = normalizeName(item.name);
  if (!key) return;
  if (!index.byNameAll.has(key)) index.byNameAll.set(key, []);
  index.byNameAll.get(key).push(record);
  index.all.push({ key, tokens: nameTokens(item.name), record });
}

// The set of normalized names of every HomeSí Pipeline item — passed to
// resolveRecord() so the loosest (spelling-variant) tier never grabs a record
// that is the exact-name match of ANOTHER pipeline candidate.
function pipelineNameKeys(items) {
  const keys = new Set();
  (items || []).forEach((it) => { const k = normalizeName(it.name); if (k) keys.add(k); });
  return keys;
}

// Fetches Supreme's ENTIRE HR board once (paginated) and returns
// { byId, byNameAll, all } lookup structures. One query (or a couple, if the
// board grows past 500 items) serves every candidate on the current request —
// this is deliberately fetched whole rather than per-candidate, since the
// reliable match key (name) isn't something monday can filter a single item
// by cheaply, and pipeline.js needs to resolve many candidates at once anyway.
async function fetchSupremeHrBoardIndex() {
  const index = { byId: new Map(), byNameAll: new Map(), all: [] };
  const byId = index.byId;
  let cursor = null;
  let guard = 0;
  do {
    const data = await mondayQuery(SUPREME_BOARD_QUERY, { boardId: [SUPREME_HR_BOARD_ID], cursor });
    const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
    const items = (page && page.items) || [];
    for (const item of items) {
      const cv = item.column_values;
      const record = {
        id: item.id,
        name: item.name,
        createdAt: item.created_at,
        packetSent: colValue(cv, SUPREME_COLS.packetSent),
        packetReceived: colValue(cv, SUPREME_COLS.packetReceived),
        welcomeEmail: colValue(cv, SUPREME_COLS.welcomeEmail),
        backgroundCheck: colValue(cv, SUPREME_COLS.backgroundCheck),
        nmlsAccess: colValue(cv, SUPREME_COLS.nmlsAccess),
        i9Documents: colValue(cv, SUPREME_COLS.i9),
        complete: colValue(cv, SUPREME_COLS.complete),
        // Added 2026-10-21 for the recruitment history sweep (HR tracking rows
        // that never reached the HomeSí pipeline board): start date, branch,
        // title and the HomeSí region tag ("CITY").
        startDate: colValue(cv, "date4"),
        branch: colValue(cv, "text_mm1g9agp"),
        title: colValue(cv, "text_mm1gwr"),
        region: colValue(cv, "color_mm1g3qct"),
        groupTitle: item.group ? item.group.title : null,
        cancelledTag: hasCancelledTag(item.name),
      };
      byId.set(String(item.id), record);
      addToNameIndex(index, item, record);
    }
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  return index;
}

// Resolves one HomeSí candidate against any board index (Supreme HR,
// Onboarding Pipeline, New Hire Form), strongest signal first:
//
//   1. `linkedId` — an explicit board_relation link a human set (Supreme only).
//   2. `rememberedId` — the monday item ID the persistent link registry
//      (_lib/links.js) stored the first time this candidate matched. IDs
//      survive renames, which is the whole point (2026-10-05, per Ricardo:
//      Supreme edits candidate names when it finds a second name or variation
//      in public records, and a name-only match silently dropped the
//      candidate's updates every time that happened).
//   3. Exact normalized-name key. When several records share the key (a
//      candidate cancelled and later re-entered — e.g. Angel Espinoza has
//      both "Angel Espinoza" and "Angel Espinoza - cancelled per Pier" on
//      Supreme's board), prefer the one whose cancelled-tag matches this
//      candidate's own state instead of whichever happens to come first.
//   4. Token-SUBSET match (found 2026-09-23, Rosario Lopez): one board
//      records a genuinely extra token the other lacks — "Rosario Lopez" vs
//      "Rosario Lopez Zamora".
//   5. SIMILAR-spelling match (2026-10-05): same as 4 but tolerating a
//      one-letter typo/respelling in 5+ letter words — "Violeta Aretaga" vs
//      "Violeta Arteaga".
//   6. RE-ORDERED surname match (2026-10-05): same first name, remaining
//      words in any order — "Matthew Bruckner Gomez" vs "Matthew Gomez-Bruckner".
//
// Above all of these, links.js can inject a hand-set override (aliases.js)
// as the remembered ID, for a name no automatic tier can bridge.
//
// Tiers 4 and 5 only resolve when exactly ONE record in the whole board
// qualifies — if more than one could plausibly match, it deliberately gives
// up rather than guess wrong.
function resolveRecord(index, { name, linkedId, rememberedId, isCancelled, claimedKeys }) {
  if (!index) return null;
  if (linkedId && index.byId && index.byId.has(String(linkedId))) {
    return index.byId.get(String(linkedId));
  }
  if (rememberedId && index.byId && index.byId.has(String(rememberedId))) {
    return index.byId.get(String(rememberedId));
  }

  const key = normalizeName(name);
  if (!key) return null;

  const sameKey = index.byNameAll && index.byNameAll.get(key);
  if (sameKey && sameKey.length) {
    const wantCancelled = !!isCancelled;
    const matching = sameKey.filter((r) => !!r.cancelledTag === wantCancelled);
    // A re-hire (cancelled in May, back in September — Angel Espinoza,
    // 2026-10-22) leaves TWO items under one name. Take the one in the same
    // state as this candidate; among several, the newest for an active
    // candidate and the oldest for a cancelled one.
    if (matching.length) {
      if (matching.length === 1) return matching[0];
      const ts = (r) => { const t = r.createdAt ? new Date(r.createdAt).getTime() : 0; return isNaN(t) ? 0 : t; };
      const sorted = matching.slice().sort((a, b) => ts(a) - ts(b));
      return wantCancelled ? sorted[0] : sorted[sorted.length - 1];
    }
    // Only a record in the OPPOSITE state shares the exact name. For an active
    // candidate whose old, cancelled item keeps the plain name while the live
    // one carries an extra surname ("Angel Espinoza" vs "Angel Espinoza
    // Davalos"), look for a single live record by the looser tiers first.
    if (!wantCancelled && index.all) {
      const tokensA = key.split(" ").filter(Boolean);
      const live = index.all.filter((e) => !e.record.cancelledTag && isNameSubsetMatch(tokensA, e.tokens));
      if (live.length === 1) return live[0].record;
    }
    if (wantCancelled && sameKey.length > 1) {
      const ts = (r) => { const t = r.createdAt ? new Date(r.createdAt).getTime() : 0; return isNaN(t) ? 0 : t; };
      return sameKey.slice().sort((a, b) => ts(a) - ts(b))[0]; // cancelled candidate -> the OLDEST cycle
    }
    return sameKey[0];
  }

  if (index.all) {
    const tokensA = key.split(" ").filter(Boolean);
    const subset = index.all.filter((entry) => isNameSubsetMatch(tokensA, entry.tokens));
    if (subset.length === 1) return subset[0].record;
    if (subset.length === 0) {
      const similar = index.all.filter(
        (entry) => isNameSimilarMatch(tokensA, entry.tokens) && !(claimedKeys && claimedKeys.has(entry.key))
      );
      if (similar.length === 1) return similar[0].record;
      if (similar.length === 0) {
        // 6. Re-ordered / re-spelled surnames (see isNameTokenSetMatch).
        const reordered = index.all.filter(
          (entry) => isNameTokenSetMatch(tokensA, entry.tokens) && !(claimedKeys && claimedKeys.has(entry.key))
        );
        if (reordered.length === 1) return reordered[0].record;
      }
    }
  }
  return null;
}

function lookupSupremeRecord(index, { linkedIds, name, rememberedId, isCancelled, claimedKeys }) {
  return resolveRecord(index, { name, linkedId: linkedIds && linkedIds[0], rememberedId, isCancelled, claimedKeys });
}

// ---------------------------------------------------------------------------
// "Onboarding Pipeline 🛫" board (18108170142) — where Equipment & Access is
// actually tracked (per Ricardo, 2026-09-22). No board-relation link exists
// back to the HomeSí Pipeline board at all here, so matching is name-only —
// same normalizeName() + whole-board-index approach as the Supreme board.
const ONBOARDING_BOARD_ID = process.env.ONBOARDING_BOARD_ID || "18108170142";

const ONBOARDING_COLS = {
  equipmentStatus: "color_mkwcmk4y", // Sent - Received All / Preparing to Ship / Sent - Delayed / Not Started / Not applicable — shown for reference only, no longer decides completion
  trackingNumber: "text_mm1b24k",
  // Supreme systems access — per Ricardo (2026-10-01), this is now the ONLY
  // signal for whether the "Equipment & Access" stage is complete. In
  // practice Supreme marks this "Done" once they've sent the new hire their
  // credentials/access email, so "Done"/"Not applicable" here = that email
  // went out. The old 3-way check (equipment shipped + HomeSí access +
  // Supreme access) was removed at his request — equipment-shipped is still
  // shown below for reference, but no longer gates "done".
  supremeOnboarding: "color_mkwc6tjy", // Planned / Done / Delayed / Not Started
  supremeOnboardingTarget: "date_mkwc67zn", // "Sup Onboarding Target" — used to flag this stage overdue/stuck
  // "Sup e-mail" (added 2026-10-15, per Ricardo): the Supreme-assigned Company
  // Email Address (e.g. julio.alayo@supremelending.com), read off the
  // AccessManagement welcome email by the daily UPS/credentials tracking
  // agent and written here. Used by onboarding-announce.js so the Announce
  // draft can include the new hire's Supreme email alongside their personal
  // one. Not reliably populated for every candidate — a blank value just
  // means that agent hasn't seen the AccessManagement email yet.
  supEmail: "text_mkwcbjf6",
};

const ONBOARDING_QUERY = `
query GetOnboardingBoard($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 500, cursor: $cursor) {
      cursor
      items {
        id
        name
        created_at
        column_values (ids: [
          "color_mkwcmk4y",
          "text_mm1b24k",
          "color_mkwc6tjy",
          "date_mkwc67zn",
          "text_mkwcbjf6"
        ]) {
          id
          text
          ... on StatusValue { label }
        }
      }
    }
  }
}`;

async function fetchOnboardingBoardIndex() {
  const index = { byId: new Map(), byNameAll: new Map(), all: [] };
  let cursor = null;
  let guard = 0;
  do {
    const data = await mondayQuery(ONBOARDING_QUERY, { boardId: [ONBOARDING_BOARD_ID], cursor });
    const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
    const items = (page && page.items) || [];
    for (const item of items) {
      const cv = item.column_values;
      const record = {
        id: item.id,
        name: item.name,
        createdAt: item.created_at,
        equipmentStatus: colValue(cv, ONBOARDING_COLS.equipmentStatus),
        trackingNumber: colValue(cv, ONBOARDING_COLS.trackingNumber),
        supremeOnboarding: colValue(cv, ONBOARDING_COLS.supremeOnboarding),
        supremeOnboardingTargetRaw: colValue(cv, ONBOARDING_COLS.supremeOnboardingTarget),
        supremeOnboardingTarget: formatDate(colValue(cv, ONBOARDING_COLS.supremeOnboardingTarget)),
        supEmail: colValue(cv, ONBOARDING_COLS.supEmail),
        cancelledTag: hasCancelledTag(item.name),
      };
      index.byId.set(String(item.id), record);
      addToNameIndex(index, item, record);
    }
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  return index;
}

// Generic lookup for boards (Onboarding Pipeline, New Hire Form) that have no
// board-relation link to key off of at all — remembered ID first, then the
// same exact -> subset -> similar-spelling cascade as lookupSupremeRecord
// (see resolveRecord() above).
function lookupByName(index, name, { rememberedId, isCancelled, claimedKeys } = {}) {
  return resolveRecord(index, { name, rememberedId, isCancelled, claimedKeys });
}

// ---------------------------------------------------------------------------
// "New Hire Form ✨" board (18149631343) — the very first touchpoint in the
// process (a candidate/recruiter fills this out before anything else
// happens). Added 2026-09-29 so the dashboard can measure total time-to-
// onboard starting from this real registration date instead of the HomeSí
// Pipeline item's created_at (which is created a step later, once someone
// on the HomeSí team transcribes the request onto their own board).
const NEW_HIRE_FORM_BOARD_ID = process.env.NEW_HIRE_FORM_BOARD_ID || "18149631343";

const NEW_HIRE_FORM_QUERY = `
query GetNewHireFormBoard($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 500, cursor: $cursor) {
      cursor
      items {
        id
        name
        created_at
        column_values (ids: ["short_texth3kal7a2", "short_text7tokc9gk", "datecx5vtfwh", "single_selectx5vj4yj", "color_mkwx6zc2", "short_textmubbf5vr", "single_selectcuaewa7"]) { id text }
      }
    }
  }
}`;

// Fix (2026-10-15, per Ricardo — diagnosing why "Avg. Form Registered ->
// HomeSí Received" read ~130 days): this board's item `name` is whoever
// SUBMITTED the form, almost always the recruiter, not the new hire —
// onboarding-announce.js, onboarding-announce-all.js and ready-contacts.js
// already account for this and match candidates by Legal First Name + Legal
// Last Name instead. This index was the one place still keyed by item.name,
// so lookupByName(formIndex, pipelineItem.name, ...) only ever matched the
// handful of old submissions where a recruiter happened to type the
// candidate's own name as the form title; every recruiter-submitted (i.e.
// almost every recent) candidate silently got no match at all, and
// formToReceivedDays/formToReceived ended up averaged over just that small,
// unrepresentative, mostly-months-old leftover group. Now keyed by the same
// Legal First + Last Name used everywhere else, so matching (and therefore
// the metric) is consistent across the whole codebase.
async function fetchNewHireFormBoardIndex() {
  const index = { byId: new Map(), byNameAll: new Map(), all: [], rows: [] };
  let cursor = null;
  let guard = 0;
  do {
    const data = await mondayQuery(NEW_HIRE_FORM_QUERY, { boardId: [NEW_HIRE_FORM_BOARD_ID], cursor });
    const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
    const items = (page && page.items) || [];
    for (const item of items) {
      const cv = item.column_values || [];
      const legalFirst = colValue(cv, "short_texth3kal7a2") || "";
      const legalLast = colValue(cv, "short_text7tokc9gk") || "";
      const legalName = `${legalFirst} ${legalLast}`.trim();
      const displayName = legalName || item.name; // fall back to the raw title only if Legal Name is blank
      const laptop = colValue(cv, "single_selectx5vj4yj");
      const itEquipment = colValue(cv, "color_mkwx6zc2");
      const record = {
        id: item.id, name: displayName, createdAt: item.created_at, cancelledTag: hasCancelledTag(displayName),
        // Item name = whoever SUBMITTED the form = the recruiter (Ricardo renamed
        // the column header to "Recruited by:" on 2026-10-21 to make that explicit).
        recruitedBy: (item.name || "").trim(),
        estimatedStart: colValue(cv, "datecx5vtfwh"),
        role: colValue(cv, "short_textmubbf5vr"),
        branch: colValue(cv, "single_selectcuaewa7"),
        laptop, itEquipment,
        // Is a PC/equipment being requested from Supreme for this person? "No"
        // when the form's Laptop field is blank or IT Equipment says Not
        // applicable — the branch is providing their own PC, so only Supreme
        // Systems Access needs tracking (2026-10-21, per Ricardo).
        pcRequested: pcRequestedFromForm(laptop, itEquipment),
      };
      index.byId.set(String(item.id), record);
      index.rows.push(record);
      addToNameIndex(index, { name: displayName }, record);
    }
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  return index;
}


// ---------------------------------------------------------------------------
// PC requested? (2026-10-21, per Ricardo.) The New Hire Form says whether the
// person needs a computer from Supreme. When the branch assigns one they
// already have, nothing ships: "Equipment Shipped" and "Tracking Number" are
// Not Applicable and only Supreme Systems Access is tracked, so the Equipment &
// Access node can complete on access alone. Rule agreed with Ricardo: the
// form's Laptop field is blank, OR IT Equipment says Not applicable.
function pcRequestedFromForm(laptop, itEquipment) {
  const lap = (laptop || "").toString().trim().toLowerCase();
  if (!lap) return false; // blank — or a label monday can no longer resolve (Gabriela Lozano Rendon, 2026-10-19)
  if (/^(no|none|n\/a|na|not applicable|not needed|no laptop)\b/.test(lap)) return false;
  if (["not applicable", "n/a", "na"].includes((itEquipment || "").toString().trim().toLowerCase())) return false;
  return true;
}

const EQUIPMENT_IN_MOTION = ["sent - received all", "sent - incomplete", "shipping approved", "preparing to ship", "in transit", "sent - delayed"];

// The Onboarding Pipeline record as the tracker should read it: when the form
// says no PC is needed, the two equipment sub-steps read "Not applicable" —
// unless the board itself already shows gear in motion (a status past "not
// started" or a tracking number), which always wins over an inference. Returns
// the original record untouched in every other case; a stub when the person has
// no Onboarding Pipeline row yet.
function effectiveOnboarding(onboarding, pcRequested) {
  if (pcRequested !== false) return onboarding;
  const base = onboarding || {};
  const status = (base.equipmentStatus || "").toLowerCase();
  if (EQUIPMENT_IN_MOTION.includes(status) || base.trackingNumber) return onboarding;
  return { ...base, equipmentStatus: "Not applicable", trackingNumber: null, noPc: true };
}

// ---------------------------------------------------------------------------
// Recruiter names (2026-10-21, per Ricardo). The pipeline board's Reclutador
// text is typed by hand: blank on older rows, and it shows Ricardo's own name
// when he registered a hire on a recruiter's behalf (Maria Morales, Gabriela
// Lozano Rendon). The New Hire Form's item name is the recruiter ("Recruited
// by:"), so that wins whenever it is a usable person name; the pipeline text is
// the fallback. The same recruiter is spelled many ways across boards ("Maria
// Guerrero", "MARIA TERESA GUERRERO MARTELO", "Javier Peñaloza"/"Penaloza"), so
// spellings are clustered (same first name, the shorter name's words appear in
// order in the longer one) and shown under ONE display name.
function titleCaseName(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/(^|[\s\-'"(])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase());
}

function isUsableRecruiterName(raw, candidateName) {
  const tokens = nameTokens(raw);
  if (tokens.length < 2) return false; // "Transition", "N/A", a single first name…
  const cand = nameTokens(candidateName);
  // The form was titled with the hire's OWN name (a self-submission or a
  // recruiter who typed the candidate's name) — that is not a recruiter.
  if (cand.length && (tokens.join(" ") === cand.join(" ") || isNameSubsetMatch(tokens, cand))) return false;
  return true;
}

// Which recruiter name (still un-clustered) applies to one pipeline item.
function recruiterRawFor(pipelineText, formRecord, candidateName) {
  if (formRecord && formRecord.recruitedBy && isUsableRecruiterName(formRecord.recruitedBy, candidateName)) return formRecord.recruitedBy;
  return (pipelineText || "").trim() || null;
}

// raws: [{ raw, weight }] -> Map(normalizedKey -> display name). Spellings that
// cluster together all map to the display name of the cluster's heaviest
// variant (ties: the one with more words).
function buildRecruiterCanon(raws) {
  const variants = new Map(); // key -> { display, weight, tokens }
  for (const { raw, weight } of raws) {
    const key = normalizeName(raw);
    if (!key) continue;
    const v = variants.get(key) || { display: titleCaseName(raw), weight: 0, tokens: key.split(" ").filter(Boolean), keys: key };
    v.weight += weight == null ? 1 : weight;
    variants.set(key, v);
  }
  const keys = Array.from(variants.keys());
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      const a = variants.get(keys[i]).tokens;
      const b = variants.get(keys[j]).tokens;
      if (a[0] === b[0] && isNameSubsetMatch(a, b)) parent.set(find(keys[i]), find(keys[j]));
    }
  }
  const best = new Map(); // root -> variant
  for (const k of keys) {
    const root = find(k);
    const v = variants.get(k);
    const cur = best.get(root);
    if (!cur || v.weight > cur.weight || (v.weight === cur.weight && v.tokens.length > cur.tokens.length)) best.set(root, v);
  }
  const canon = new Map();
  for (const k of keys) canon.set(k, best.get(find(k)).display);
  return canon;
}

function canonicalRecruiter(canon, raw) {
  if (!raw) return null;
  return canon.get(normalizeName(raw)) || titleCaseName(raw);
}

// For the recruiter picker / "My New Hire Process" list (recruiters.js,
// pipeline.js): Map(pipelineItemId -> canonical recruiter) using the same rule
// as the dashboard.
async function computeRecruiterAssignments(items, formIndex, links) {
  const pipelineKeys = pipelineNameKeys(items);
  const rows = items.map((item) => {
    const cv = item.column_values || [];
    const remembered = (links && links.get && links.get(String(item.id))) || {};
    const isCancelled = item.group && item.group.id === GROUPS.CANCELLED;
    const formRecord = formIndex ? lookupByName(formIndex, item.name, { rememberedId: remembered.formId, isCancelled, claimedKeys: pipelineKeys }) : null;
    return { itemId: String(item.id), raw: recruiterRawFor(colValue(cv, "text_mm58w64z"), formRecord, item.name) };
  });
  // Same weights as applyRecruiterNames() so the picker and the dashboard always agree.
  const extras = formIndex ? formIndex.rows.filter((f) => isUsableRecruiterName(f.recruitedBy, f.name)).map((f) => ({ raw: f.recruitedBy, weight: 0.01 })) : [];
  const canon = buildRecruiterCanon([...rows.filter((r) => r.raw).map((r) => ({ raw: r.raw, weight: 2 })), ...extras]);
  const out = new Map();
  rows.forEach((r) => out.set(r.itemId, canonicalRecruiter(canon, r.raw)));
  return out;
}

// ---------------------------------------------------------------------------
// Roster ("Division LOs BDs NPPMs") — only used to tell, for the recruitment
// history sweep, whether someone who registered on the New Hire Form before the
// HR-tracking board existed (before March 2026) ended up joining.
const ROSTER_BOARD_ID = process.env.ROSTER_BOARD_ID || "18400833242";
const LOA_BOARD_ID = process.env.LOA_BOARD_ID || "18408005561"; // "Division LOAs & LPs" — the second roster
const rosterQuery = (cols) => `
query GetRoster($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 500, cursor: $cursor) {
      cursor
      items {
        id
        name
        column_values (ids: [${cols.map((c) => `"${c}"`).join(", ")}]) { id text }
      }
    }
  }
}`;
const ROSTER_SOURCES = [
  { boardId: ROSTER_BOARD_ID, status: "status", branch: "dropdown_mm4p5nxh", role: "dropdown_mm5eg27r" },
  { boardId: LOA_BOARD_ID, status: "status", branch: null, role: "color_mm281tjv" },
];
async function fetchRosterIndex() {
  const index = { byId: new Map(), byNameAll: new Map(), all: [] };
  for (const src of ROSTER_SOURCES) {
    const cols = [src.status, src.branch, src.role].filter(Boolean);
    let cursor = null;
    let guard = 0;
    try {
      do {
        const data = await mondayQuery(rosterQuery(cols), { boardId: [src.boardId], cursor });
        const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
        for (const item of (page && page.items) || []) {
          const cv = item.column_values || [];
          const record = {
            id: item.id, name: item.name,
            status: colValue(cv, src.status),
            branch: src.branch ? (colValue(cv, src.branch) || "").split(",")[0].trim() : "",
            role: colValue(cv, src.role),
            cancelledTag: false,
          };
          index.byId.set(String(item.id), record);
          addToNameIndex(index, item, record);
        }
        cursor = page && page.cursor;
        guard += 1;
      } while (cursor && guard < 5);
    } catch (e) {
      // One roster board failing must not take the whole dashboard down.
      console.warn("roster board fetch failed:", src.boardId, e && e.message);
    }
  }
  return index;
}

// Whole days between two monday date/datetime strings, or null when either
// side is missing/unparseable/out of order. Used to show "how long did this
// stage take" — only shown where we have two real, comparable dates.
function daysBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
  const ms = to.getTime() - from.getTime();
  if (ms < 0) return null;
  return Math.round(ms / 86400000);
}

// Signed version of the above (toIso - fromIso, in whole days) — unlike
// daysBetween() this does NOT null out a negative result. Used for a
// plan-vs-actual gap (e.g. estimated start date vs. the date someone
// actually joined the roster) where "earlier than planned" is a meaningful,
// expected outcome, not an invalid ordering.
function daysDiffSigned(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) return null;
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

// Same done/not-done vocabulary renderChecklistRow() uses client-side
// (okValues), so a candidate-owned checklist item reads identically here and
// in the UI. Hoisted to module scope (2026-10-20) so both deriveStages()
// (Supreme HR Verification's own completion test) and buildCandidateBase()
// (candidatePendingItems / packet-pending) share the exact same rule.
function isCandidateItemDone(s) {
  return ["completed", "yes", "done", "not applicable", "n/a", "na"].includes((s || "").toLowerCase());
}

// Distinct from isCandidateItemDone(): tells whether an item's monday value
// marks it as genuinely NOT APPLICABLE to this candidate (e.g. NMLS Access
// for an LOA/BD/NPPM, or a BM who doesn't hold an NMLS license), as opposed to
// "done" in the normal completed sense. Added 2026-10-20 per Ricardo: certain
// roles (LOA, BD, NPPM, BM without an NMLS license) never need NMLS Access —
// Supreme's own board already encodes this as the status label "N/A" on
// SUPREME_COLS.nmlsAccess (confirmed live on several real candidates, e.g.
// Gabriela Lozano Rendon, Eduardo Martinez Daboud). Before this fix, "N/A"
// was NOT in isCandidateItemDone's accepted list, so these candidates' Supreme
// HR Verification stage could never complete and would sit "stuck"/"current"
// forever waiting on something that will never happen. The UI surfaces this
// as a dedicated "Not applicable" status (distinct from "Completed"), never
// silently showing it as a completed checkmark.
function isCandidateItemNotApplicable(s) {
  return ["not applicable", "n/a", "na"].includes((s || "").toLowerCase());
}

// NMLS ACCESS — BOARD IS THE SOLE SOURCE OF TRUTH (2026-10-20, per Ricardo:
// "y si dejas que el board de supreme te guie? puede haber LOA con licencia,
// así como un BD, etc..."). A role-based fallback was tried briefly (treating
// a blank NMLS Access field as "N/A" for LOA/BD/NPPM) and then explicitly
// reverted: a licensed LOA or BD is possible, so the role string can never
// reliably predict NMLS applicability for ANY role, not just BM. Supreme
// HR's own NMLS Access board value (including its own "N/A" status, handled
// where it's read via isCandidateItemDone/isCandidateItemNotApplicable) is
// shown and trusted as-is, with no role-based inference layered on top.

// NOTE (2026-09-21): "Sent to Supreme" used to be inferred from a board-relation
// link that Supreme only creates *after* opening the file — so genuinely-sent
// requests were showing as still "pending". It's now driven by the "Form
// Submitted?" checkbox Ricardo added on the board (boolean_mm7aaesv), with a
// fallback: if the item is already further along (HR verification done, or
// activated), it must have been sent regardless of whether that checkbox was
// ever retroactively checked on older items.
//
// `supreme` (optional) is the {createdAt, packetSent, packetReceived,
// welcomeEmail, backgroundCheck, i9Documents, complete} object returned by
// fetchSupremeHrBoardIndex() for this candidate's linked Supreme item, if
// any — it's the provisional source for stage dates until real mirrors exist.
// `onboarding` (optional) is the matching record from fetchOnboardingBoardIndex()
// — needed here only for the New Hire Welcome stage's "Welcome Email Sent"
// sub-item (see below).
//
// STAGE REDESIGN (2026-10-20, per Ricardo — fully approved): the pipeline now
// has SIX stage keys instead of four: received, sent, packet_processing (new),
// supreme_hr (narrowed), new_hire_welcome (new), activated. Equipment & Access
// remains its own parallel side-track, spliced in by the caller (buildCandidateBase/
// public/index.html), same as before.
function deriveStages({ groupId, hrComplete, formSubmitted, createdAt, supreme, onboarding }) {
  // `formalCloseoutDone` is the Supreme HR board's "Complete" flag (label
  // "Yes") — this used to be called `supremeHrDone` and gated the (now
  // removed) single "Supreme HR Verification" stage. It's kept under BOTH
  // names in this function's return value (supremeHrDone is the public/back-
  // compat name every other caller — dashboard.js's readyForOnboarding gate,
  // the Equipment & Access stuck gate, the formToHrDoneDays metric — already
  // keys off) because its MEANING hasn't changed: it's still "has Supreme
  // formally closed this candidate's HR file out". What changed is that the
  // on-screen "Supreme HR Verification" stage no longer waits on this flag —
  // see hrChecklistDone below — it now only gates the new "New Hire Welcome"
  // stage's "Formal HR Close-out" sub-item.
  const formalCloseoutDone = (hrComplete || "").toLowerCase() === "yes";
  const activated = groupId === GROUPS.COMPLETED;
  const sentToSupreme = !!formSubmitted || formalCloseoutDone || activated;

  // Best-available proxies, not exact timestamps of each milestone: Supreme's
  // own item was created around when they opened the file (closest evidence
  // we have that the request was sent).
  const receivedRaw = createdAt;
  const sentRaw = supreme ? supreme.createdAt : null;
  const sentDate = supreme ? formatDate(sentRaw) : null;
  const sentDays = sentToSupreme ? daysBetween(receivedRaw, sentRaw) : null;

  // --- New Hire Packet Processing (new stage, 2026-10-20) ---------------
  // Was previously folded into "Supreme HR Verification" as a
  // candidate-pending item (packetPendingOnCandidate); it's now its own
  // stage, using the same two Supreme board date columns (SUPREME_COLS.
  // packetSent / packetReceived).
  const packetSentRaw = supreme ? supreme.packetSent : null;
  const packetReceivedRaw = supreme ? supreme.packetReceived : null;
  const packetDone = !!packetReceivedRaw;
  const packetState = !sentToSupreme ? "upcoming" : packetDone ? "done" : "current";
  const packetDate = packetDone ? formatDate(packetReceivedRaw) : null;
  const packetDays = packetDone ? daysBetween(sentRaw, packetReceivedRaw) : null;

  // --- Supreme HR Verification (narrowed, 2026-10-20) --------------------
  // Per the redesign, this stage now ONLY covers Background Check, NMLS
  // Access and I-9 Documents — the New Hire Packet moved to its own stage
  // above, and the final "Complete" flag moved to New Hire Welcome below.
  // `supremeHrDone` used to also fire on `groupId === GROUPS.COMPLETED`
  // (sitting in the Completed group counted as HR done by itself). Fixed
  // 2026-10-15, per Ricardo's Jorge Betancur case: Jorge's item is already in
  // the Completed group, but his actual HR checklist isn't — Background
  // Check, NMLS Access and I-9 Documents are all still pending
  // (candidatePendingItems) — yet "Supreme HR Verification" showed
  // green/done on his timeline because of that group-based shortcut. The
  // "Ready for Onboarding" feature (2026-10-08) already deliberately avoided
  // this exact shortcut for the same reason (see the comment on
  // readyForOnboarding in buildCandidateBase below) — hrChecklistDone keeps
  // that same already-correct rule: it is driven strictly by the three
  // checklist items, never by the group. `activated` keeps its own
  // group-based meaning (HomeSí Activation is tied to the group, not to the
  // HR checklist).
  const hrChecklistDone = !!supreme
    && isCandidateItemDone(supreme.backgroundCheck)
    && isCandidateItemDone(supreme.nmlsAccess)
    && isCandidateItemDone(supreme.i9Documents);
  // SEQUENTIAL DEPENDENCY (2026-10-20, per Ricardo): Supreme HR Verification
  // depends on New Hire Packet Processing finishing first, so the two stages
  // must never both render as "current" (in progress) at once. Each stage's
  // state used to be derived purely from its own raw dates/flags, which left
  // a latent edge case: if the underlying HR-checklist columns already carry
  // values (e.g. background check done ahead of the packet coming back),
  // supreme_hr could show "current" while packet_processing was also still
  // "current". Fix: supreme_hr can only read "current" once packetDone is
  // true. It can still read "done" the moment hrChecklistDone is true
  // regardless of packet status — a genuinely completed checklist should
  // never be hidden — but it falls back to "upcoming" (not "current") while
  // the packet hasn't come back yet, so only one of the two ever shows
  // "in progress" at a time.
  const supremeHrState = !sentToSupreme
    ? "upcoming"
    : hrChecklistDone
      ? "done"
      : packetDone
        ? "current"
        : "upcoming";

  // --- New Hire Welcome (new stage, 2026-10-20) ---------------------------
  // "Welcome Email Sent" is deliberately STATUS-ONLY — no date is stored or
  // displayed for it, per Ricardo. It's derived from the Onboarding Pipeline
  // board's "Sup Onboarding" status column (ONBOARDING_COLS.supremeOnboarding)
  // reading "Done" — the SAME column equipmentState() already reads (there
  // labelled "Supreme Systems Access") to help decide when Equipment & Access
  // is done. Re-using it here is intentional, not a bug: Supreme flips that
  // one status to "Done" once they've sent the new hire their credentials/
  // welcome-email, and that is the only monday signal we have for "the
  // welcome email went out" — there's a separate SUPREME_COLS.welcomeEmail
  // DATE column ("Informational Welcome Email") on the Supreme HR board, but
  // per Ricardo this sub-item must show status only, never a date, so that
  // column is intentionally NOT used here. Because the two stages
  // (Equipment & Access vs. New Hire Welcome) read the same underlying field
  // for two different purposes, they can become "done" at the same moment or
  // at different moments (Equipment & Access additionally needs the physical
  // gear itself resolved) — both are legitimate, independent readings of the
  // same monday field.
  const welcomeEmailDone = !!(onboarding && (onboarding.supremeOnboarding || "").toLowerCase() === "done");
  // "Formal HR Close-out" is the pre-existing "Complete" flag (formalCloseoutDone
  // above) — same flag that used to gate the old single "Supreme HR
  // Verification" stage's completion.
  const newHireWelcomeState = !hrChecklistDone ? "upcoming" : formalCloseoutDone ? "done" : "current";

  const stages = [
    { key: "received", label: "Request Received", state: "done", date: formatDate(receivedRaw), days: null },
    { key: "sent", label: "Sent to Supreme", state: sentToSupreme ? "done" : "current", date: sentToSupreme ? sentDate : null, days: sentDays },
    { key: "packet_processing", label: "New Hire Packet Processing", state: packetState, date: packetDate, days: packetDays },
    { key: "supreme_hr", label: "Supreme HR Verification", state: supremeHrState, date: null, days: null },
    {
      key: "new_hire_welcome", label: "New Hire Welcome", state: newHireWelcomeState,
      // No single real date exists for "Formal HR Close-out" (the Complete
      // flag has no companion date column) and "Welcome Email Sent" is
      // deliberately dateless — so this stage shows no date, same honest
      // "don't fabricate it" rule the rest of this file follows.
      date: null, days: null,
      welcomeEmailDone, formalCloseoutDone,
    },
    {
      key: "activated",
      label: "HomeSí Activation",
      state: activated ? "done" : newHireWelcomeState === "done" ? "current" : "upcoming",
      // Best-available proxy for "when this person joined the roster":
      // packet-received, falling back to the Supreme item's own creation
      // date. (Previously this reused the welcomeEmail/packetReceived
      // "wrap-up" date; welcomeEmail is no longer read for dates per the
      // note above, so packetReceived is now the primary proxy.)
      date: activated ? formatDate(packetReceivedRaw || sentRaw) : null,
      days: null,
    },
  ];

  return { sentToSupreme, supremeHrDone: formalCloseoutDone, hrChecklistDone, packetDone, welcomeEmailDone, activated, stages };
}

// Mirrors the client-side equipmentState() in public/index.html — kept in
// sync manually (no shared bundle between the browser and the functions
// runtime). Per Ricardo (2026-10-01): "Equipment & Access" is now judged
// on Supreme Systems Access ("Done"/"Not applicable" = Supreme has sent the
// new hire their credentials/access email) PLUS (since 2026-10-14) the
// equipment itself being received or not applicable — see equipmentState().
function equipmentState(eq) {
  if (!eq) return "upcoming";
  const norm = (s) => (s || "").toLowerCase();
  const isDoneOrNA = (s) => norm(s) === "done" || norm(s) === "not applicable";
  // 2026-10-14, per Ricardo (Julio Alayo's case): Supreme Systems Access
  // "Done" (credentials sent) is NOT enough on its own — the stage also needs
  // the equipment itself resolved: received by the new hire ("Sent - Received
  // All") or genuinely not applicable (no laptop requested). Otherwise a
  // candidate whose credentials went out but whose PC was never shipped read
  // as "PC and access complete" when it is still in progress.
  const equipmentResolved = ["sent - received all", "not applicable"].includes(norm(eq.equipmentStatus));
  if (isDoneOrNA(eq.supremeOnboarding) && equipmentResolved) return "done";
  const started = (s) => s && norm(s) !== "not started" && norm(s) !== "not applicable";
  // Access can correctly still read "Not Started" while equipment itself is
  // already well underway (shipped/received) — Access is gated on HR
  // verification (background check) finishing first, so that's genuine
  // in-progress waiting, not "nothing has happened yet". Flagged by Ricardo
  // 2026-10-02 (Ivan Ibarra's case): without this, a candidate whose gear
  // already shipped read as "upcoming", which looks wrong next to a done
  // Supreme HR Verification step with only Access left pending.
  const shippedStatuses = ["sent - received all", "sent - incomplete", "shipping approved", "preparing to ship", "in transit", "sent - delayed"];
  const equipmentShipped = shippedStatuses.includes(norm(eq.equipmentStatus)) || !!eq.trackingNumber;
  return (started(eq.supremeOnboarding) || equipmentShipped) ? "current" : "upcoming";
}

// Which team a stuck "Equipment & Access" stage should be routed to
// (2026-10-20, per the stage redesign — previously always hardcoded to
// "access"). Mirrors the client-side equipmentBlockingAreaFor() in
// public/index.html — kept in sync manually, same as equipmentState() above.
// Judgment call: when BOTH the physical shipment and Supreme Systems Access
// are still unresolved, "it" (shipping) is picked as the blocker — shipping
// is the earlier step in the real-world sequence (gear usually goes out
// before/alongside credentials), so it's the more actionable thing to ask
// about first. FOLLOWUP_EMAIL_IT / AREA_LABELS.it already existed in
// followup.js but were dead code until this change — this is what makes them
// reachable.
function equipmentBlockingArea(eq) {
  if (!eq) return "access";
  const norm = (s) => (s || "").toLowerCase();
  const equipmentResolved = ["sent - received all", "not applicable"].includes(norm(eq.equipmentStatus));
  const credentialsDone = norm(eq.supremeOnboarding) === "done" || norm(eq.supremeOnboarding) === "not applicable";
  if (!equipmentResolved) return "it";
  if (!credentialsDone) return "access";
  return "access"; // both already resolved — shouldn't normally be reached while "stuck"
}

// ---------------------------------------------------------------------------
// Dashboard aggregation (added 2026-09-29). Fetches the whole HomeSí Pipeline
// board plus all three cross-board indices ONCE, builds a rich record per
// candidate, and derives:
//   - historical averages per stage (across every candidate with a real,
//     valid duration for that stage — not just fully-completed ones, so the
//     sample is as large as the data honestly allows)
//   - "stuck" thresholds = 1.5x that average (falling back to a conservative
//     default when there isn't yet enough history — never a guess dressed
//     up as data)
//   - per-candidate stuck flags for whichever stage is currently open

const PIPELINE_ALL_QUERY = `
query GetPipelineAll($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 500, cursor: $cursor) {
      cursor
      items {
        id
        name
        created_at
        updated_at
        group { id title }
        column_values (ids: [
          "color_mm7y14g3",
          "text_mm58aak7",
          "text_mm58gmv3",
          "date_mm587sc0",
          "color_mm58w9bv",
          "text_mm58w64z",
          "color_mm5ahy53",
          "boolean_mm7aaesv",
          "board_relation_mm58f8n7"
        ]) {
          id
          text
          ... on BoardRelationValue { linked_item_ids }
          ... on StatusValue { label }
        }
      }
    }
  }
}`;

async function fetchAllPipelineItems() {
  const items = [];
  let cursor = null;
  let guard = 0;
  do {
    const data = await mondayQuery(PIPELINE_ALL_QUERY, { boardId: [PIPELINE_BOARD_ID], cursor });
    const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
    const pageItems = (page && page.items) || [];
    items.push(...pageItems);
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  return items;
}

function average(nums) {
  const valid = nums.filter((n) => typeof n === "number" && !isNaN(n));
  if (!valid.length) return null;
  const sum = valid.reduce((a, b) => a + b, 0);
  return { avgDays: Math.round((sum / valid.length) * 10) / 10, count: valid.length };
}

// Builds one candidate's base record from a raw pipeline item plus the
// cross-board indices. Pulled out of assembleDashboard() (2026-10-01) so
// status.js can reuse the exact same per-candidate shape — and, critically,
// the same stuckStages logic below — for a single item's detail page,
// instead of re-deriving a second, possibly-inconsistent notion of "stuck".
// `formIndex` is optional: pass it when the form→received/form→HR-done
// metrics are needed (dashboard.js), omit it otherwise (status.js, which
// only needs this for stuckStages and doesn't fetch that board).
// A board item's name with any status tag ("- CANCELLED PER GALO") and stray
// whitespace removed — what Supreme "calls" the person, for display and for
// detecting a rename.
function cleanDisplayName(name) {
  return (name || "").replace(/\s*-\s*(cancelled|on hold|nhp expired).*$/i, "").replace(/\s+/g, " ").trim();
}

// `links` (optional) is the persistent link registry Map from _lib/links.js:
// homesiItemId -> { supremeId, onboardingId, formId, supremeName, ... }. Lookups
// try the remembered IDs BEFORE falling back to name matching, so a rename on
// Supreme's side doesn't orphan the candidate (see resolveRecord() above).
// The returned `_link` is what the dashboard should write back to the
// registry; `supremeRenamedFrom` is set when the remembered Supreme item now
// carries a different name than it did when first linked.
function buildCandidateBase(item, { supremeIndex, onboardingIndex, formIndex, links, pipelineKeys, events, nowMs }) {
  const cv = item.column_values;
  const groupId = item.group.id;
  const linkedIds = (cv.find((c) => c.id === "board_relation_mm58f8n7") || {}).linked_item_ids || [];
  const remembered = (links && links.get && links.get(String(item.id))) || {};
  const isCancelled = groupId === GROUPS.CANCELLED;
  const claimedKeys = pipelineKeys;
  const supreme = lookupSupremeRecord(supremeIndex, { linkedIds, name: item.name, rememberedId: remembered.supremeId, isCancelled, claimedKeys });
  const onboarding = lookupByName(onboardingIndex, item.name, { rememberedId: remembered.onboardingId, isCancelled, claimedKeys });
  const formRecord = formIndex ? lookupByName(formIndex, item.name, { rememberedId: remembered.formId, isCancelled, claimedKeys }) : null;

  const supremeName = supreme ? cleanDisplayName(supreme.name) : null;
  const supremeRenamedFrom =
    supreme && remembered.supremeId && String(remembered.supremeId) === String(supreme.id) && remembered.supremeName &&
    normalizeName(remembered.supremeName) !== normalizeName(supreme.name)
      ? remembered.supremeName
      : null;
  const _link = {
    supremeId: supreme ? String(supreme.id) : null,
    supremeName,
    onboardingId: onboarding ? String(onboarding.id) : null,
    onboardingName: onboarding ? cleanDisplayName(onboarding.name) : null,
    formId: formRecord ? String(formRecord.id) : null,
    formName: formRecord ? cleanDisplayName(formRecord.name) : null,
  };
  const hrComplete = (supreme && supreme.complete) || colValue(cv, "color_mm5ahy53");
  const formSubmitted = colValue(cv, "boolean_mm7aaesv") === "v";
  const role = colValue(cv, "text_mm58gmv3");

  // Equipment & Access as it should be READ (2026-10-21): when the New Hire Form
  // says no PC is requested, the equipment sub-steps are Not Applicable and only
  // Supreme Systems Access decides the node. `onboarding` stays the raw board
  // record (used for link bookkeeping); `onb` is the effective one used below.
  const pcRequested = formRecord ? formRecord.pcRequested : null;
  const onb = effectiveOnboarding(onboarding, pcRequested);

  const { supremeHrDone, hrChecklistDone, activated, stages } = deriveStages({
    groupId,
    hrComplete,
    formSubmitted,
    createdAt: item.created_at,
    supreme,
    onboarding: onb,
  });

  const eqState = equipmentState(onb);
  const equipStage = { key: "equipment", label: "Equipment & Access", state: eqState, date: null, days: null };

  // Stage durations (2026-10-21): Supreme HR Verification, Equipment & Access,
  // New Hire Welcome and HomeSí Activation have no date columns, so their start/
  // end come from the monday activity log (see _lib/stagesync.js). No events =
  // no durations, never a guess.
  const clockNow = nowMs || Date.now();
  if (events) {
    const clock = computeStageClock({
      events,
      boards: { supreme: SUPREME_HR_BOARD_ID, onboarding: ONBOARDING_BOARD_ID, pipeline: PIPELINE_BOARD_ID },
      ids: { supreme: supreme && supreme.id, onboarding: onboarding && onboarding.id, pipeline: item.id },
      cols: {
        backgroundCheck: SUPREME_COLS.backgroundCheck, nmlsAccess: SUPREME_COLS.nmlsAccess, i9: SUPREME_COLS.i9,
        complete: SUPREME_COLS.complete, supremeOnboarding: ONBOARDING_COLS.supremeOnboarding,
        equipmentStatus: ONBOARDING_COLS.equipmentStatus, estado: "color_mm58w9bv",
      },
      supreme, onboarding: onb, noPc: !!(onb && onb.noPc),
      sentRaw: supreme ? supreme.createdAt : null,
    });
    stages.forEach((st) => { if (clock[st.key]) applyClock(st, clock[st.key], clockNow); });
    applyClock(equipStage, clock.equipment, clockNow);
  }
  // READY FOR ONBOARDING (2026-10-08, per Ricardo): every HR step is complete
  // (Supreme "Complete" = Yes, or the pipeline's own "Proceso HR Completo" =
  // Yes — NOT merely sitting in the Completed group, which can happen with HR
  // still Pending) AND every IT step is complete (Equipment & Access done =
  // Supreme credentials sent), and nobody has marked the person "Onboarded"
  // in monday yet. Applies to anyone, whether still In Process or already in
  // the Completed group. Only Ricardo marks "Onboarded" (column
  // color_mm7y14g3) — that is the one manual click that removes someone.
  const hrStepsDone = (hrComplete || "").toLowerCase() === "yes";
  const onboardedMarked = !!colValue(cv, "color_mm7y14g3");
  const readyForOnboarding = hrStepsDone && eqState === "done" && !onboardedMarked && groupId !== GROUPS.CANCELLED;

  // Which specific Supreme HR Verification items are still waiting on the
  // CANDIDATE (not on Supreme's HR team) — used to make a "stuck" follow-up
  // honest about who actually needs to act (2026-10-02, per Ricardo/Angel
  // Espinoza's case: the step read "stuck" and the follow-up email went to
  // HR, when NMLS Access/I-9/Background Check were the only things left and
  // all three are the candidate's own action). isCandidateItemDone() is now
  // hoisted module-level (see above deriveStages) so this and the stage's own
  // "done" test can never disagree.
  const candidatePendingItems = supreme
    ? [
        !isCandidateItemDone(supreme.backgroundCheck) ? "Background Check" : null,
        !isCandidateItemDone(supreme.nmlsAccess) ? "NMLS Access" : null,
        !isCandidateItemDone(supreme.i9Documents) ? "I-9 Documents" : null,
      ].filter(Boolean)
    : [];
  // New Hire Packet (2026-10-16, per Ricardo/Jorge Betancur's case; moved to
  // its own "packet_processing" stage 2026-10-20): once Supreme has SENT the
  // packet (packetSent has a date), getting it signed and back is entirely on
  // the candidate — same reasoning as Background Check/NMLS Access/I-9 above,
  // just for its own stage now instead of folded into Supreme HR
  // Verification's candidatePendingItems. Only flagged once it's actually
  // been sent: before that, Supreme/HomeSí hasn't even gotten it to the
  // candidate yet, so there's nothing for the candidate to act on.
  const packetPendingOnCandidate = !!(supreme && supreme.packetSent && !supreme.packetReceived);
  const packetCandidatePendingItems = packetPendingOnCandidate ? ["New Hire Packet (signed & returned)"] : [];

  const receivedRaw = item.created_at;
  const sentRaw = supreme ? supreme.createdAt : null;
  const formRaw = formRecord ? formRecord.createdAt : null;
  // Informational-only proxy for the "Avg. Sent → Supreme HR Complete" /
  // "Avg. Form → Onboarded" dashboard KPI tiles (metrics.sentToHrDone /
  // formToHrDoneDays below) — NOT used by any stage's own done/date logic
  // any more (see deriveStages). Kept as the same welcomeEmail-or-
  // packetReceived proxy these two KPIs always used, so the tiles don't
  // regress just because the stage timeline itself was restructured.
  const wrapupRaw = supreme ? (supreme.welcomeEmail || supreme.packetReceived) : null;

  return {
    itemId: String(item.id),
    name: item.name,
    role,
    branch: colValue(cv, "text_mm58aak7"),
    // Raw recruiter (form's "Recruited by:" first, pipeline text second);
    // assembleDashboard/status.js replace it with the clustered display name via
    // applyRecruiterNames().
    recruiter: recruiterRawFor(colValue(cv, "text_mm58w64z"), formRecord, item.name),
    pcRequested,
    noPc: !!(onb && onb.noPc),
    estimatedStart: formatDate(colValue(cv, "date_mm587sc0")),
    _estimatedStartRaw: colValue(cv, "date_mm587sc0"),
    estadoRaw: colValue(cv, "color_mm58w9bv"),
    _createdRaw: item.created_at,
    _formCreatedRaw: formRecord ? formRecord.createdAt : null,
    group: item.group.title,
    cancelled: groupId === GROUPS.CANCELLED,
    activated,
    supremeHrDone,
    readyForOnboarding,
    onboardedMarked,
    _updatedRaw: item.updated_at,
    hrChecklistDone,
    candidatePendingItems,
    packetPendingOnCandidate,
    packetCandidatePendingItems,
    // How Supreme currently spells this candidate (null when not matched yet)
    // — shown when it differs from the HomeSí item's own name, and kept by the
    // link registry so a later rename is detectable.
    supremeName,
    supremeRenamedFrom,
    _link,
    stages,
    equipStage,
    trackingNumber: onb && onb.trackingNumber,
    // Supreme-assigned Company Email Address (e.g. julio.alayo@supremelending.com),
    // from the Onboarding Pipeline's "Sup e-mail" column — see ONBOARDING_COLS.supEmail.
    // null until the UPS/credentials tracking agent has seen the
    // AccessManagement welcome email for this candidate.
    supEmail: onboarding && onboarding.supEmail,
    // "Sup Onboarding Target" is the target date tied directly to Supreme
    // Systems Access — the one thing that now determines this stage's
    // completion — so it's what overdue/stuck is judged against.
    equipmentTargetRaw: onb && onb.supremeOnboardingTargetRaw,
    // Which team ("it" for physical shipping, "access" for Supreme Systems
    // Access/credentials) a stuck Equipment & Access flag should route to —
    // see equipmentBlockingArea() above (2026-10-20: this used to be
    // hardcoded to "access" always).
    equipmentBlockingArea: equipmentBlockingArea(onb),
    _receivedRaw: receivedRaw,
    _sentRaw: sentRaw,
    _wrapupRaw: wrapupRaw,
    _packetReceivedRaw: supreme ? supreme.packetReceived : null,
    formToReceivedDays: daysBetween(formRaw, receivedRaw),
    formToHrDoneDays: supremeHrDone ? daysBetween(formRaw, wrapupRaw) : null,
  };
}

// FIXED 7-day "stuck" threshold (2026-10-20, per Ricardo — fully approved),
// replacing the old dynamic 1.5x-historical-average system
// (DEFAULT_THRESHOLD_DAYS/THRESHOLD_MULTIPLIER/MIN_SAMPLE_FOR_REAL_AVERAGE,
// all removed). Applied UNIFORMLY to every stage — sent, packet_processing,
// supreme_hr, new_hire_welcome, AND equipment — rather than a different
// number (or a different mechanism entirely, for equipment) per stage.
const FIXED_THRESHOLD_DAYS = 7;
const STUCK_STAGE_KEYS = ["sent", "packet_processing", "supreme_hr", "new_hire_welcome", "equipment"];

// computeThresholds() is kept — status.js and dashboard.js's own code don't
// call it any more directly (assembleDashboard() does, below), but it's left
// in place as a thin function, per the redesign's explicit instruction, so
// nothing importing it breaks. It no longer computes a historical average or
// a multiplier — every stage simply gets the same fixed 7-day number.
// Flags pipeline items that were created in a BULK LOAD: 5 or more items whose
// creation time falls in the same minute (the July 16 and July 23, 2026 loads
// that filled the board with people whose forms already existed). Items added
// one at a time never trigger this. Mutates `base` (sets bulkLoaded).
function markBulkLoaded(base) {
  const perMinute = new Map();
  base.forEach((c) => {
    const k = (c._createdRaw || "").slice(0, 16); // YYYY-MM-DDTHH:MM
    if (k) perMinute.set(k, (perMinute.get(k) || 0) + 1);
  });
  base.forEach((c) => { c.bulkLoaded = (perMinute.get((c._createdRaw || "").slice(0, 16)) || 0) >= 5; });
  return base;
}

function computeThresholds(nonCancelledBase) {
  // Still real, non-fabricated informational KPIs for the dashboard's metric
  // tiles ("Avg. Received → Sent to Supreme", "Avg. Sent → Supreme HR
  // Complete", etc.) — these are display-only now and no longer feed the
  // "stuck" calculation at all (see computeStuckStages below).
  const metrics = {
    receivedToSent: average(nonCancelledBase.map((c) => (c.stages.find((s) => s.key === "sent") || {}).days)),
    sentToHrDone: average(nonCancelledBase.map((c) => daysBetween(c._sentRaw, c._wrapupRaw))),
    // 2026-10-22 (per Ricardo): items created in a bulk load (see markBulkLoaded)
    // say nothing about how fast a registered form reaches the pipeline — their
    // form is months older than the item only because the board was filled in one
    // go — so they are left out, and counted in `excluded` so the tile can say so.
    formToReceived: (() => {
      const kept = nonCancelledBase.filter((c) => !c.bulkLoaded);
      const avg = average(kept.map((c) => c.formToReceivedDays));
      const excluded = nonCancelledBase.filter((c) => c.bulkLoaded && c.formToReceivedDays != null).length;
      return avg ? { ...avg, excluded } : (excluded ? { avgDays: null, count: 0, excluded } : null);
    })(),
    formToHrDone: average(nonCancelledBase.map((c) => c.formToHrDoneDays)),
  };

  const thresholds = {};
  STUCK_STAGE_KEYS.forEach((key) => {
    thresholds[key] = { days: FIXED_THRESHOLD_DAYS, isFallback: false };
  });

  return { metrics, thresholds };
}

// Per-candidate stuckStages. Every one of the 5 stages below now computes its
// OWN stuck status independently (elapsed >= 7 days since the stage's own
// start date, not yet complete) and independently enables its OWN "Request
// Follow Up" button, routed to the correct party (2026-10-20 redesign).
// Shared by the dashboard's candidate list AND a single candidate's Full
// Timeline (status.js) so a stage either reads "stuck" in both places or
// neither — never one disagreeing with the other.
function computeStuckStages(c, thresholds, nowIso) {
  const stageByKey = {};
  c.stages.forEach((s) => { stageByKey[s.key] = s; });
  const stuckStages = [];

  // --- Sent to Supreme — unchanged: internal HomeSí delay, no follow-up
  // button (no external party owns this step).
  if (stageByKey.sent && stageByKey.sent.state === "current") {
    const elapsed = daysBetween(c._receivedRaw, nowIso);
    if (elapsed != null && elapsed > thresholds.sent.days) {
      stuckStages.push({
        stageKey: "sent", stageLabel: "Sent to Supreme", daysInStage: elapsed,
        thresholdDays: thresholds.sent.days, area: null, canFollowUp: false,
      });
    }
  }

  // --- New Hire Packet Processing (new, 2026-10-20) — routes to the
  // candidate when they're the one sitting on it (packet sent but not yet
  // signed/returned), otherwise to Supreme HR (the packet was never sent in
  // the first place, which is on Supreme).
  if (stageByKey.packet_processing && stageByKey.packet_processing.state === "current") {
    const elapsed = daysBetween(c._sentRaw, nowIso);
    if (elapsed != null && elapsed > thresholds.packet_processing.days) {
      const packetCandidatePendingItems = c.packetCandidatePendingItems || [];
      stuckStages.push({
        stageKey: "packet_processing", stageLabel: "New Hire Packet Processing", daysInStage: elapsed,
        thresholdDays: thresholds.packet_processing.days, area: "hr", canFollowUp: true,
        blockedByCandidate: !!c.packetPendingOnCandidate,
        candidatePendingItems: packetCandidatePendingItems,
      });
    }
  }

  // --- Supreme HR Verification (narrowed, 2026-10-20) — Background Check,
  // NMLS Access, I-9 Documents only now; packet handling moved above.
  if (stageByKey.supreme_hr && stageByKey.supreme_hr.state === "current") {
    const elapsed = daysBetween(c._sentRaw, nowIso);
    if (elapsed != null && elapsed > thresholds.supreme_hr.days) {
      const candidatePendingItems = c.candidatePendingItems || [];
      stuckStages.push({
        stageKey: "supreme_hr", stageLabel: "Supreme HR Verification", daysInStage: elapsed,
        thresholdDays: thresholds.supreme_hr.days, area: "hr", canFollowUp: true,
        // True when every outstanding item in this stage is one only the
        // CANDIDATE can act on (Background Check consent, NMLS Access,
        // I-9 Documents) — lets the follow-up email (and its on-screen
        // label) say so honestly instead of implying Supreme's HR team is
        // the one sitting on it.
        blockedByCandidate: candidatePendingItems.length > 0,
        candidatePendingItems,
      });
    }
  }

  // --- New Hire Welcome (new, 2026-10-20) — "Welcome Email Sent" has no
  // date and generates no stuck signal on its own; only "Formal HR
  // Close-out" not completing within 7 days of entering this stage flags it,
  // routed to Supreme HR. Stage "entry" has no dedicated date column (the
  // Complete flag isn't paired with one), so — same judgment call as the
  // stage's own date field — elapsed is measured from the best available
  // proxy: packet-received, falling back to Sent-to-Supreme.
  if (stageByKey.new_hire_welcome && stageByKey.new_hire_welcome.state === "current") {
    const entryRaw = (c._packetReceivedRaw) || c._sentRaw;
    const elapsed = daysBetween(entryRaw, nowIso);
    if (elapsed != null && elapsed > thresholds.new_hire_welcome.days) {
      stuckStages.push({
        stageKey: "new_hire_welcome", stageLabel: "New Hire Welcome", daysInStage: elapsed,
        thresholdDays: thresholds.new_hire_welcome.days, area: "hr", canFollowUp: true,
        blockedByCandidate: false, candidatePendingItems: [],
      });
    }
  }

  // --- Equipment & Access (reconciled, 2026-10-20): now uses the SAME
  // elapsed-since-entry, fixed-7-day rule as every other stage, rather than
  // the old overdue-vs-target-date mechanism. There's no dedicated "when did
  // this stage start" date column, so — like Supreme HR Verification, which
  // this runs in parallel with — elapsed is measured from Sent to Supreme
  // (the earliest point this process could plausibly have started). Gated on
  // hrChecklistDone (2026-10-02, per Ricardo/Ivan Ibarra's case, preserved
  // from before but now keyed off the precise Background-Check/NMLS/I-9 flag
  // instead of the broader overall-Complete flag): Access is genuinely
  // blocked on HR verification (background check) finishing first — it
  // shouldn't be flagged as stuck on Supreme/IT while that prerequisite
  // itself isn't done; that's already visible as the "supreme_hr" stuck flag
  // above. The old target-date "overdue" signal is preserved as an
  // independent, informational field (targetOverdueDays) rather than
  // removed outright, since Ricardo may still find it useful — but it no
  // longer gates the stuck flag or the follow-up button, per the redesign.
  if (c.equipStage.state !== "done" && c.hrChecklistDone) {
    const elapsed = daysBetween(c._sentRaw, nowIso);
    if (elapsed != null && elapsed > thresholds.equipment.days) {
      const targetOverdueDays = c.equipmentTargetRaw ? daysBetween(c.equipmentTargetRaw, nowIso) : null;
      stuckStages.push({
        stageKey: "equipment", stageLabel: "Equipment & Access", daysInStage: elapsed,
        thresholdDays: thresholds.equipment.days, area: c.equipmentBlockingArea, canFollowUp: true,
        targetOverdueDays: targetOverdueDays != null && targetOverdueDays > 0 ? targetOverdueDays : null,
      });
    }
  }

  return stuckStages;
}


// Replaces each candidate's raw recruiter with the clustered display name
// (see buildRecruiterCanon). `extraRaws` are additional spellings that should
// join the clustering without influencing which spelling wins (the HR-tracking /
// form-only people of the history sweep). Returns the canon map.
function applyRecruiterNames(base, extraRaws) {
  const canon = buildRecruiterCanon([
    ...base.filter((c) => c.recruiter).map((c) => ({ raw: c.recruiter, weight: 2 })),
    ...(extraRaws || []).filter(Boolean).map((raw) => ({ raw, weight: 0.01 })),
  ]);
  base.forEach((c) => { c.recruiter = canonicalRecruiter(canon, c.recruiter); });
  return canon;
}

// ---------------------------------------------------------------------------
// RECRUITMENT HISTORY (2026-10-21, per Ricardo — moved here from the KYN
// dashboard, and swept back to the earliest data that exists). One row per
// person who entered the hiring process, from three boards, strongest first:
//
//   1. HomeSí Pipeline board (since Mar 2026 start dates) — status from Estado
//      General / group, recruiter from the form's "Recruited by:".
//   2. Supreme's Individual-Based HR Tracking, region CITY (since Mar 2026) —
//      people who never got a pipeline item. Completed = the "Complete" flag.
//   3. New Hire Form (since Oct 2025) — people with no HR-tracking row at all.
//      Their outcome is read off the roster: on the roster (Active, Onboarding,
//      Resigned, Terminated) = hired; otherwise "unknown" (counted in the
//      funnel's total, never in Completed).
//
// status: done | canc | open | unknown.   date = start date (est. start).
// registeredAt = earliest REAL registration evidence (New Hire Form creation,
// else Supreme's item creation, else the pipeline item's creation) — used for
// "Avg. Time to Fill". Data before October 2025 does not exist in any board.
const HIRED_ROSTER_STATUSES = ["active", "onboarding", "inactive", "resigned", "terminated"];

function isoDay(v) {
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v));
  return m ? m[1] : null;
}

function buildRecruitmentRows({ base, supremeIndex, formIndex, rosterIndex, pipelineKeys }) {
  const rows = [];
  const usedSupreme = new Set();
  const usedForm = new Set();
  const rowIndex = { byId: new Map(), byNameAll: new Map(), all: [] };
  const remember = (row) => addToNameIndex(rowIndex, { name: row.name }, row);

  // 1. Pipeline board.
  for (const c of base) {
    const date = isoDay(c._estimatedStartRaw);
    if (c._link && c._link.supremeId) usedSupreme.add(String(c._link.supremeId));
    if (c._link && c._link.formId) usedForm.add(String(c._link.formId));
    if (!date) continue;
    const completed = (c.estadoRaw || "").toLowerCase().includes("completado") || c.activated;
    const row = {
      name: cleanDisplayName(c.name), branch: c.branch || "", role: c.role || "", recruiterRaw: c.recruiter || null,
      date, status: c.cancelled ? "canc" : completed ? "done" : "open", source: "pipeline", itemId: c.itemId,
      registeredAt: c._formCreatedRaw || c._sentRaw || c._createdRaw || null,
    };
    rows.push(row);
    remember(row);
  }

  // 2. Supreme HR tracking, HomeSí region only, not already on the pipeline.
  const hrRecords = Array.from(supremeIndex.byId.values()).filter((r) => (r.region || "").toUpperCase() === "CITY" && !usedSupreme.has(String(r.id)));
  for (const r of hrRecords) {
    if (/\bcontract\b/i.test(r.name)) continue; // contractors are not recruitment hires
    const date = isoDay(r.startDate);
    if (!date) continue;
    const name = cleanDisplayName(r.name);
    if (resolveRecord(rowIndex, { name, isCancelled: r.cancelledTag, claimedKeys: pipelineKeys })) continue; // same person already counted
    const form = formIndex ? resolveRecord(formIndex, { name, isCancelled: r.cancelledTag }) : null;
    if (form) usedForm.add(String(form.id));
    const row = {
      name, branch: /^\d{3}$/.test((r.branch || "").trim()) ? r.branch.trim() : (form && form.branch) || "", role: r.title || (form && form.role) || "",
      recruiterRaw: form && isUsableRecruiterName(form.recruitedBy, name) ? form.recruitedBy : null,
      date, status: r.cancelledTag ? "canc" : (r.complete || "").toLowerCase() === "yes" ? "done" : "open", source: "hr-tracking",
      registeredAt: (form && form.createdAt) || r.createdAt || null,
    };
    rows.push(row);
    remember(row);
  }

  // 3. New Hire Form only (before HR tracking existed, or never reached it).
  if (formIndex) {
    for (const f of formIndex.rows) {
      if (usedForm.has(String(f.id)) || f.cancelledTag) continue;
      const date = isoDay(f.estimatedStart);
      if (!date) continue;
      if (resolveRecord(rowIndex, { name: f.name, claimedKeys: pipelineKeys })) continue;
      const roster = rosterIndex ? resolveRecord(rosterIndex, { name: f.name }) : null;
      const hired = roster && HIRED_ROSTER_STATUSES.includes((roster.status || "").toLowerCase());
      const future = new Date(`${date}T00:00:00Z`).getTime() > Date.now();
      const row = {
        name: f.name, branch: (roster && roster.branch) || f.branch || "", role: (roster && roster.role) || f.role || "",
        recruiterRaw: isUsableRecruiterName(f.recruitedBy, f.name) ? f.recruitedBy : null,
        date, status: hired ? "done" : future ? "open" : "unknown", source: "form",
        registeredAt: f.createdAt || null,
      };
      rows.push(row);
      remember(row);
    }
  }
  return rows;
}

// Final shape sent to the browser: compact, recruiter clustered, registration
// turned into whole days-to-start where it is a valid (non-negative) figure.
function shapeRecruitment(rows, canon) {
  const out = rows.map((r) => {
    let daysToStart = null;
    if (r.registeredAt) {
      const d = Math.round((new Date(`${r.date}T00:00:00Z`).getTime() - new Date(r.registeredAt).getTime()) / 86400000);
      if (!isNaN(d)) daysToStart = d;
    }
    return {
      name: r.name, branch: r.branch, role: r.role,
      recruiter: canonicalRecruiter(canon, r.recruiterRaw),
      date: r.date, status: r.status, source: r.source, daysToStart, itemId: r.itemId || null,
    };
  }).sort((a, b) => (a.date < b.date ? 1 : -1));
  const bySource = { pipeline: 0, "hr-tracking": 0, form: 0 };
  out.forEach((r) => { bySource[r.source] += 1; });
  return {
    rows: out,
    bySource,
    earliest: out.length ? out[out.length - 1].date : null,
  };
}

// One call for "history rows + clustered recruiter names": builds the recruitment
// rows, then rewrites every pipeline candidate's recruiter to the canonical
// spelling (mutates `base`), and shapes the rows for the browser. The dashboard,
// the recruiter picker and "My New Hire Process" all go through this so they can
// never disagree about who recruited whom.
function resolveRecruitment({ base, supremeIndex, formIndex, rosterIndex, pipelineKeys }) {
  const rows = buildRecruitmentRows({ base, supremeIndex, formIndex, rosterIndex, pipelineKeys });
  const canon = applyRecruiterNames(base, rows.map((r) => r.recruiterRaw));
  return shapeRecruitment(rows, canon);
}

// Everything the recruiter screens need (picker + "My New Hire Process" list):
// canonical recruiter on every pipeline candidate (`base`) and the full history
// (`recruitment`), which also holds people who were hired BEFORE the pipeline
// board existed (form-only / HR-tracking-only rows) — e.g. Fred Gomez.
async function loadRecruiterContext({ links, events } = {}) {
  const nowMs = Date.now();
  const [items, supremeIndex, onboardingIndex, formIndex, rosterIndex] = await Promise.all([
    fetchAllPipelineItems(),
    fetchSupremeHrBoardIndex(),
    fetchOnboardingBoardIndex(),
    fetchNewHireFormBoardIndex().catch((e) => { console.warn("form index failed:", e && e.message); return null; }),
    fetchRosterIndex().catch((e) => { console.warn("roster fetch failed:", e && e.message); return null; }),
  ]);
  const pipelineKeys = pipelineNameKeys(items);
  const base = items.map((item) => buildCandidateBase(item, { supremeIndex, onboardingIndex, formIndex, links, pipelineKeys, events, nowMs }));
  const recruitment = resolveRecruitment({ base, supremeIndex, formIndex, rosterIndex, pipelineKeys });
  return { base, recruitment };
}

// `links` is the persistent link registry Map (see _lib/links.js). Besides the
// dashboard payload, this returns `linkUpdates` (homesiItemId -> freshly
// resolved cross-board link, for EVERY pipeline item including cancelled
// ones) so dashboard.js — the registry's single writer — can persist any new
// or changed link; it's kept off the JSON the browser receives.
async function assembleDashboard({ links, events } = {}) {
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const [items, supremeIndex, onboardingIndex, formIndex, rosterIndex] = await Promise.all([
    fetchAllPipelineItems(),
    fetchSupremeHrBoardIndex(),
    fetchOnboardingBoardIndex(),
    fetchNewHireFormBoardIndex(),
    fetchRosterIndex().catch((e) => { console.warn("roster fetch failed:", e && e.message); return null; }),
  ]);

  const pipelineKeys = pipelineNameKeys(items);
  const base = items.map((item) => buildCandidateBase(item, { supremeIndex, onboardingIndex, formIndex, links, pipelineKeys, events, nowMs }));

  // Recruitment history + one clustered recruiter name everywhere.
  const recruitment = resolveRecruitment({ base, supremeIndex, formIndex, rosterIndex, pipelineKeys });
  const linkUpdates = {};
  base.forEach((c) => { linkUpdates[c.itemId] = c._link; });
  const nonCancelled = base.filter((c) => !c.cancelled);
  markBulkLoaded(base);
  const { metrics, thresholds } = computeThresholds(nonCancelled);

  // Ready-for-Onboarding list (anyone not cancelled, In Process or already in
  // the Completed group): raw, no readyAt yet — dashboard.js owns the
  // first-seen store and fills that in.
  const readyRecentRaw = nonCancelled
    .filter((c) => c.readyForOnboarding)
    .map((c) => ({
      itemId: c.itemId, name: c.name, role: c.role, branch: c.branch,
      recruiter: c.recruiter, updatedAtRaw: c._updatedRaw, sentRaw: c._sentRaw,
    }));

  const candidates = nonCancelled.map((c) => {
    const stuckStages = computeStuckStages(c, thresholds, nowIso);
    const { _receivedRaw, _sentRaw, _updatedRaw, _wrapupRaw, _packetReceivedRaw, _estimatedStartRaw, _createdRaw, _formCreatedRaw, bulkLoaded, estadoRaw, equipmentTargetRaw, equipmentBlockingArea, _link, ...rest } = c;
    return { ...rest, stuckStages };
  });

  // The dashboard's working list (cards + "In Process" tile) drops someone
  // ONLY when Ricardo marks "Onboarded" on the pipeline board (onboardedMarked,
  // column color_mm7y14g3) — 2026-10-15, per Ricardo. It used to drop them as
  // soon as the pipeline item's GROUP became "Completed" (`activated` below),
  // which removed people the moment HR/IT work finished even though nobody
  // had manually onboarded them yet (e.g. Julio Alayo vanished from the
  // dashboard this way). `activated` is kept as its own flag — it still
  // drives the per-candidate "HomeSí Activation" timeline stage (status.js)
  // and the separate "Activated (Roster)" tile count below — but it no
  // longer controls list visibility. This is a manual step for now; a later
  // pass may automate flipping "Onboarded" itself.
  const inProcess = candidates.filter((c) => !c.onboardedMarked);
  // People already Ready for Onboarding (HR + IT done) are no longer "in
  // process" — they only wait for their onboarding session — so they are
  // counted ONLY in the Ready tile (2026-10-14). The cards list below still
  // shows them (READY tag + Announce button) via `candidates`.
  const stillInProcess = inProcess.filter((c) => !c.readyForOnboarding);
  const activatedCount = candidates.filter((c) => c.activated).length;

  function countBy(arr, keyFn) {
    const m = new Map();
    arr.forEach((c) => { const k = keyFn(c) || "Unspecified"; m.set(k, (m.get(k) || 0) + 1); });
    return Array.from(m.entries()).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  }

  return {
    generatedAt: nowIso,
    totals: {
      inProcess: stillInProcess.length,
      readyForOnboarding: readyRecentRaw.length,
      activated: activatedCount,
    },
    byRole: countBy(stillInProcess, (c) => c.role),
    byBranch: countBy(stillInProcess, (c) => c.branch),
    metrics,
    thresholds,
    candidates: inProcess,
    readyRecentRaw,
    recruitment,
    linkUpdates,
  };
}

module.exports = {
  PIPELINE_BOARD_ID,
  GROUPS,
  SUPREME_HR_BOARD_ID,
  SUPREME_COLS,
  ONBOARDING_BOARD_ID,
  ONBOARDING_COLS,
  NEW_HIRE_FORM_BOARD_ID,
  mondayQuery,
  colValue,
  deriveStages,
  translateStatus,
  formatDate,
  daysBetween,
  daysDiffSigned,
  fetchSupremeHrBoardIndex,
  lookupSupremeRecord,
  fetchOnboardingBoardIndex,
  fetchNewHireFormBoardIndex,
  fetchAllPipelineItems,
  lookupByName,
  resolveRecord,
  addToNameIndex,
  pipelineNameKeys,
  cleanDisplayName,
  normalizeName,
  equipmentState,
  equipmentBlockingArea,
  isCandidateItemDone,
  isCandidateItemNotApplicable,
  FIXED_THRESHOLD_DAYS,
  buildCandidateBase,
  computeThresholds,
  computeStuckStages,
  assembleDashboard,
  markBulkLoaded,
  resolveRecruitment,
  loadRecruiterContext,
  fetchRosterIndex,
  computeRecruiterAssignments,
  applyRecruiterNames,
  effectiveOnboarding,
  pcRequestedFromForm,
  buildRecruiterCanon,
  canonicalRecruiter,
  isUsableRecruiterName,
  recruiterRawFor,
  buildRecruitmentRows,
  shapeRecruitment,
};
