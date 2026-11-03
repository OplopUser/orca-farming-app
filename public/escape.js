// HTML-escaping for values interpolated into innerHTML templates in app.js.
// Bot names, pool addresses, log summaries etc. are user- or chain-supplied and must never be parsed as markup.

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;"
};

/** Escapes a value for use in HTML text or a quoted attribute. null/undefined become an empty string. */
export function escapeHtml(value) {
  if (value == null) {
    return "";
  }

  return String(value).replace(/[&<>"'`]/g, (char) => HTML_ESCAPES[char]);
}
