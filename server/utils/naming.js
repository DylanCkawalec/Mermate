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

  const summary = summarize(source, 3);
  if (summary) return summary;

  return `diagram-${Date.now()}`;
}

const STOP_WORDS = new Set([
  'a','an','the','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','shall','should',
  'may','might','can','could','and','but','or','nor','for','yet','so',
  'in','on','at','to','from','by','with','of','as','if','then','than',
  'it','its','that','this','these','those','my','your','our','their',
  'i','we','you','he','she','they','me','us','him','her','them',
  'not','no','all','each','every','both','few','more','most','other',
  'some','such','only','own','same','very','just','also','about',
]);

function summarize(text, maxWords) {
  const words = text
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
  const picked = words.slice(0, maxWords);
  if (picked.length === 0) return '';
  const slug = slugify(picked.join(' '));
  return slug.length >= 3 && slug.length <= 60 ? slug : '';
}

module.exports = { slugify, dateStamp, deriveDiagramName };
