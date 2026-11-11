// Collects the monday activity-log events that _lib/stageclock.js turns into
// per-stage durations (added 2026-10-21, per Ricardo).
//
// WHY: three of the stage transitions Ricardo wants timed (Supreme HR
// Verification finishing, Equipment & Access finishing, the Complete flag)
// have no date column on any board — but monday's activity log records the
// exact moment every status changed. This module reads those logs for just the
// columns that matter and keeps a compact copy in Netlify Blobs
// ("stage-events"), so a dashboard load only ever asks monday for what
// happened since the last sync.
//
// Single-writer rule (same as followups/links): ONLY dashboard.js calls
// syncStageEvents(); every other function reads with getStageEvents(), which
// never touches monday and never throws (a missing store = no durations, the
// rest of the page is unaffected).
//
// Stored shape: { syncedAt, events: { "<boardId>:<itemId>": { "<colId>": [[epochMs, label], ...] } } }
// Each list is sorted oldest-first and de-duplicated by (time, label).

const { mondayQuery, PIPELINE_BOARD_ID, SUPREME_HR_BOARD_ID, SUPREME_COLS, ONBOARDING_BOARD_ID, ONBOARDING_COLS } = require("./monday");
const { openStore, blobsProblem } = require("./blobs");

const STORE = "stage-events";
const KEY = "all";
const FRESH_MS = 15 * 60 * 1000; // don't ask monday more often than this
const OVERLAP_MS = 6 * 3600 * 1000; // re-read a little before the last sync so nothing slips between runs
const FIRST_SYNC_FROM = "2026-03-01T00:00:00Z"; // the HR tracking board starts in March 2026
const PAGE_LIMIT = 1000;
const MAX_PAGES = 12;
const CHUNK_MS = 30 * 86400000; // first catch-up reads the history one month at a time
const BUDGET_MS = 7000; // a Netlify function can be cut off at ~10 s — stop early, resume on the next load

// What to watch on each board (column ids).
const WATCH = [
  { boardId: SUPREME_HR_BOARD_ID, columns: [SUPREME_COLS.packetReceived, SUPREME_COLS.backgroundCheck, SUPREME_COLS.nmlsAccess, SUPREME_COLS.i9, SUPREME_COLS.complete] },
  { boardId: ONBOARDING_BOARD_ID, columns: [ONBOARDING_COLS.supremeOnboarding, ONBOARDING_COLS.equipmentStatus] },
  { boardId: PIPELINE_BOARD_ID, columns: ["color_mm58w9bv", "color_mm7y14g3"] }, // Estado General, Onboarded
];

const LOGS_QUERY = `
query ActivityLogs($boardId: [ID!], $columns: [String], $from: ISO8601DateTime, $to: ISO8601DateTime, $limit: Int, $page: Int) {
  boards (ids: $boardId) {
    activity_logs (column_ids: $columns, from: $from, to: $to, limit: $limit, page: $page) {
      id
      event
      data
      created_at
    }
  }
}`;

// monday's raw API returns created_at as a 17-digit string in 1/10,000 ms.
function logTimeMs(createdAt) {
  const n = Number(createdAt);
  if (!isFinite(n)) return null;
  return n > 1e15 ? Math.round(n / 10000) : n > 1e11 ? n : n * 1000;
}

// The label/date/text a column was SET TO by one log entry (null = cleared).
function logValue(value) {
  if (!value || typeof value !== "object") return null;
  if (value.label && typeof value.label === "object") return value.label.text || null;
  if (typeof value.label === "string") return value.label;
  if (value.date) return value.date;
  if (value.value != null) return String(value.value);
  return null;
}

