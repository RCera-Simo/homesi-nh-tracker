// Admin gate (added 2026-11-11, per Ricardo): Dashboard, See Pipeline, follow-up
// requests and the onboarding announcements are for the PMO admin only.
// Recruiters keep "My New Hire Process" (recruiters / pipeline / status).
//
// The browser sends the admin password in the "x-admin-key" header after
// Ricardo unlocks the admin view; it is compared here, server-side, against
// the ADMIN_PASSWORD environment variable (Netlify → Environment variables,
// marked secret). If ADMIN_PASSWORD is not set, NOTHING is treated as admin —
// the admin-only endpoints stay locked rather than open.
const crypto = require("crypto");

function headerKey(event) {
  const h = (event && event.headers) || {};
  return String(h["x-admin-key"] || h["X-Admin-Key"] || "").trim();
}

function isAdmin(event) {
  const expected = String(process.env.ADMIN_PASSWORD || "").trim();
  const given = headerKey(event);
  if (!expected || !given) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

function adminDenied() {
  return {
    statusCode: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ error: "Admin only.", needsAdmin: true }),
  };
}

module.exports = { isAdmin, adminDenied };
