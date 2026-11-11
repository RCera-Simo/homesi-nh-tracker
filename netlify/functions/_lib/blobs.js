// Shared Netlify Blobs opener for every Blobs-backed store in this project
// (followups, links). getStore(name) alone ("automatic" mode) is supposed to
// pick up the site's Blobs credentials on its own inside a deployed Netlify
// Function, but on this site it throws "The environment has not been
// configured to use Netlify Blobs" instead (found 2026-09-29) — so this
// falls back to "manual" mode (siteID + a Netlify personal access token)
// whenever that token is present, per Netlify's own documented fallback for
// exactly this error. See .env.example for how to generate
// NETLIFY_BLOBS_TOKEN.
const { getStore, connectLambda } = require("@netlify/blobs");

// 2026-11-11 fix: these are Lambda-compatibility functions (exports.handler),
// and in that mode Netlify only hands Blobs its credentials through the
// incoming event — getStore(name) works on its own ONLY after
// connectLambda(event) has been called. That missing call is why automatic
// mode "wasn't configured" and the site fell back to a personal token that
// later expired (the 401). Every handler now calls connectBlobs(event) first;
// the manual token is kept only as a last-resort fallback.
let lambdaConnected = false;
function connectBlobs(event) {
  if (lambdaConnected || !event || !event.blobs) return;
  try { connectLambda(event); lambdaConnected = true; } catch (err) { noteProblem(err); }
}

const FALLBACK_SITE_ID = "42cfcd51-153c-4dd7-a20c-410fa931e97b";

// If this site's Blobs credentials are missing (getStore throws "The
// environment has not been configured to use Netlify Blobs") or REJECTED (the
// token is expired/wrong: "Netlify Blobs has generated an internal error (401
// status code)"), the page must not go down with it (2026-10-22): reads come
// back empty and are flagged, writes still throw so a button that needs to SAVE
// something shows an honest error. blobsProblem() lets dashboard.js tell the
// page that saved data is unavailable.
let problem = null;
function noteProblem(err) { problem = String((err && err.message) || err); }

function unavailableStore(err) {
  const fail = async () => { throw err; };
  return { get: async () => null, getWithMetadata: async () => null, setJSON: fail, set: fail, delete: fail, list: async () => ({ blobs: [] }) };
}

// Wraps a real store so a failing READ degrades instead of throwing.
function safeStore(real) {
  const read = (fn, empty) => async (...args) => {
    try { return await fn.apply(real, args); } catch (err) { noteProblem(err); return empty; }
  };
  const write = (fn) => async (...args) => {
    try { return await fn.apply(real, args); } catch (err) { noteProblem(err); throw err; }
  };
  return {
    get: read(real.get, null),
    getWithMetadata: read(real.getWithMetadata, null),
    list: read(real.list, { blobs: [] }),
    setJSON: write(real.setJSON),
    set: write(real.set),
    delete: write(real.delete),
  };
}

function openStore(name) {
  try {
    if (lambdaConnected) return safeStore(getStore(name));
    const token = process.env.NETLIFY_BLOBS_TOKEN;
    if (token) {
      const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || FALLBACK_SITE_ID;
      return safeStore(getStore({ name, siteID, token }));
    }
    return safeStore(getStore(name));
  } catch (err) {
    noteProblem(err);
    return unavailableStore(err);
  }
}

function blobsProblem() { return problem; }

module.exports = { openStore, blobsProblem, connectBlobs };
