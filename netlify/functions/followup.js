// Netlify Function: /.netlify/functions/followup
//
// POST { itemId, candidateName, role, branch, recruiter, stageKey,
//        stageLabel, area, daysInStage, thresholdDays, stages }
//   -> logs a new follow-up request (Netlify Blobs) and returns a ready-to-
//      open Outlook Web compose deep link (outlook.office.com). Nothing is
//      sent automatically — the recipient opens Outlook Web with the email
//      pre-filled and reviews/sends it themselves from their own mailbox.
//
// GET ?itemId=<id>
//   -> lists follow-up requests logged for that candidate (for the detail
//      screen to show "Follow-up requested 2 days ago").
//
// Recipient addresses are environment variables (same pattern as
// MONDAY_API_TOKEN) so Ricardo can update them in Netlify without a code
// change: FOLLOWUP_EMAIL_HR, FOLLOWUP_EMAIL_IT, FOLLOWUP_EMAIL_ACCESS.
//
// RECRUITER_EMAILS (added 2026-10-02, per Ricardo): optional JSON object
// mapping a recruiter's exact name (as it appears in the "Recruiter" column
// on the HomeSí Pipeline board) to their email, e.g.
//   {"Maria Guerrero": "mguerrero@supremelending.com"}
// When a candidate's recruiter has an entry here, they're CC'd on every
// follow-up email for that candidate — they're the one with a real
// relationship with the candidate, so they should see every ask for an
// update, not just the stage-owning team. Looked up case/whitespace-
// insensitively since recruiter names are free text. Left unset (or missing
// an entry), the email just goes out without a CC — never an error.
//
// FOLLOWUP_CC_EMAIL / FOLLOWUP_CC_NAME (added 2026-10-02, per Ricardo): CC's
// a fixed address — Ricardo's own Supreme Outlook — on EVERY follow-up
// email, regardless of who clicked "Request Follow Up" or which recruiter
// it's for. This doesn't need "Send on Behalf" permissions or any admin
// consent: whoever requests the follow-up still sends from their own
// mailbox, they just add Ricardo in cc like any other recipient. If the
// recruiter is already being cc'd (via RECRUITER_EMAILS above) and happens
// to BE this same address, it's only added once. FOLLOWUP_CC_NAME is just
// the display name used in the email's greeting line (e.g. "cc Ricardo") —
// purely cosmetic, defaults to "Ricardo" if unset.

const crypto = require("crypto");
const { getAllFollowups, createFollowup } = require("./_lib/followups");
const {
  mondayQuery, assembleDashboard, resolveRecord, addToNameIndex,
  pipelineNameKeys, NEW_HIRE_FORM_BOARD_ID,
} = require("./_lib/monday");
const { getLinkMap } = require("./_lib/links");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

// 2026-10-16, per Ricardo (Jorge Betancur's case): when the ONLY thing(s)
// still outstanding on "Supreme HR Verification" are candidate-owned
// (Background Check consent, NMLS Access, I-9 Documents, or — new as of
// today — signing/returning the New Hire Packet, see candidatePendingItems
// in _lib/monday.js), the follow-up email used to still go to Supreme HR,
// just with wording asking them to "reach out" to the candidate. Jorge's
// case made clear that's the wrong recipient: Supreme HR isn't blocking
// anything, the candidate himself hasn't signed/returned his packet, so HR
// has nothing to action. This now routes straight to the candidate instead,
// with a direct "we need your action" email — HR only stays the recipient
// when the candidate's personal email can't be found (see
// resolveCandidateContact below), same as the previous behavior.
//
// Email comes from the New Hire Form board, matched the same way
// onboarding-announce.js / ready-contacts.js already do (explicit board
// link first, then name — never trusting the form item's own title, which
// on this board is the recruiter who submitted it, not the candidate).
const FORM_COLS = {
  cell: "short_texth6pd3dvb",
  email: "short_textv52j2d2b",
  legalFirst: "short_texth3kal7a2",
  legalLast: "short_text7tokc9gk",
};
const FORM_QUERY = `
query GetFormContacts($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 200, cursor: $cursor) {
      cursor
      items {
        id
        name
        column_values (ids: [${Object.values(FORM_COLS).map((id) => `"${id}"`).join(", ")}]) { id text }
      }
    }
  }
}`;
const PIPELINE_LINK_QUERY = `
query GetPipelineLink($itemId: [ID!]) {
  items (ids: $itemId) {
    column_values (ids: ["board_relation_mm587q6e"]) {
      id
      ... on BoardRelationValue { linked_item_ids }
    }
  }
}`;