function ingestLog(events, boardId, log) {
  if (!log || log.event !== "update_column_value") return false;
  let data;
  try { data = typeof log.data === "string" ? JSON.parse(log.data) : log.data; } catch (e) { return false; }
  if (!data) return false;
  const itemId = data.pulse_id || data.item_id;
  const columnId = data.column_id;
  const at = logTimeMs(log.created_at);
  if (!itemId || !columnId || at == null) return false;
  const key = `${boardId}:${itemId}`;
  const byCol = events[key] || (events[key] = {});
  const list = byCol[columnId] || (byCol[columnId] = []);
  const label = logValue(data.value);
  if (list.some((e) => e[0] === at && e[1] === label)) return false;
  list.push([at, label]);
  return true;
}

async function fetchBoardLogs(events, spec, fromIso, toIso) {
  let added = 0;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await mondayQuery(LOGS_QUERY, { boardId: [spec.boardId], columns: spec.columns, from: fromIso, to: toIso, limit: PAGE_LIMIT, page });
    const logs = (data && data.boards && data.boards[0] && data.boards[0].activity_logs) || [];
    for (const log of logs) if (ingestLog(events, spec.boardId, log)) added += 1;
    if (logs.length < PAGE_LIMIT) break;
  }
  return added;
}

async function getStageEvents() {
  try {
    const data = await openStore(STORE).get(KEY, { type: "json" });
    return (data && data.events) || null;
  } catch (e) {
    return null;
  }
}

// Brings the stored events up to date (at most once per FRESH_MS) and returns
// them. Never throws: on any failure it returns whatever is already stored.
// The very first catch-up (March 2026 → today) is read in monthly windows and
// stops when the time budget runs out; each board remembers how far it got
// (`doneTo`) and the next dashboard load carries on from there.
async function syncStageEvents() {
  const store = openStore(STORE);
  // No Blobs = nowhere to keep the history, and re-reading months of it on every
  // load would only slow the page down: skip (durations stay blank).
  if (blobsProblem()) return {};
  let stored = null;
  try { stored = await store.get(KEY, { type: "json" }); } catch (e) { stored = null; }
  const events = (stored && stored.events) || {};
  const doneTo = Object.assign({}, (stored && stored.doneTo) || {});
  // Records written before the windowed sync existed only carry syncedAt.
  if (stored && stored.syncedAt && !stored.doneTo) WATCH.forEach((w) => { doneTo[w.boardId] = new Date(stored.syncedAt).getTime(); });
  const lastFull = stored && stored.syncedAt ? new Date(stored.syncedAt).getTime() : null;
  if (lastFull && Date.now() - lastFull < FRESH_MS) return events;

  const started = Date.now();
  let caughtUp = true;
  try {
    for (const spec of WATCH) {
      try {
        for (;;) {
          const nowMs = Date.now();
          const fromMs = doneTo[spec.boardId] ? doneTo[spec.boardId] - OVERLAP_MS : new Date(FIRST_SYNC_FROM).getTime();
          const toMs = Math.min(fromMs + CHUNK_MS, nowMs);
          if (toMs - fromMs < 60 * 1000) break;
          if (nowMs - started > BUDGET_MS) { caughtUp = false; break; }
          await fetchBoardLogs(events, spec, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
          doneTo[spec.boardId] = toMs;
          if (toMs >= nowMs) break;
        }
      } catch (e) {
        // One board failing (say, no access to Supreme's board log) must not
        // stop the others — and the stage durations that depend on it simply
        // stay blank rather than wrong.
        caughtUp = false;
        console.warn(`activity log sync failed for board ${spec.boardId}:`, e && e.message);
      }
    }
    Object.values(events).forEach((byCol) => Object.values(byCol).forEach((list) => list.sort((a, b) => a[0] - b[0])));
    await store.setJSON(KEY, { syncedAt: caughtUp ? new Date().toISOString() : (stored && stored.syncedAt) || null, doneTo, events });
    return events;
  } catch (e) {
    console.warn("stage events sync failed:", e && e.message);
    return events;
  }
}

module.exports = { syncStageEvents, getStageEvents, ingestLog, logTimeMs, logValue };
