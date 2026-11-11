// Netlify Function: GET /.netlify/functions/status?item=<monday item id>
//
// Reads the live status of a single New Hire request from the
// "New Hire Pipeline — Visibilidad HomeSí" board (18422043486) and returns
// a clean JSON shape the tracker page (public/index.html) renders — this is
// the detail screen reached from a recruiter's pipeline list.
//
// Requires env var MONDAY_API_TOKEN (Site configuration → Environment
// variables in Netlify). Never hard-code the token here.

const {
  mondayQuery,
  colValue,
  deriveStages,
  translateStatus,
  formatDate,
  daysDiffSigned,
  fetchSupremeHrBoardIndex,
  lookupSupremeRecord,
  fetchOnboardingBoardIndex,
  fetchNewHireFormBoardIndex,
  fetchAllPipelineItems,
  applyRecruiterNames,
  isUsableRecruiterName,
  effectiveOnboarding,
  buildCandidateBase,
  computeThresholds,
  computeStuckStages,
  lookupByName,
  cleanDisplayName,
  pipelineNameKeys,
  GROUPS,
} = require("./_lib/monday");
const { getAllFollowups, followupHasAdvanced } = require("./_lib/followups");
const { getLinkMap } = require("./_lib/links");
const { getStageEvents } = require("./_lib/stagesync");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

// Builds a UPS "track by number" link straight from the tracking number on
// file — added 2026-10-01 because not every shipment has UPS's own tracking
// URL recorded, but the number alone is enough for UPS's own tracker to
// resolve it. Deliberately simple: no carrier auto-detection (every shipment
// on this board has been UPS so far, per Ricardo) and no validation beyond
// "is there a non-empty value" — UPS's own page handles a malformed number.
function upsTrackingUrl(trackingNumber) {
  if (!trackingNumber) return null;
  return `https://www.ups.com/track?loc=en_US&tracknum=${encodeURIComponent(trackingNumber.trim())}&requester=ST/trackdetails`;
}

const QUERY = `
query GetItem($itemId: [ID!]) {
  items (ids: $itemId) {
    id
    name
    created_at
    group { id title }
    column_values (ids: [
      "color_mm58w9bv",
      "color_mm5ahy53",
      "color_mm5ag9t7",
      "color_mm5anysh",
      "lookup_mm7azcpv",
      "lookup_mm7acze3",
      "text_mm58aak7",
      "text_mm58gmv3",
      "text_mm58w64z",
      "date_mm587sc0",
      "boolean_mm7aaesv",
      "board_relation_mm58f8n7"
    ]) {
      id
      type
      text
      ... on MirrorValue { display_value }
      ... on BoardRelationValue { display_value linked_item_ids }
      ... on StatusValue { label }
    }
  }
}`;

