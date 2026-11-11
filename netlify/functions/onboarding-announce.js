// Netlify Function: /.netlify/functions/onboarding-announce  (added 2026-10-05, per Ricardo)
//
// POST { itemId }
//   -> for a candidate who is READY for onboarding (Supreme HR complete +
//      Equipment & Access done, not yet activated), returns a ready-to-open
//      Outlook Web compose deep link announcing that every step of the
//      intake/systems process is done so onboarding can be scheduled.
//      NOTHING IS SENT — same as the follow-up button, the person clicking
//      reviews the draft and presses Send from their own Supreme mailbox.
//      Also logs the announcement (Netlify Blobs) so the dashboard can show
//      "Announced <date>" on the card afterwards.
//
// GET -> { announcements: { <itemId>: { announcedAt, to, cc } } }
//
// Recipients:
//   To:  ONBOARDING_EMAIL_TO    (Estefania Escobar) — REQUIRED env var
//        ONBOARDING_EMAIL_TO_NAME  greeting name, defaults to "Estefania"
//   Cc:  ONBOARDING_EMAIL_CC    comma-separated fixed list (Angela Freile,
//        Juan Pinillos, Sunny Ballestas) — REQUIRED env var
//        + the candidate's RECRUITER (RECRUITER_EMAILS JSON, same one
//          followup.js uses, else the roster board by name)
//        + the BRANCH MANAGER(S) of the candidate's branch, read live from the
//          "Division LOs BDs NPPMs" roster board (role contains "BM", status
//          Active, branch dropdown contains the candidate's branch)
// New-hire contact data in the NEW HIRE block (added 2026-10-15, per Ricardo):
//   Personal email + Phone come from the "New Hire Form" board, matched to the
//     candidate the same way the rest of the tracker does (explicit board
//     link -> remembered ID -> name cascade, so a Supreme rename can't hide it).
//   Supreme email (the Company Email Address Supreme assigns, e.g.
//     julio.alayo@supremelending.com) comes from the Onboarding Pipeline's
//     "Sup e-mail" column (ONBOARDING_COLS.supEmail) instead — the New Hire
//     Form is filled in before Supreme assigns anything, so it never has this.
//     That column is kept current by the daily UPS/credentials tracking agent
//     reading it off the AccessManagement welcome email.
// If the form can't be matched or a field is blank the draft says "not on
// file" instead of omitting the line.
//
// Because this data is personal, set ANNOUNCE_PIN in Netlify: the dashboard
// then asks for it once per browser session and this function refuses
// requests without it (the site itself has no login). Left unset, anyone who
// can reach the site can trigger it.
//
// A recruiter / branch manager whose email can't be found never blocks the
// draft — the response lists them under `missing` so the UI can say who to add
// by hand.

const { mondayQuery, assembleDashboard, cleanDisplayName, resolveRecord, addToNameIndex, pipelineNameKeys, formatDate, NEW_HIRE_FORM_BOARD_ID } = require("./_lib/monday");
const { getLinkMap } = require("./_lib/links");
const { openStore } = require("./_lib/blobs");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

const ROSTER_BOARD_ID = process.env.ROSTER_BOARD_ID || "18400833242";
const ROSTER_COLS = { branch: "dropdown_mm4p5nxh", role: "dropdown_mm5eg27r", email: "email_mm0r4rnb", status: "status" };
const TRACKER_BASE_URL = (process.env.TRACKER_BASE_URL || "https://homesi-nh-tracker.netlify.app").replace(/\/+$/, "");

const ROSTER_QUERY = `
query GetRoster($boardId: [ID!], $cursor: String) {
  boards (ids: $boardId) {
    items_page (limit: 200, cursor: $cursor) {
      cursor
      items {
        id
        name
        column_values (ids: ["${ROSTER_COLS.branch}", "${ROSTER_COLS.role}", "${ROSTER_COLS.email}", "${ROSTER_COLS.status}"]) {
          id
          text
        }
      }
    }
  }
}`;

