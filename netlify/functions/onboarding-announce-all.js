// Netlify Function: /.netlify/functions/onboarding-announce-all  (added 2026-10-15, per Ricardo)
//
// POST { pin }
//   -> one Outlook Web compose deep link that announces EVERY candidate
//      currently Ready for Onboarding (Supreme HR complete + Equipment &
//      Access done, not yet activated) in a SINGLE email, with a plain-text
//      table listing each of them. NOTHING IS SENT — same as
//      onboarding-announce.js and followup.js: the person clicking reviews
//      the draft and presses Send themselves from their own Supreme mailbox.
//
// GET -> { history: [ { announcedAt, to, cc, itemIds, names } ] } (most recent
//        last) — nothing in the UI reads this today, kept only so a future
//        "last bulk announce" indicator doesn't need a new log format.
//
// Recipients: the SAME FIXED To/Cc as the single-candidate announcement
// (ONBOARDING_EMAIL_TO / ONBOARDING_EMAIL_CC — see onboarding-announce.js).
// Per Ricardo (2026-10-15), the bulk email does NOT also add each candidate's
// recruiter/branch manager to Cc: with several candidates from different
// branches bundled into one email, merging all of their recruiters/BMs into
// one Cc line would show everyone the whole list, including people from
// branches that have nothing to do with their own candidate. Use the
// single-candidate "Announce Onboarding" button instead when a recruiter/BM
// specifically needs to be looped in for one person.
//
// Table columns, one row per ready candidate: Name, Role, Branch, Est. start,
// Personal email, Supreme email, Phone. Personal email + Phone come from the
// "New Hire Form" board (matched the same way as onboarding-announce.js:
// explicit board link -> name cascade). Supreme email (the Company Email
// Address Supreme assigns, e.g. julio.alayo@supremelending.com) comes from
// the Onboarding Pipeline's "Sup e-mail" column instead, since the New Hire
// Form is filled in before Supreme assigns anything — that column is kept
// current by the daily UPS/credentials tracking agent reading it off the
// AccessManagement welcome email. A candidate missing from either source
// still gets a row; the cell just says "not on file" rather than being
// dropped.
//
// OWA's compose deeplink only accepts a plain-text body (no HTML) — there is
// no way to send a real HTML table through it. A first version (through
// 2026-10-15) tried a space-padded plain-text grid, but Outlook Web renders
// the compose body in a proportional font, not monospace, so the padded
// columns never actually lined up — Ricardo flagged this from a screenshot
// of exactly that misalignment. Fixed by dropping the column-alignment idea
// entirely: each candidate is now its own small labeled block (see
// buildList() below), which reads cleanly in any font because nothing needs
// to line up across rows.
//
// Same ANNOUNCE_PIN gate as the rest of this personal-data surface (see
// onboarding-announce.js) — the dashboard asks for it once per browser
// session.

const { mondayQuery, assembleDashboard, cleanDisplayName, resolveRecord, addToNameIndex, pipelineNameKeys, formatDate, NEW_HIRE_FORM_BOARD_ID } = require("./_lib/monday");
const { getLinkMap } = require("./_lib/links");
const { openStore } = require("./_lib/blobs");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

const TRACKER_BASE_URL = (process.env.TRACKER_BASE_URL || "https://homesi-nh-tracker.netlify.app").replace(/\/+$/, "");

