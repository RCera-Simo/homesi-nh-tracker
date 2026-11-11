// Netlify Function: GET /.netlify/functions/pipeline?recruiter=<name>
//
// Returns the list of candidates on the New Hire Pipeline board assigned to
// a given recruiter — powers the "My New Hire Process" list screen.
//
// 2026-10-21 (per Ricardo): "assigned to" now means the recruiter named in the
// New Hire Form ("Recruited by:"), spellings merged (see recruiters.js), and
// each row's current stage comes from the exact same stage logic as the
// dashboard and the Full Timeline (buildCandidateBase), so the three never
// disagree.

const { translateStatus, loadRecruiterContext } = require("./_lib/monday");
const { getLinkMap } = require("./_lib/links");
const { getStageEvents } = require("./_lib/stagesync");
const { connectBlobs } = require("./_lib/blobs");
const { isAdmin, adminDenied } = require("./_lib/admin");

exports.handler = async (event) => {
  connectBlobs(event);
  const recruiter = event.queryStringParameters && event.queryStringParameters.recruiter;
  if (!recruiter || !recruiter.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing ?recruiter=<name>" }) };
  }
  if (!process.env.MONDAY_API_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "MONDAY_API_TOKEN not configured" }) };
  }

  try {
    const { base, recruitment } = await loadRecruiterContext({ links: await getLinkMap(), events: await getStageEvents() });

    const wanted = recruiter.trim().toLowerCase();
    const candidates = base
      .filter((c) => (c.recruiter || "").trim().toLowerCase() === wanted)
      .map((c) => {
        const currentStage = c.stages.find((s) => s.state === "current") || c.stages[c.stages.length - 1];
        return {
          itemId: c.itemId,
          name: c.name,
          role: c.role,
          branch: c.branch,
          estadoGeneral: translateStatus(c.estadoRaw),
          group: c.group,
          cancelled: c.cancelled,
          activated: c.activated,
          currentStageLabel: currentStage ? currentStage.label : null,
        };
      });

    // Stable, useful ordering: active candidates first, then completed, then cancelled last.
    const rank = (c) => (c.cancelled ? 2 : c.activated ? 1 : 0);
    candidates.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "es"));

    // People this recruiter hired who never had an item on the pipeline board
    // (they pre-date it): same history the Dashboard's leaderboard counts, so the
    // two always agree. No timeline exists for them, so the UI shows them as
    // plain (non-clickable) cards.
    const earlier = recruitment.rows
      .filter((r) => r.source !== "pipeline" && (r.recruiter || "").trim().toLowerCase() === wanted)
      .map((r) => ({ name: r.name, role: r.role, branch: r.branch, date: r.date, status: r.status, source: r.source }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ recruiter: recruiter.trim(), candidates, earlier }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