async function fetchFormContactIndex() {
  const index = { byId: new Map(), byNameAll: new Map(), all: [] };
  const rows = [];
  let cursor = null;
  let guard = 0;
  do {
    const data = await mondayQuery(FORM_QUERY, { boardId: [NEW_HIRE_FORM_BOARD_ID], cursor });
    const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
    for (const item of (page && page.items) || []) {
      const c = {};
      item.column_values.forEach((cv) => { c[cv.id] = (cv.text || "").trim(); });
      const first = c[FORM_COLS.legalFirst] || "";
      const last = c[FORM_COLS.legalLast] || "";
      const legalName = (last.toLowerCase().includes(first.toLowerCase()) ? last : `${first} ${last}`).trim();
      rows.push({ id: item.id, name: legalName, phone: c[FORM_COLS.cell] || "", email: c[FORM_COLS.email] || "", cancelledTag: false });
    }
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  rows.sort((a, b) => Number(b.id) - Number(a.id)); // newest submission first
  for (const rec of rows) {
    if (!rec.name) continue;
    index.byId.set(String(rec.id), rec);
    addToNameIndex(index, { name: rec.name }, rec);
  }
  return index;
}

// Best-effort: any failure (missing token, no match, API error) returns null
// and the caller falls back to emailing Supreme HR instead, exactly like
// before this lookup existed — a lookup failure must never block opening
// the follow-up draft.
async function resolveCandidateContact(itemId, candidateName) {
  if (!process.env.MONDAY_API_TOKEN) return null;
  try {
    const links = await getLinkMap();
    const [dash, formIndex, linkData] = await Promise.all([
      assembleDashboard({ links }),
      fetchFormContactIndex(),
      mondayQuery(PIPELINE_LINK_QUERY, { itemId: [itemId] }),
    ]);
    const linkedForm = (((linkData.items || [])[0] || {}).column_values || [])
      .map((cv) => (cv.linked_item_ids || [])[0]).find(Boolean);
    const rec = resolveRecord(formIndex, {
      name: candidateName,
      linkedId: linkedForm,
      isCancelled: false,
      claimedKeys: pipelineNameKeys(dash.candidates),
    });
    if (!rec || !rec.email) return null;
    return { email: rec.email, name: rec.name || candidateName };
  } catch (e) {
    console.warn("followup: resolveCandidateContact failed:", e && e.message);
    return null;
  }
}

const AREA_EMAILS = {
  hr: process.env.FOLLOWUP_EMAIL_HR || "",
  it: process.env.FOLLOWUP_EMAIL_IT || "",
  access: process.env.FOLLOWUP_EMAIL_ACCESS || "",
};
const AREA_LABELS = {
  hr: "Supreme HR",
  it: "Supreme IT / Equipment",
  access: "Supreme Access Management",
};

function parseRecruiterEmails() {
  try {
    const raw = JSON.parse(process.env.RECRUITER_EMAILS || "{}");
    const normalized = new Map();
    Object.entries(raw).forEach(([name, email]) => {
      if (name && email) normalized.set(name.trim().toLowerCase(), email);
    });
    return normalized;
  } catch (e) {
    return new Map();
  }
}
const RECRUITER_EMAILS = parseRecruiterEmails();
function recruiterEmail(recruiter) {
  if (!recruiter) return null;
  return RECRUITER_EMAILS.get(String(recruiter).trim().toLowerCase()) || null;
}
const FOLLOWUP_CC_EMAIL = (process.env.FOLLOWUP_CC_EMAIL || "").trim();
const FOLLOWUP_CC_NAME = process.env.FOLLOWUP_CC_NAME || "Ricardo";

// Combines the recruiter's email (if mapped) with the fixed FOLLOWUP_CC_EMAIL
// into one deduplicated cc list, plus the matching display names for the
// email's greeting line. Returns { cc: "a@x.com,b@x.com" | null, names: "A, B" | null }.
function buildCcList(recruiter) {
  const seen = new Map(); // lowercased email -> { email (original casing), name }
  const rEmail = recruiterEmail(recruiter);
  if (rEmail) seen.set(rEmail.toLowerCase(), { email: rEmail, name: recruiter });
  if (FOLLOWUP_CC_EMAIL && !seen.has(FOLLOWUP_CC_EMAIL.toLowerCase())) {
    seen.set(FOLLOWUP_CC_EMAIL.toLowerCase(), { email: FOLLOWUP_CC_EMAIL, name: FOLLOWUP_CC_NAME });
  }
  if (!seen.size) return { cc: null, names: null };
  const entries = Array.from(seen.values());
  return {
    cc: entries.map((e) => e.email).join(","),
    names: entries.map((e) => e.name).join(", "),
  };
}

const TRACKER_BASE_URL = (process.env.TRACKER_BASE_URL || "https://homesi-nh-tracker.netlify.app").replace(/\/+$/, "");

const STAGE_ICON = { done: "✅", current: "🔶", upcoming: "⬜" };

function buildTimelineText(stages, stuckStageKey) {
  if (!Array.isArray(stages)) return "";
  return stages.map((s) => {
    const marker = s.key === stuckStageKey ? "   ⚠ NEEDS ACTION" : "";
    const when = s.date ? ` — ${s.date}` : "";
    return `${STAGE_ICON[s.state] || "⬜"} ${s.label}${when}${marker}`;
  }).join("\n");
}

function buildOwaLink({ to, cc, subject, body }) {
  // NOTE (2026-10-02, reported by Ricardo): URLSearchParams encodes spaces
  // as "+" (the old application/x-www-form-urlencoded convention) — Outlook
  // Web's compose deeplink does NOT turn "+" back into a space, so the
  // subject and body rendered with literal "+" characters everywhere
  // instead of spaces. encodeURIComponent uses %20 for spaces, which OWA
  // does handle correctly, so build the query string by hand instead.
  const parts = [];
  if (to) parts.push("to=" + encodeURIComponent(to));
  if (cc) parts.push("cc=" + encodeURIComponent(cc));
  parts.push("subject=" + encodeURIComponent(subject));
  parts.push("body=" + encodeURIComponent(body));
  // Which Microsoft account Outlook Web should open (2026-10-26): with several accounts signed in
  // to the same browser (Supreme + City Lending) the compose link otherwise lands on whichever one
  // Microsoft picks first — it opened the City Lending mailbox once. login_hint asks for the Supreme
  // one. Set OUTLOOK_LOGIN_HINT in Netlify to change it, or to "off" to omit it.
  const hint = (process.env.OUTLOOK_LOGIN_HINT || "ricardo.cera@supremelending.com").trim();
  if (hint && hint.toLowerCase() !== "off") parts.unshift("login_hint=" + encodeURIComponent(hint));
  return "https://outlook.office.com/mail/deeplink/compose?" + parts.join("&");
}

exports.handler = async (event) => {
  connectBlobs(event);
  if (event.httpMethod === "GET") {
    const itemId = event.queryStringParameters && event.queryStringParameters.itemId;
    const all = await getAllFollowups();
    const filtered = itemId ? all.filter((f) => f.itemId === String(itemId)) : all;
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ followups: filtered }),
    };
  }

  if (event.httpMethod === "POST") {
    // Follow-up requests are admin-only (2026-11-11, per Ricardo).
    if (!isAdmin(event)) return adminDenied();
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }
    const {
      itemId, candidateName, role, branch, recruiter,
      stageKey, stageLabel, area, daysInStage, thresholdDays, stages,
      blockedByCandidate, candidatePendingItems,
    } = payload;

    if (!itemId || !stageKey || !area) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing itemId, stageKey, or area" }) };
    }

    // When the only things actually outstanding are candidate-owned items
    // (Background Check consent, NMLS Access, I-9 Documents, New Hire
    // Packet), the email should go to the candidate themselves — Supreme's
    // HR team isn't sitting on anything. Try that first; fall back to the
    // area's team (the previous, HR-routed behavior) only when the
    // candidate's personal email can't be resolved.
    // Generalized 2026-10-20 (stage redesign): "New Hire Packet Processing" is
    // its own candidate-blockable stage now too (packet sent, not yet signed
    // & returned) — same routing rule as Supreme HR Verification's candidate-
    // owned items.
    const CANDIDATE_BLOCKABLE_STAGES = ["supreme_hr", "packet_processing"];
    const isCandidateBlocked = CANDIDATE_BLOCKABLE_STAGES.includes(stageKey) && blockedByCandidate && Array.isArray(candidatePendingItems) && candidatePendingItems.length > 0;
    const candidateContact = isCandidateBlocked ? await resolveCandidateContact(itemId, candidateName) : null;
    const sendToCandidate = !!(candidateContact && candidateContact.email);

    const to = sendToCandidate ? candidateContact.email : AREA_EMAILS[area];
    if (!to) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: `No email configured for area "${area}". Set FOLLOWUP_EMAIL_${area.toUpperCase()} in Netlify's Site configuration → Environment variables.`,
        }),
      };
    }

    const record = {
      id: crypto.randomUUID(),
      itemId: String(itemId),
      candidateName: candidateName || "",
      stageKey,
      stageLabel: stageLabel || stageKey,
      area,
      recipient: to,
      // true when this follow-up actually went to the candidate's own
      // personal email instead of Supreme HR (2026-10-16) — lets the
      // dashboard/log tell the two cases apart later if needed.
      sentToCandidate: sendToCandidate,
      blockedByCandidate: !!blockedByCandidate,
      // Snapshot of what was still pending AT REQUEST TIME (2026-10-02, per
      // Ricardo) — dashboard.js's reconciliation compares this against the
      // CURRENT pending list on every load, so a follow-up auto-resolves the
      // moment one of these items advances, even if the stage as a whole is
      // still "stuck" — instead of staying "Awaiting response" until every
      // last item is done. That reset also re-enables a fresh follow-up for
      // whatever's still outstanding.
      candidatePendingItems: Array.isArray(candidatePendingItems) ? candidatePendingItems : [],
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedVia: null,
    };
    await createFollowup(record);

    const trackerLink = recruiter
      ? `${TRACKER_BASE_URL}/?recruiter=${encodeURIComponent(recruiter)}&item=${encodeURIComponent(itemId)}`
      : `${TRACKER_BASE_URL}/?item=${encodeURIComponent(itemId)}`;
    const timelineText = buildTimelineText(stages, stageKey);
    const { cc, names: ccNames } = buildCcList(recruiter);

    // pendingItemsText covers both candidate-facing cases below: emailing
    // the candidate directly (sendToCandidate) and the older fallback of
    // asking Supreme HR to reach out when no personal email could be found.
    const pendingItemsText = isCandidateBlocked ? candidatePendingItems.join(", ") : null;

    const subject = sendToCandidate
      ? `Action Needed: Your New Hire Process With Supreme Lending`
      : `New Hire Update Needed: ${candidateName || "Candidate"} — ${stageLabel || stageKey}`;

    // 2026-10-16, per Ricardo (Jorge Betancur's case): addressed straight to
    // the candidate, so it drops the internal stage-timeline/tracker-link
    // block (those are for Supreme/HomeSí staff, not the candidate) and
    // says plainly that we need THEIR action to keep the process moving
    // without delays.
    const firstName = (candidateContact && candidateContact.name ? candidateContact.name : candidateName || "there").split(/\s+/)[0];
    const bodyLines = sendToCandidate
      ? [
          `Hi ${firstName},`,
          "",
          `We need your action so your New Hire process with Supreme Lending can move forward without delays. The following is still pending on your end: ${pendingItemsText}.`,
          "",
          role ? `Role: ${role}` : null,
          branch ? `Branch: ${branch}` : null,
          `Pending from you: ${pendingItemsText}`,
          "",
          "Could you please take care of this as soon as you can? If you have any questions or run into any trouble, just reply to this email and we'll help. Thank you!",
          "",
          "— Supreme Lending / HomeSí Onboarding Team",
        ].filter((l) => l !== null)
      : isCandidateBlocked
      ? [
          `Hi ${AREA_LABELS[area] || "team"}${ccNames ? ` (cc ${ccNames})` : ""},`,
          "",
          `${candidateName || "This candidate"}'s New Hire process has been waiting ${daysInStage} day(s) on the candidate themselves — longer than the usual ~${thresholdDays} day(s) for this step. The only thing(s) still outstanding: ${pendingItemsText}.`,
          "",
          `Candidate: ${candidateName || "—"}`,
          role ? `Role: ${role}` : null,
          branch ? `Branch: ${branch}` : null,
          `Pending from candidate: ${pendingItemsText}`,
          "",
          "Timeline so far:",
          timelineText,
          "",
          "Could you (or whoever has the best relationship with the candidate) reach out directly to get this moving? Thank you! (We couldn't find a personal email on file for this candidate to reach out to them directly — if you have a better address than what's on their New Hire Form, please also let us know so we can update it.)",
          "",
          "— Sent via the HomeSí New Hire Tracker",
          `Track this candidate: ${trackerLink}`,
        ].filter((l) => l !== null)
      : [
          `Hi ${AREA_LABELS[area] || "team"}${ccNames ? ` (cc ${ccNames})` : ""},`,
          "",
          `We need an update on ${candidateName || "this candidate"}'s New Hire process — the "${stageLabel || stageKey}" step has been in progress for ${daysInStage} day(s), longer than the usual ~${thresholdDays} day(s) for this step.`,
          "",
          `Candidate: ${candidateName || "—"}`,
          role ? `Role: ${role}` : null,
          branch ? `Branch: ${branch}` : null,
          `Step needing action: ${stageLabel || stageKey}`,
          "",
          "Timeline so far:",
          timelineText,
          "",
          "Could you share a status update or flag anything blocking this? Thank you!",
          "",
          "— Sent via the HomeSí New Hire Tracker",
          `Track this candidate: ${trackerLink}`,
        ].filter((l) => l !== null);

    const owaLink = buildOwaLink({ to, cc, subject, body: bodyLines.join("\n") });

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ record, owaLink }),
    };
  }

  return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
};
