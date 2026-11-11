// Netlify Blobs-backed storage for "Request Follow Up on Process" requests —
// added 2026-09-29. Kept deliberately dumb: this module only reads/writes a
// single JSON array. The "is this resolved yet?" logic lives in dashboard.js,
// which already has fresh monday.com state on every load and can compare it
// against these records (see followupHasAdvanced() below for the partial-
// progress comparison both dashboard.js and status.js share).
//
// Blobs credential handling (manual siteID + token fallback) lives in
// ./blobs.js — shared with links.js.
const { openStore } = require("./blobs");

const STORE_NAME = "followups";
const KEY = "all";

function store() {
  return openStore(STORE_NAME);
}

async function getAllFollowups() {
  const data = await store().get(KEY, { type: "json" });
  return Array.isArray(data) ? data : [];
}

async function saveAllFollowups(list) {
  await store().setJSON(KEY, list);
}

async function createFollowup(record) {
  const list = await getAllFollowups();
  list.push(record);
  await saveAllFollowups(list);
  return record;
}

// Every item Supreme HR Verification can be waiting on the CANDIDATE for
// (same three names buildCandidateBase() puts in candidatePendingItems).
const ALL_CANDIDATE_ITEMS = ["Background Check", "NMLS Access", "I-9 Documents"];

// PARTIAL-progress check shared by dashboard.js (which writes the "resolved"
// mark) and status.js (which only mirrors it read-only): has anything this
// follow-up was requested about moved since? `current` is the CURRENT stuck
// stage object for the same (itemId, stageKey).
//
// - Records created after 2026-10-02 carry a `candidatePendingItems` snapshot
//   of what was outstanding AT REQUEST TIME — progress = any of those no
//   longer pending now.
// - LEGACY records (created before the snapshot existed — the field is
//   absent entirely, e.g. Ivan Ibarra's from 2026-10-02 01:32Z) have no such
//   snapshot, so the best available baseline is "every candidate-owned item
//   Supreme HR Verification can wait on". That can over-trigger (an item
//   already done BEFORE the request counts as "progress" now), but the cost
//   of a false reset is only that the Request Follow Up button reappears,
//   whereas a false "Awaiting response" blocks the recruiter indefinitely.
//   (2026-10-05, per Ricardo: Ivan's button should have reset after Background
//   Check/I-9 cleared.)
// - A snapshot that is present but EMPTY means nothing candidate-owned was
//   pending when asked (HR itself was the blocker) — no per-item progress to
//   detect there, so that stays false.
function followupHasAdvanced(followup, currentStage) {
  if (!followup || !currentStage || !Array.isArray(currentStage.candidatePendingItems)) return false;
  let baseline;
  if (Array.isArray(followup.candidatePendingItems)) {
    baseline = followup.candidatePendingItems;
  } else if (followup.stageKey === "supreme_hr") {
    baseline = ALL_CANDIDATE_ITEMS; // legacy record, no snapshot
  } else {
    baseline = [];
  }
  if (!baseline.length) return false;
  const stillPending = new Set(currentStage.candidatePendingItems);
  return baseline.some((item) => !stillPending.has(item));
}

module.exports = { getAllFollowups, saveAllFollowups, createFollowup, followupHasAdvanced };
