/* api/_sanitize.js — input-sanitisatie voor de spraakbericht-API. */
const ID_RE = /^[A-Za-z0-9_-]+$/;

function sanitizeTekst(v, maxLen = 500) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, maxLen).trim();
}
function validId(v) {
  return typeof v === "string" && v.length <= 200 && ID_RE.test(v);
}

module.exports = { sanitizeTekst, validId };