// Everything on the announcement card comes from the New Hire Form entry (so
// every line can be traced back to the form the recruiter filled in). Money /
// compensation, home address and the like are deliberately NOT included.
const FORM_COLS = {
  cell: "short_texth6pd3dvb",
  email: "short_textv52j2d2b",
  preferred: "short_text2iwhqzlj",
  legalFirst: "short_texth3kal7a2",
  legalLast: "short_text7tokc9gk",
  title: "short_textmubbf5vr",
  company: "short_textbrqxlq8a",
  branchSelect: "single_selectcuaewa7",
  branchTyped: "short_text8h04nu6q",
  manager: "short_text6m9wjkpp",
  startDate: "datecx5vtfwh",
  employeeType: "single_selectiond02l",
  fullPart: "single_selectkprqyl3",
  nmlsId: "short_text1f7lbjyl",
};
const FORM_BOARD_URL = (id) => `https://supreme-lending.monday.com/boards/${NEW_HIRE_FORM_BOARD_ID}/pulses/${id}`;
const FORM_QUERY = `
query GetForm($boardId: [ID!], $cursor: String) {
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

// IMPORTANT: on the New Hire Form board the ITEM NAME is the recruiter/BD who
// submitted the form ("Recruiter or BD Name"), NOT the new hire — the new hire
// is in Legal First Name + Legal Last Name. So this index is keyed by the legal
// name (a wrong match here would put someone else's phone/email in the
// announcement). Newest submission first, so a re-submitted form wins.
async function fetchFormIndex() {
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
      // Some submissions type the full name into both boxes.
      const legalName = (last.toLowerCase().includes(first.toLowerCase()) ? last : `${first} ${last}`).trim();
      rows.push({
        id: item.id,
        name: legalName,
        submittedBy: item.name,
        preferred: c[FORM_COLS.preferred] || "",
        title: c[FORM_COLS.title] || "",
        company: c[FORM_COLS.company] || "",
        branch: c[FORM_COLS.branchSelect] || c[FORM_COLS.branchTyped] || "",
        manager: c[FORM_COLS.manager] || "",
        startDate: c[FORM_COLS.startDate] || "",
        employeeType: c[FORM_COLS.employeeType] || "",
        fullPart: c[FORM_COLS.fullPart] || "",
        nmlsId: c[FORM_COLS.nmlsId] || "",
        cell: c[FORM_COLS.cell] || "",
        email: c[FORM_COLS.email] || "",
        cancelledTag: false,
      });
    }
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  rows.sort((a, b) => Number(b.id) - Number(a.id));
  for (const rec of rows) {
    if (!rec.name) continue;
    index.byId.set(String(rec.id), rec);
    addToNameIndex(index, { name: rec.name }, rec);
  }
  return index;
}

function store() {
  return openStore("onboarding-announcements");
}

async function getAnnouncements() {
  try {
    const data = await store().get("all", { type: "json" });
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch (e) {
    return {};
  }
}

async function fetchRoster() {
  const rows = [];
  let cursor = null;
  let guard = 0;
  do {
    const data = await mondayQuery(ROSTER_QUERY, { boardId: [ROSTER_BOARD_ID], cursor });
    const page = data && data.boards && data.boards[0] && data.boards[0].items_page;
    for (const item of (page && page.items) || []) {
      const c = {};
      item.column_values.forEach((cv) => { c[cv.id] = cv.text || ""; });
      rows.push({
        name: item.name,
        branches: (c[ROSTER_COLS.branch] || "").split(",").map((s) => s.trim()).filter(Boolean),
        role: c[ROSTER_COLS.role] || "",
        email: (c[ROSTER_COLS.email] || "").trim(),
        status: c[ROSTER_COLS.status] || "",
      });
    }
    cursor = page && page.cursor;
    guard += 1;
  } while (cursor && guard < 5);
  return rows;
}

function splitEmails(raw) {
  return String(raw || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function lowerName(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function recruiterEmailFromEnv(recruiter) {
  try {
    const raw = JSON.parse(process.env.RECRUITER_EMAILS || "{}");
    const want = lowerName(recruiter);
    for (const [name, email] of Object.entries(raw)) {
      if (name && email && lowerName(name) === want) return email;
    }
  } catch (e) { /* fall through */ }
  return null;
}

function buildOwaLink({ to, cc, subject, body }) {
  // Hand-built query string (encodeURIComponent -> %20); URLSearchParams'
  // "+" for spaces is NOT understood by Outlook Web's compose deeplink — see
  // the same note in followup.js.
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
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ announcements: await getAnnouncements() }),
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  if (!process.env.MONDAY_API_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "MONDAY_API_TOKEN not configured" }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }
  const itemId = payload.itemId && String(payload.itemId);
  if (!itemId) return { statusCode: 400, body: JSON.stringify({ error: "Missing itemId" }) };

  const requiredPin = (process.env.ANNOUNCE_PIN || "").trim();
  if (!isAdmin(event) && (!requiredPin || String(payload.pin || "").trim() !== requiredPin)) {
    return { statusCode: 401, body: JSON.stringify({ error: "Incorrect or missing PIN.", needsPin: true }) };
  }

  const toList = splitEmails(process.env.ONBOARDING_EMAIL_TO);
  const fixedCc = splitEmails(process.env.ONBOARDING_EMAIL_CC);
  if (!toList.length || !fixedCc.length) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Missing ONBOARDING_EMAIL_TO and/or ONBOARDING_EMAIL_CC. Set them in Netlify's Site configuration → Environment variables (To: Estefania Escobar; CC: Angela Freile, Juan Pinillos, Sunny Ballestas, comma-separated).",
      }),
    };
  }

  try {
    // Re-derive readiness server-side (same logic as the dashboard tile) so the
    // draft can never claim "everything is complete" for someone who isn't.
    const links = await getLinkMap();
    const [dash, roster, formIndex, linkData] = await Promise.all([
      assembleDashboard({ links }),
      fetchRoster(),
      fetchFormIndex(),
      mondayQuery(PIPELINE_LINK_QUERY, { itemId: [itemId] }),
    ]);
    const candidate = dash.candidates.find((c) => String(c.itemId) === itemId);
    if (!candidate) {
      return { statusCode: 404, body: JSON.stringify({ error: "Candidate not found among in-process candidates." }) };
    }
    if (!candidate.readyForOnboarding) {
      return { statusCode: 409, body: JSON.stringify({ error: "This candidate is not Ready for Onboarding yet — nothing to announce." }) };
    }

    const missing = [];
    const cc = [...fixedCc];

    // Recruiter
    if (candidate.recruiter) {
      let rEmail = recruiterEmailFromEnv(candidate.recruiter);
      if (!rEmail) {
        const hit = roster.find((r) => r.email && lowerName(r.name) === lowerName(candidate.recruiter));
        if (hit) rEmail = hit.email;
      }
      if (rEmail) cc.push(rEmail);
      else missing.push(`recruiter ${candidate.recruiter}`);
    } else {
      missing.push("recruiter (none assigned)");
    }

    // Branch manager(s)
    const branch = (candidate.branch || "").trim();
    const managers = branch
      ? roster.filter((r) => /BM/.test(r.role) && /^active$/i.test(r.status) && r.branches.includes(branch))
      : [];
    const mgrWithEmail = managers.filter((m) => m.email);
    mgrWithEmail.forEach((m) => cc.push(m.email));
    if (!mgrWithEmail.length) missing.push(branch ? `branch manager for branch ${branch}` : "branch manager (no branch on the card)");

    // Dedupe (case-insensitive) and keep To out of Cc.
    const toSet = new Set(toList.map((e) => e.toLowerCase()));
    const seen = new Set();
    const ccFinal = cc.filter((e) => {
      const k = e.toLowerCase();
      if (toSet.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // New hire's contact details from the New Hire Form board.
    const linkedForm = (((linkData.items || [])[0] || {}).column_values || [])
      .map((cv) => (cv.linked_item_ids || [])[0]).find(Boolean);
    const formRec = resolveRecord(formIndex, {
      name: candidate.name,
      linkedId: linkedForm,
      // (no rememberedId: the registry's form link was matched by item name,
      // which on this board is the recruiter — not trustworthy for PII)
      isCancelled: false,
      claimedKeys: pipelineNameKeys(dash.candidates),
    });
    if (!formRec) missing.push("New Hire Form entry (name, role, branch and start date come from the pipeline card instead)");

    // Name EXACTLY as entered on the form (Legal First + Last). Only
    // re-cased when the whole thing was typed in ALL CAPS or all lowercase.
    const recase = (n) => (n && (n === n.toUpperCase() || n === n.toLowerCase())
      ? n.toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase())
      : n);
    const displayName = recase((formRec && formRec.name) || "") || cleanDisplayName(candidate.name) || candidate.name;
    const f = formRec || {};
    const startRaw = f.startDate || "";
    const startText = startRaw ? formatDate(startRaw) : candidate.estimatedStart;
    const cardBranch = f.branch || branch;

    const toName = process.env.ONBOARDING_EMAIL_TO_NAME || "Estefania";
    const subject = `Onboarding - ${displayName}`;
    const trackerLink = `${TRACKER_BASE_URL}/?item=${encodeURIComponent(itemId)}`;
        const body = [
      `Hi ${toName},`,
      "",
      `All the steps of the intake process and systems assignment for ${displayName} have been completed: Supreme HR verification is done, and equipment and systems access are in place.`,
      "",
      `We can now move forward with scheduling ${displayName}'s onboarding.`,
      "",
      "NEW HIRE",
      `Name: ${displayName}`,
      (f.title || candidate.role) ? `Role: ${f.title || candidate.role}` : null,
      cardBranch ? `Branch: ${cardBranch}` : null,
      startText ? `Estimated start date: ${startText}` : null,
      `Personal email: ${f.email || "not on file"}`,
      `Supreme email: ${candidate.supEmail || "not on file"}`,
      `Phone: ${f.cell || "not on file"}`,
      "",
      "Could you please coordinate the onboarding session with the new hire and the team copied here? Thank you!",
      "",
      "— Sent via the HomeSí New Hire Tracker",
      `Track this candidate: ${trackerLink}`,
    ].filter((l) => l !== null).join("\n");

    const owaLink = buildOwaLink({ to: toList.join(","), cc: ccFinal.join(","), subject, body });

    // Log (best effort — a Blobs hiccup must never block opening the draft).
    const announcedAt = new Date().toISOString();
    try {
      const all = await getAnnouncements();
      all[itemId] = { announcedAt, to: toList, cc: ccFinal, candidateName: displayName };
      await store().setJSON("all", all);
    } catch (e) {
      console.warn("announcement log write failed:", e && e.message);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ owaLink, announcedAt, subject, to: toList, cc: ccFinal, missing, contactFrom: formRec ? formRec.name : null }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
