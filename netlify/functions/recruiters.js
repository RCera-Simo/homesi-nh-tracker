// Netlify Function: GET /.netlify/functions/recruiters
//
// Distinct list of recruiter names — powers the picker on "My New Hire Process".
// No group filtering on purpose: a recruiter must be able to find themselves
// even if every one of their candidates is Cancelled or already Completed.
//
// 2026-10-21 (per Ricardo): the recruiter is the person named on the New Hire
// Form ("Recruited by:"), pipeline "Reclutador" text only as a fallback, and
// spellings of the same person are merged. The list also includes recruiters
// whose hires pre-date the pipeline board (history rows), so it always matches
// the Recruiter Leaderboard on the Dashboard.

const { loadRecruiterContext } = require("./_lib/monday");
const { getLinkMap } = require("./_lib/links");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

exports.handler = async (event) => {
  connectBlobs(event);
  if (!process.env.MONDAY_API_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "MONDAY_API_TOKEN not configured" }) };
  }

  try {
    const { base, recruitment } = await loadRecruiterContext({ links: await getLinkMap() });
    const names = new Set();
    base.forEach((c) => { if (c.recruiter && c.recruiter.trim()) names.add(c.recruiter.trim()); });
    recruitment.rows.forEach((r) => { if (r.recruiter && r.recruiter.trim()) names.add(r.recruiter.trim()); });
    const recruiters = Array.from(names).sort((a, b) => a.localeCompare(b, "es"));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ recruiters }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
