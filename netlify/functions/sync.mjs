// Scheduled Netlify Function (2026-11-11): keeps the tracker's saved data
// current without anyone opening the admin Dashboard.
//
// It runs the same buildDashboard() the admin view uses — which syncs stage
// change dates from monday's activity log, the cross-board link registry,
// "ready since" dates and follow-up resolution — and discards the result
// (nothing is returned to anyone). Recruiters' "My New Hire Process" reads
// those saved values, so their stage times stay fresh.
//
// Schedule: every hour, on the hour (UTC). Scheduled functions only run on the
// published production deploy; use "Run now" in Netlify → Functions to test.
import dashboard from "./dashboard.js";

export default async () => {
  if (!process.env.MONDAY_API_TOKEN) {
    console.error("sync skipped: MONDAY_API_TOKEN not configured");
    return;
  }
  const started = Date.now();
  try {
    const dash = await dashboard.buildDashboard();
    console.log(`sync ok in ${Date.now() - started} ms — ${(dash.candidates || []).length} candidates`);
  } catch (err) {
    console.error("sync failed:", String((err && err.message) || err));
  }
};

export const config = {
  schedule: "0 * * * *", // hourly, UTC
};