exports.handler = async (event) => {
  connectBlobs(event);
  const itemId = event.queryStringParameters && event.queryStringParameters.item;
  if (!itemId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing ?item=<id>" }) };
  }
  if (!process.env.MONDAY_API_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "MONDAY_API_TOKEN not configured" }) };
  }

  try {
    const data = await mondayQuery(QUERY, { itemId: [itemId] });
    const item = data.items && data.items[0];
    if (!item) {
      return { statusCode: 404, body: JSON.stringify({ error: "Item not found" }) };
    }

    const cv = item.column_values;
    const groupId = item.group.id;
    const groupTitle = item.group.title;
    const estadoGeneral = translateStatus(colValue(cv, "color_mm58w9bv"));
    const branch = colValue(cv, "text_mm58aak7");
    const role = colValue(cv, "text_mm58gmv3");
    const recruiter = colValue(cv, "text_mm58w64z");
    const estimatedStartRaw = colValue(cv, "date_mm587sc0");
    const estimatedStart = formatDate(estimatedStartRaw);
    const formSubmitted = colValue(cv, "boolean_mm7aaesv") === "v";
    const cancelled = groupId === GROUPS.CANCELLED;

    // Provisional (2026-09-21): read Supreme's own HR-tracking item directly
    // instead of the (not-yet-set-up) HomeSí mirror columns, so this section
    // isn't predominantly empty. Matched primarily by candidate NAME against
    // Supreme's whole board — the board_relation link only covers 7 of 44
    // HomeSí items, so it's used as a tie-breaker, not the primary key. Falls
    // back to the HomeSí mirrors/status columns when there's no match at all.
    const linkedToSupreme =
      (cv.find((c) => c.id === "board_relation_mm58f8n7") || {}).linked_item_ids || [];
    const [supremeIndex, onboardingIndex, formIndex, links, events] = await Promise.all([
      fetchSupremeHrBoardIndex(),
      fetchOnboardingBoardIndex(),
      fetchNewHireFormBoardIndex().catch((e) => { console.warn("form index failed:", e && e.message); return null; }),
      getLinkMap(), // read-only here — dashboard.js is the registry's single writer
      getStageEvents(), // read-only too — stage durations from monday's activity log
    ]);
    // Remembered monday item IDs (see _lib/links.js) are tried before name
    // matching, so a rename on Supreme's side doesn't orphan this candidate.
    const remembered = links.get(String(item.id)) || {};
    // The loosest (spelling-variant) match tier needs to know every name
    // already on the pipeline so it never steals another candidate's record;
    // the full pipeline is needed below anyway (stuck thresholds), so fetch
    // it once up here and reuse it.
    const allPipelineItems = await fetchAllPipelineItems();
    const pipelineKeys = pipelineNameKeys(allPipelineItems);
    const supreme = lookupSupremeRecord(supremeIndex, {
      linkedIds: linkedToSupreme, name: item.name, rememberedId: remembered.supremeId, isCancelled: cancelled, claimedKeys: pipelineKeys,
    });
    // Equipment & Access (2026-09-22): tracked on the separate "Onboarding
    // Pipeline 🛫" board (18108170142), owned by Supreme — no board-relation
    // link exists here at all, so this one is matched by remembered ID, then
    // by name.
    const onboarding = lookupByName(onboardingIndex, item.name, { rememberedId: remembered.onboardingId, isCancelled: cancelled, claimedKeys: pipelineKeys });

    const hrComplete = (supreme && supreme.complete) || colValue(cv, "color_mm5ahy53");
    const backgroundCheck = translateStatus((supreme && supreme.backgroundCheck) || colValue(cv, "color_mm5ag9t7"));
    // NMLS Access (2026-10-20, per Ricardo): shown exactly as Supreme's own
    // board has it — no role-based inference. A licensed LOA/BD/NPPM is
    // possible, so the role string can never substitute for the board value.
    const nmlsAccess = translateStatus(supreme ? supreme.nmlsAccess : null); // no HomeSí mirror exists for this one
    const i9Documents = translateStatus((supreme && supreme.i9Documents) || colValue(cv, "color_mm5anysh"));
    const packetSent = (supreme && supreme.packetSent) || colValue(cv, "lookup_mm7azcpv");
    const packetReceived = (supreme && supreme.packetReceived) || colValue(cv, "lookup_mm7acze3");
    const welcomeEmail = supreme ? supreme.welcomeEmail : null;


    // Full Timeline stuck/delayed flags (added 2026-10-01): reuses the exact
    // same whole-board thresholds and stuckStages logic the PMO dashboard
    // uses (see buildCandidateBase/computeThresholds/computeStuckStages in
    // _lib/monday.js), so a stage never reads "stuck" here but not there, or
    // vice versa. This does mean a single candidate's page now also scans
    // the whole pipeline board once, same as the dashboard does — the cost
    // of keeping the two views honestly in sync.
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const allBase = allPipelineItems.map((it) => buildCandidateBase(it, { supremeIndex, onboardingIndex, formIndex, links, pipelineKeys, events, nowMs }));
    // One clustered recruiter spelling everywhere (form's "Recruited by:" wins).
    applyRecruiterNames(allBase, formIndex ? formIndex.rows.map((f) => (isUsableRecruiterName(f.recruitedBy, f.name) ? f.recruitedBy : null)) : []);
    const { thresholds } = computeThresholds(allBase.filter((c) => !c.cancelled));
    const myBase = allBase.find((c) => c.itemId === String(item.id));
    // Same stage objects (with durations) the dashboard uses.
    const stages = myBase ? myBase.stages : [];
    const activated = myBase ? myBase.activated : false;
    const equipStage = myBase ? myBase.equipStage : null;
    const noPc = !!(myBase && myBase.noPc);
    const eqOnb = effectiveOnboarding(onboarding, myBase ? myBase.pcRequested : null);
    const stuckStages = myBase ? computeStuckStages(myBase, thresholds, nowIso) : [];

    // Surface an already-open follow-up the same way the dashboard does
    // ("Awaiting response since <date>" instead of the button again) — read
    // -only here; the dashboard remains the one place that marks a follow-up
    // resolved, to avoid two endpoints racing to write the same record.
    const openFollowups = (await getAllFollowups()).filter(
      (f) => f.itemId === String(item.id) && !f.resolvedAt
    );
    stuckStages.forEach((s) => {
      const open = openFollowups.find((f) => f.stageKey === s.stageKey);
      if (!open) return;
      // PARTIAL progress, read-only mirror of dashboard.js's write-side
      // check (2026-10-02, per Ricardo; legacy records handled 2026-10-05):
      // if something this follow-up named as pending has since cleared,
      // don't show "Awaiting response" — show the button again for whatever's
      // still outstanding. The record itself only gets marked resolved the
      // next time the dashboard loads (status.js never writes, per the
      // single-writer rule), but the Full Timeline shouldn't have to wait
      // for that to be honest about it. Same shared helper as dashboard.js
      // so the two can never disagree.
      if (followupHasAdvanced(open, s)) return; // treat as stale — leave canFollowUp's button showing
      s.followupRequestedAt = open.requestedAt;
    });

    // Header summary (added 2026-10-01, per Ricardo): once the process is
    // actually complete (HomeSí Activation reached), show the gap between
    // the estimated start date and the date the person actually joined the
    // roster, plus whichever stage ate up the most days getting there. Never
    // shown for a still-in-progress candidate — there's no "actual" date to
    // compare against yet, and no final stage breakdown until it's done.
    // "Joins the roster" reuses the same wrap-up date HomeSí Activation
    // itself is stamped with (see deriveStages — there's no separate source
    // for that milestone yet).
    const rosterJoinRaw = activated ? (supreme ? (supreme.welcomeEmail || supreme.packetReceived) : null) : null;
    const rosterJoinDate = rosterJoinRaw ? formatDate(rosterJoinRaw) : null;
    const gapDays = activated ? daysDiffSigned(estimatedStartRaw, rosterJoinRaw) : null;
    const longestStage = activated
      ? stages
          .filter((s) => typeof s.days === "number")
          .reduce((max, s) => (!max || s.days > max.days ? { label: s.label, days: s.days } : max), null)
      : null;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        itemId: item.id,
        name: item.name,
        // How Supreme currently spells this candidate (null when there's no
        // Supreme match yet). The UI shows it when it differs from `name`.
        supremeName: supreme ? cleanDisplayName(supreme.name) : null,
        role,
        branch,
        recruiter: (myBase && myBase.recruiter) || recruiter,
        estimatedStart,
        group: groupTitle,
        cancelled,
        activated,
        rosterJoinDate,
        gapDays,
        longestStage,
        estadoGeneral,
        stages,
        equipStage,
        stuckStages,
        supremeChecklist: {
          packetSent,
          packetReceived,
          backgroundCheck,
          nmlsAccess,
          i9Documents,
          // Status-only (2026-10-20, per the stage redesign) — intentionally
          // NO date is shown/stored for this sub-item. Derived from the
          // Onboarding Pipeline's "Sup Onboarding" status reading "Done" (see
          // deriveStages()'s welcomeEmailDone in _lib/monday.js). `welcomeEmail`
          // (the raw Supreme-board date) is kept below only for any other
          // caller that still expects it — the New Hire Welcome stage's own
          // UI must use welcomeEmailStatus, not this.
          welcomeEmailStatus: (stages.find((s) => s.key === "new_hire_welcome") || {}).welcomeEmailDone ? "Done" : "Pending",
          welcomeEmail,
          formalCloseOut: translateStatus(hrComplete) || "Pending",
        },
        equipmentChecklist: {
          // Shown for reference only — no longer decides "done" for this
          // stage (see equipmentState() in _lib/monday.js).
          // noPc (2026-10-21): the New Hire Form says no equipment is requested
          // (branch already has a PC / IT equipment N/A), so Equipment Shipped and
          // Tracking Number are Not Applicable — only Supreme Systems Access counts.
          noPc,
          equipmentStatus: translateStatus(eqOnb && eqOnb.equipmentStatus),
          trackingNumber: eqOnb && eqOnb.trackingNumber,
          trackingUrl: upsTrackingUrl(eqOnb && eqOnb.trackingNumber),
          // Supreme Systems Access: the sole signal for stage completion.
          // "Done"/"Not applicable" = Supreme has sent the new hire their
          // credentials/access email.
          supremeOnboarding: translateStatus(onboarding && onboarding.supremeOnboarding),
        },
      }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
