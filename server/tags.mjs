// Videos are filed under goals by goal id. Which ids are valid is whatever the goal list says right now.

/** Keep only ids that are real goals, once each, in the goal list's order. Anything else is ignored. */
export function cleanTags(input, validIds) {
  const asked = new Set(Array.isArray(input) ? input.filter((t) => typeof t === 'string') : []);
  return validIds.filter((id) => asked.has(id));
}

/** Parse a comma-separated list of ids (the upload query string). */
export function parseTagList(s) {
  return typeof s === 'string' ? s.split(',').map((t) => t.trim()).filter(Boolean) : [];
}