// Same fields as onboarding-announce.js's FORM_COLS, minus what the bulk
// table doesn't show (company, manager, employeeType, NMLS, etc.) — kept
// separate from that file's own copy since each function queries only the
// columns it actually renders.
const FORM_COLS = {
  cell: "short_texth6pd3dvb",
  email: "short_textv52j2d2b",
  legalFirst: "short_texth3kal7a2",
  legalLast: "short_text7tokc9gk",
  title: "short_textmubbf5vr",
  startDate: "datecx5vtfwh",
};
const FORM_QUERY = `
query GetFormForBulkAnnounce($boardId: [ID!], $cursor: String) {
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
const PIPELINE_LINKS_QUERY = `
query GetPipelineLinksForBulkAnnounce($itemIds: [ID!]) {
  items (ids: $itemIds) {
    id
    column_values (ids: ["board_relation_mm587q6e"]) {
      id
      ... on BoardRelationValue { linked_item_ids }
    }
  }
}`;

// IMPORTANT: same caveat as onboarding-announce.js's fetchFormIndex — on the
// New Hire Form board the ITEM NAME is the recruiter/BD who submitted the
// form, NOT the new hire, so this index is keyed by Legal First + Last Name.
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
      const legalName = (last.toLowerCase().includes(first.toLowerCase()) ? last : `${first} ${last}`).trim();
      rows.push({
        id: item.id,
        name: legalName,
        title: c[FORM_COLS.title] || "",
        startDate: c[FORM_COLS.startDate] || "",
        cell: c[FORM_COLS.cell] || "",
        email: c[FORM_COLS.email] || "",
        cancelledTag: false,
      });
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

function store() {
  return openStore("onboarding-announcements-bulk");
}

async function getHistory() {
  try {
    const data = await store().get("all", { type: "json" });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function splitEmails(raw) {
  return String(raw || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
}

function buildOwaLink({ to, cc, subject, body }) {
  // Hand-built query string (encodeURIComponent -> %20); URLSearchParams'
  // "+" for spaces is NOT understood by Outlook Web's compose deeplink — see
  // the same note in followup.js and onboarding-announce.js.
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

// OWA's compose body is plain text, so there's no <b> to reach for — this
// swaps each plain ASCII letter/digit for its Unicode "Mathematical Bold"
// twin (U+1D400 block), which most fonts (including Outlook Web's) render
// visibly bold even in a plain-text body. Only A-Z, a-z, 0-9 have a bold
// twin in that block, so accented letters (í, ñ, …), spaces, and punctuation
// (the em dash, commas) pass through unchanged — close enough to "bold" to
// make each candidate's header line stand out, without pretending this is
// real rich text.
function boldify(s) {
  return String(s == null ? "" : s).replace(/[A-Za-z0-9]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) return String.fromCodePoint(0x1d400 + (code - 65)); // A-Z
    if (code >= 97 && code <= 122) return String.fromCodePoint(0x1d41a + (code - 97)); // a-z
    return String.fromCodePoint(0x1d7ce + (code - 48)); // 0-9
  });
}

// One short, labeled block per candidate instead of a column-aligned table
// (see the module note above on why: OWA's plain-text, proportional-font
// compose body can't keep padded columns lined up). Each label is padded to
// the widest label actually used ("Personal email" = 15 chars is the longest
// here) so the four lines within ONE candidate's own block line up —
// alignment within a block, at a fixed small width, holds up fine even in a
// proportional font; it's only alignment ACROSS rows of a wide table that
// broke down. The header line (name + role/branch/start) is run through
// boldify() (2026-10-15, per Ricardo) so each candidate's block opens with a
// visibly bold heading; the detail lines below it stay regular weight.
function buildList(rows) {
  const labelWidth = "Personal email".length;
  const label = (s) => s.padEnd(labelWidth);
  return rows
    .map((r, i) => [
      boldify(`${i + 1}. ${r.name} — ${r.role}, Branch ${r.branch}, Est. start ${r.start}`),
      `   ${label("Personal email")}: ${r.personalEmail}`,
      `   ${label("Supreme email")}: ${r.supEmail}`,
      `   ${label("Phone")}: ${r.phone}`,
    ].join("\n"))
    .join("\n\n");
}

// Longest compose link we are willing to hand to Outlook Web (2026-10-26). When the
// browser is not yet signed in to Microsoft, Outlook bounces through login.microsoftonline.com
// carrying the whole compose URL inside ITS query string — and a long body then fails with
// "AADSTS90015: Requested query string is too long" (hit with all the Ready candidates in one
// email). So a link above this length is not used: the draft opens with only To/Cc/Subject and a
// short body, and the candidate table travels through the clipboard instead (pasteHtml/pasteText).
const MAX_LINK_CHARS = 1500;
const PASTE_MARKER = "[ Paste the candidates table here — it is on your clipboard (Ctrl+V) ]";

const escHtml = (t) => String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Real HTML table for the clipboard: Outlook Web keeps it as a proper table when pasted.
function buildHtmlTable(rows) {
  const th = "border:1px solid #bbb;padding:6px 10px;background:#eef2f9;text-align:left;font-weight:bold;";
  const td = "border:1px solid #bbb;padding:6px 10px;text-align:left;";
  const head = ["Name", "Role", "Branch", "Est. start", "Personal email", "Supreme email", "Phone"]
    .map((h) => `<th style="${th}">${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${[r.name, r.role, r.branch, r.start, r.personalEmail, r.supEmail, r.phone]
    .map((v) => `<td style="${td}">${escHtml(v)}</td>`).join("")}</tr>`).join("");
  return `<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:13px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

exports.handler = async (event) => {
  connectBlobs(event);
  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ history: await getHistory() }),
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
    // Re-derive readiness server-side (same logic as the dashboard tile and
    // the single-candidate announcement) so the draft can never claim
    // "everything is complete" for someone who isn't.
    const links = await getLinkMap();
    const dash = await assembleDashboard({ links });
    const ready = dash.candidates.filter((c) => c.readyForOnboarding);
    if (!ready.length) {
      return { statusCode: 409, body: JSON.stringify({ error: "Nobody is Ready for Onboarding right now — nothing to announce." }) };
    }

    const [formIndex, linkData] = await Promise.all([
      fetchFormIndex(),
      mondayQuery(PIPELINE_LINKS_QUERY, { itemIds: ready.map((c) => c.itemId) }),
    ]);
    const linkedByItem = new Map();
    ((linkData && linkData.items) || []).forEach((it) => {
      const linked = ((it.column_values || [])[0] || {}).linked_item_ids || [];
      if (linked[0]) linkedByItem.set(String(it.id), linked[0]);
    });

    // Name EXACTLY as entered on the form (Legal First + Last). Only
    // re-cased when the whole thing was typed in ALL CAPS or all lowercase —
    // same rule as onboarding-announce.js.
    const recase = (n) => (n && (n === n.toUpperCase() || n === n.toLowerCase())
      ? n.toLowerCase().replace(/(^|[\s'-])([a-zà-ÿ])/g, (m, sep, ch) => sep + ch.toUpperCase())
      : n);
    const claimedKeys = pipelineNameKeys(ready);
    const missingForm = [];
    const rows = ready.map((c) => {
      const formRec = resolveRecord(formIndex, {
        name: c.name,
        linkedId: linkedByItem.get(String(c.itemId)),
        // (no rememberedId: the registry's form link was matched by item
        // name, which on this board is the recruiter — not trustworthy for PII)
        isCancelled: false,
        claimedKeys,
      });
      if (!formRec) missingForm.push(cleanDisplayName(c.name) || c.name);
      const f = formRec || {};
      const displayName = recase((f && f.name) || "") || cleanDisplayName(c.name) || c.name;
      return {
        itemId: c.itemId,
        name: displayName,
        role: f.title || c.role || "—",
        branch: c.branch || "—",
        start: (f.startDate ? formatDate(f.startDate) : c.estimatedStart) || "—",
        personalEmail: f.email || "not on file",
        supEmail: c.supEmail || "not on file",
        phone: f.cell || "not on file",
      };
    });

    const plural = rows.length === 1 ? "" : "s";
    const subject = `Onboarding - ${rows.length} candidate${plural} ready`;
    const toName = process.env.ONBOARDING_EMAIL_TO_NAME || "Estefania";
    const body = [
      `Hi ${toName},`,
      "",
      `The ${rows.length} candidate${plural} below ${rows.length === 1 ? "has" : "have"} completed every step of the intake process and systems assignment: Supreme HR verification is done, and equipment and systems access are in place for each of them.`,
      "",
      `We can now move forward with scheduling ${rows.length === 1 ? "their" : "their"} onboarding${plural}.`,
      "",
      buildList(rows),
      "",
      `Could you please coordinate ${rows.length === 1 ? "the onboarding session" : "the onboarding sessions"} with the new hire${plural} and the team copied here? Thank you!`,
      "",
      "— Sent via the HomeSí New Hire Tracker",
      `Track these candidates: ${TRACKER_BASE_URL}`,
    ].join("\n");

    let owaLink = buildOwaLink({ to: toList.join(","), cc: fixedCc.join(","), subject, body });
    let mode = "link";
    let pasteHtml = null;
    let pasteText = null;
    if (owaLink.length > MAX_LINK_CHARS) {
      // Too long for Outlook's sign-in redirect: send the table through the clipboard instead.
      mode = "clipboard";
      pasteHtml = buildHtmlTable(rows);
      pasteText = buildList(rows);
      const shortBody = body.replace(buildList(rows), PASTE_MARKER);
      owaLink = buildOwaLink({ to: toList.join(","), cc: fixedCc.join(","), subject, body: shortBody });
    }

    // Log (best effort — a Blobs hiccup must never block opening the draft).
    const announcedAt = new Date().toISOString();
    try {
      const history = await getHistory();
      history.push({ announcedAt, to: toList, cc: fixedCc, itemIds: rows.map((r) => r.itemId), names: rows.map((r) => r.name) });
      await store().setJSON("all", history.slice(-50)); // keep the log from growing without bound
    } catch (e) {
      console.warn("bulk announcement log write failed:", e && e.message);
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ owaLink, mode, pasteHtml, pasteText, announcedAt, subject, to: toList, cc: fixedCc, count: rows.length, missingForm }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
