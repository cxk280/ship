/**
 * Example plugin sources for demonstration and testing.
 */

/** Trims and upper-cases the document title. */
export const UPPERCASE_TITLE_PLUGIN = `
module.exports = function beforeCreate(ctx) {
  ctx.title = (ctx.title || '').trim().toUpperCase();
  return ctx;
};
`;

/**
 * Rejects documents with empty or whitespace-only titles.
 * This is the "guard" plugin — a veto example.
 */
export const REQUIRE_TITLE_PLUGIN = `
module.exports = function beforeCreate(ctx) {
  if (!ctx.title || !ctx.title.trim()) {
    throw new Error('Document title is required and cannot be empty.');
  }
  return ctx;
};
`;

/** Adds a default tag property if none is present. */
export const DEFAULT_TAG_PLUGIN = `
module.exports = function beforeCreate(ctx) {
  if (!ctx.properties.tags) {
    ctx.properties.tags = ['untagged'];
  }
  return ctx;
};
`;
