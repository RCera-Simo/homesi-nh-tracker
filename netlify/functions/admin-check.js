// Netlify Function: POST /.netlify/functions/admin-check
// Header x-admin-key: <password>  ->  200 { admin: true } | 401 { needsAdmin: true }
// Used by the page's "Admin" lock button to verify the password before
// unlocking Dashboard / See Pipeline / follow-ups. Reads nothing else.
const { isAdmin, adminDenied } = require("./_lib/admin");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }
  if (!isAdmin(event)) return adminDenied();
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify({ admin: true }),
  };
};
