// Netlify Function: GET /.netlify/functions/dashboard
//
// Powers the PMO-facing dashboard home screen: how many New Hire requests
// are in flight, broken down by role/branch, who's ready for onboarding
// (Supreme HR complete + equipment & access both done, but not yet flipped
// to the "Completed" group), historical average duration per stage, and
// which candidates currently have a stage flagged "stuck" — reconciled
// against any open follow-up requests logged via followup.js.
//
// This is also the SINGLE WRITER for two Blobs-backed stores (so two
// endpoints never race to write the same record): follow-up "resolved" marks,
// and the cross-board link registry (_lib/links.js) that keeps a candidate
// tied to their Supreme / Onboarding / New Hire Form items by monday item ID
// even after Supreme renames them.

const { assembleDashboard, daysBetween } = require("./_lib/monday");
const { getAllFollowups, saveAllFollowups, followupHasAdvanced } = require("./_lib/followups");
const { getLinkMap, upsertLinks } = require("./_lib/links");
const { openStore, blobsProblem } = require("./_lib/blobs");
const { syncStageEvents } = require("./_lib/stagesync");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

exports.handler = async (event) => {
  connectBlobs(event);
  if (!isAdmin(event)) return adminDenied();
  if (!process.env.MONDAY_API_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "MONDAY_API_TOKEN not configured" }) };
  }

  try {
    const links = await getLinkMap();
    // Stage durations (Supreme HR / Equipment / Welcome / Activation) come from
    // monday's activity log, synced here (single writer) at most every 15 min.
    const events = await syncStageEvents();
    const dash = await assembleDashboard({ links, events });
    const followups = await getAllFollowups();
    const nowIso = new Date().toISOString();

    // Persist any newly-resolved or changed cross-board links (best effort —
    // a Blobs hiccup must never take the dashboard down; the next load will
    // simply try again).
    const linkUpdates = dash.linkUpdates;
    delete dash.linkUpdates;
    try {
      await upsertLinks(linkUpdates);
    } catch (e) {
      console.warn("link registry write failed:", e && e.message);
    }

    // A stage still appearing in a candidate's stuckStages means it's still
    // stuck right now. Any OPEN follow-up whose (itemId, stageKey) no longer
    // shows up there has moved on since it was requested — mark it resolved,
    // using this reconciliation moment as the closest available proxy for
    // "when it got fixed" (we don't have monday's exact change timestamp for
    // the underlying field, only that it changed by the time we looked).
    const stillStuck = new Map(); // "itemId:stageKey" -> current stuckStage object
    dash.candidates.forEach((c) => c.stuckStages.forEach((s) => stillStuck.set(`${c.itemId}:${s.stageKey}`, s)));

    let changed = false;
    for (const f of followups) {
      if (f.resolvedAt) continue;
      const current = stillStuck.get(`${f.itemId}:${f.stageKey}`);
      if (!current) {
        f.resolvedAt = nowIso;
        f.resolvedVia = "monday";
        changed = true;
        continue;
      }
      // PARTIAL progress (added 2026-10-02, per Ricardo; legacy-record
      // handling added 2026-10-05): the stage as a whole can still read
      // "stuck" (e.g. Supreme HR Verification isn't fully done) while one of
      // the specific items this follow-up was requested about has actually
      // moved since — e.g. Background Check cleared but NMLS Access hasn't.
      // followupHasAdvanced() (see _lib/followups.js) compares what was
      // pending at request time against what's pending now; if anything
      // cleared, this follow-up is resolved so the button comes back for
      // whatever's STILL outstanding, rather than showing "Awaiting
      // response" indefinitely until every last item clears.
      if (followupHasAdvanced(f, current)) {
        f.resolvedAt = nowIso;
        f.resolvedVia = "progress";
        changed = true;
      }
    }
    if (changed) {
      try { await saveAllFollowups(followups); } catch (e) { console.warn("follow-up log write failed:", e && e.message); }
    }

    // Surface any still-open follow-up on its matching stuck stage so the UI
    // can show "Awaiting response since <date>" instead of the button again.
    dash.candidates.forEach((c) => c.stuckStages.forEach((s) => {
      const open = followups.find((f) => f.itemId === c.itemId && f.stageKey === s.stageKey && !f.resolvedAt);
      if (open) {
        s.followupRequestedAt = open.requestedAt;
      }
    }));

    // "Announce Onboarding" log (written only by onboarding-announce.js; read
    // here so a READY card can show when it was already announced). Best
    // effort — never allowed to take the dashboard down.
    try {
      const announced = (await openStore("onboarding-announcements").get("all", { type: "json" })) || {};
      dash.candidates.forEach((c) => {
        const a = announced[c.itemId];
        if (a && a.announcedAt) c.onboardingAnnouncedAt = a.announcedAt;
      });
    } catch (e) {
      console.warn("announcement log read failed:", e && e.message);
    }

    // "Ready for Onboarding" card (2026-10-08, per Ricardo). Ready = all HR
    // steps and all IT steps complete (see readyForOnboarding in
    // _lib/monday.js) and the "Onboarded" status on the pipeline board still
    // blank. Only Ricardo can clear someone, by marking "Onboarded" in monday
    // (no button or PIN on this public site). For the first 7 days they show as new;
    // after that they STAY on the list, flagged overdue (red), until marked.
    // The clock starts the first time this dashboard saw the person as ready
    // (Blobs store "ready-first-seen"); until then, monday's own
    // last-updated time is the best available proxy. Best effort — a Blobs
    // failure falls back to that proxy and never takes the dashboard down.
    const READY_WINDOW_DAYS = 7;
    const rawReady = dash.readyRecentRaw || [];
    delete dash.readyRecentRaw;
    let seen = {};
    const readyStore = openStore("ready-first-seen");
    try {
      seen = (await readyStore.get("all", { type: "json" })) || {};
    } catch (e) {
      console.warn("ready-first-seen read failed:", e && e.message);
    }
    const nowMs = Date.now();
    let seenChanged = false;
    const nextSeen = {};
    const readyRecent = rawReady.map((r) => {
      let readyAt = seen[r.itemId] && seen[r.itemId].readyAt;
      if (!readyAt) {
        const t = r.updatedAtRaw ? new Date(r.updatedAtRaw).getTime() : NaN;
        readyAt = new Date(isNaN(t) ? nowMs : Math.min(t, nowMs)).toISOString();
        seenChanged = true;
      }
      nextSeen[r.itemId] = { readyAt };
      const daysSince = Math.floor((nowMs - new Date(readyAt).getTime()) / 86400000);
      // Length of the whole process: from the moment the request was sent to
      // Supreme (their HR item's creation) to the moment the person became
      // ready. readyAt is when this dashboard first saw them ready (or
      // monday's last-updated time before that), so it can trail the true
      // moment by however long nobody loaded the dashboard.
      const processDays = r.sentRaw ? daysBetween(r.sentRaw, readyAt) : null;
      return {
        itemId: r.itemId, name: r.name, role: r.role, branch: r.branch, recruiter: r.recruiter,
        readyAt, daysSince, overdue: daysSince >= READY_WINDOW_DAYS,
        sentAt: r.sentRaw || null, processDays,
      };
    }).sort((a, b) => (a.readyAt < b.readyAt ? 1 : -1));
    // Anyone no longer on the list (marked Onboarded, or moved off Completado)
    // drops out of the store too, so a later re-entry starts a fresh clock.
    if (Object.keys(seen).some((id) => !nextSeen[id])) seenChanged = true;
    if (seenChanged) {
      try {
        await readyStore.setJSON("all", nextSeen);
      } catch (e) {
        console.warn("ready-first-seen write failed:", e && e.message);
      }
    }
    dash.readyRecent = readyRecent;
    dash.totals.readyRecent = readyRecent.length;
    dash.totals.readyOverdue = readyRecent.filter((r) => r.overdue).length;
    dash.totals.readyForOnboarding = readyRecent.length;

    const resolved = followups.filter((f) => f.resolvedAt);
    dash.metrics.followupResponse = resolved.length
      ? {
          avgHours: Math.round(
            (resolved.reduce((sum, f) => sum + (new Date(f.resolvedAt) - new Date(f.requestedAt)), 0) / resolved.length) / 3600000 * 10
          ) / 10,
          count: resolved.length,
        }
      : null;

    // Saved data (follow-up log, link memory, ready-since dates, stage durations)
    // lives in Netlify Blobs. If its credentials are missing the page still loads,
    // but says so instead of silently showing empty history.
    if (blobsProblem()) {
      dash.warnings = [`Saved data is unavailable (Netlify Blobs said: ${blobsProblem()}). A 401 means the NETLIFY_BLOBS_TOKEN of this site is invalid or expired: create a new Netlify personal access token, replace it under Site configuration → Environment variables, and redeploy. Follow-up history, stage durations and ready-since dates stay blank until then.`];
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify(dash),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
