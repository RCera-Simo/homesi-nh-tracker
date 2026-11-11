// Netlify Function: POST /.netlify/functions/ready-contacts  (added 2026-10-14, per Ricardo)
//
// POST { pin }
//   -> { contacts: { <pipelineItemId>: { phone, email } } } for everyone
//      currently on the "Ready for Onboarding" list, so the dashboard's pop-up
//      can show how to reach them to invite them to their onboarding.
//
// The phone number and personal email come from the New Hire Form board
// (same source, and same matching rules, as the "Announce Onboarding" draft —
// see onboarding-announce.js: the form's ITEM NAME is the recruiter, so the
// new hire is matched by Legal First + Last Name, with the explicit board
// link used first). Because this is personal data and the site has no login,
// it is NOT part of the public /dashboard payload: it lives behind the same
// ANNOUNCE_PIN the announcement button uses, and refuses requests without it
// when that PIN is set. Read-only: nothing is written anywhere.

const { mondayQuery, assembleDashboard, resolveRecord, addToNameIndex, pipelineNameKeys, NEW_HIRE_FORM_BOARD_ID } = require("./_lib/monday");
const { getLinkMap } = require("./_lib/links");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

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
const PIPELINE_LINKS_QUERY = `
query GetPipelineLinks($itemIds: [ID!]) {
  items (ids: $itemIds) {
    id
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

exports.handler = async (event) => {
  connectBlobs(event);
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

  try {
    const links = await getLinkMap();
    const dash = await assembleDashboard({ links });
    const ready = dash.readyRecentRaw || [];
    if (!ready.length) {
      return { statusCode: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify({ contacts: {} }) };
    }

    const [formIndex, linkData] = await Promise.all([
      fetchFormContactIndex(),
      mondayQuery(PIPELINE_LINKS_QUERY, { itemIds: ready.map((r) => r.itemId) }),
    ]);
    const linkedByItem = new Map();
    ((linkData && linkData.items) || []).forEach((it) => {
      const linked = ((it.column_values || [])[0] || {}).linked_item_ids || [];
      if (linked[0]) linkedByItem.set(String(it.id), linked[0]);
    });

    const claimedKeys = pipelineNameKeys(ready);
    const contacts = {};
    for (const r of ready) {
      const rec = resolveRecord(formIndex, {
        name: r.name,
        linkedId: linkedByItem.get(String(r.itemId)),
        // (no rememberedId: the registry's form link was matched by item name,
        // which on this board is the recruiter — not trustworthy for PII)
        isCancelled: false,
        claimedKeys,
      });
      contacts[r.itemId] = { phone: rec ? rec.phone : "", email: rec ? rec.email : "" };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ contacts }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
