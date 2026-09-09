/**
 * fonts.ts — the table's ONE text font, served from the app itself.
 *
 * drei's <Text> WITHOUT a `font` prop makes troika fetch Roboto from the
 * jsdelivr unicode-font-resolver CDN (verified in drei/core/Text.js:34 +
 * troika's bundled resolver) — inside a <Suspense>, a blocked/slow CDN would
 * blank the ENTIRE island (quality review I-3). Every <Text> in apps/table
 * passes font={TABLE_FONT} so the only fetch is this local file, and text
 * subtrees still get their own Suspense so a load hiccup pops labels in
 * instead of hiding the board.
 *
 * Rubik Medium (Google Fonts, SIL Open Font License 1.1) — OFL permits
 * bundling/redistribution; satisfies the no-copyrighted-assets rule.
 */
export const TABLE_FONT = "/fonts/Rubik-Medium.ttf";
