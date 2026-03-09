'use strict';

/**
 * Deterministic naming utilities for Mermaid-GPT.
 * All names are lowercase, hyphen-separated, no special characters.
 */

/**
 * Slugify a string into a filesystem-safe, URL-safe identifier.
 * @param {string} input
 * @returns {string}
 */
function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')   // strip non-word chars (keeps hyphens)
    .replace(/[\s_]+/g, '-')    // spaces/underscores → hyphens
    .replace(/-+/g, '-')        // collapse consecutive hyphens
    .replace(/^-|-$/g, '');     // trim leading/trailing hyphens
}

/**
 * Return today's date as YYYY-MM-DD.
 * @returns {string}
 */
function dateStamp() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Derive a diagram name from raw Mermaid source.
 * Tries the first meaningful node label, falls back to 'diagram-<timestamp>'.
 * @param {string} source
 * @param {string} [userProvidedName]
 * @returns {string}
 */
function deriveDiagramName(source, userProvidedName) {
  if (userProvidedName && userProvidedName.trim()) {
    return slugify(userProvidedName.trim());
  }

  // Try to extract a subgraph title or first node label
  const subgraphMatch = source.match(/subgraph\s+\w+\["?([^"\]]+)"?\]/);
  if (subgraphMatch) {
    const slug = slugify(subgraphMatch[1]);
    if (slug.length >= 3 && slug.length <= 80) return slug;
  }

  // Try first node with a label
  const nodeMatch = source.match(/\w+\[["']?([^"'\]]+)["']?\]/);
  if (nodeMatch) {
    const slug = slugify(nodeMatch[1]);
    if (slug.length >= 3 && slug.length <= 80) return slug;
  }

  return `diagram-${Date.now()}`;
}

module.exports = { slugify, dateStamp, deriveDiagramName };
