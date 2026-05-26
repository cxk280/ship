/**
 * Server-side input hardening for user-supplied document text.
 *
 * Defense-in-depth on top of React/TipTap output encoding: strip HTML tags from
 * plain-text fields so stored titles and paragraph text can never carry an
 * executable HTML payload (e.g. `<img src=x onerror=...>`, `<svg onload=...>`)
 * into a downstream renderer, export, log line, or notification.
 *
 * Code blocks are deliberately preserved verbatim — code legitimately contains
 * angle brackets and markup, and TipTap renders code-block text as escaped text.
 */

// Remove anything that looks like an HTML tag. Plain comparisons like "a < b"
// (no matching ">") are left intact; only full `<...>` constructs are stripped.
const HTML_TAG = /<[^>]*>/g;

export function stripHtmlTags(value: string): string {
  return value.replace(HTML_TAG, '');
}

/** Sanitize a short plain-text label (document title). */
export function sanitizeTitle(title: string): string {
  return stripHtmlTags(title);
}

interface TipTapNodeLike {
  type?: string;
  text?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function sanitizeNode(content: unknown, inCodeBlock: boolean): unknown {
  if (Array.isArray(content)) {
    return content.map((child) => sanitizeNode(child, inCodeBlock));
  }
  if (content && typeof content === 'object') {
    const node = content as TipTapNodeLike;
    const isCode = inCodeBlock || node.type === 'codeBlock';
    const next: TipTapNodeLike = { ...node };
    if (typeof node.text === 'string' && !isCode) {
      next.text = stripHtmlTags(node.text);
    }
    if (node.content !== undefined) {
      next.content = sanitizeNode(node.content, isCode);
    }
    return next;
  }
  return content;
}

/**
 * Recursively strip HTML tags from text nodes in a TipTap document, leaving the
 * structure intact and preserving code-block contents.
 */
export function sanitizeTipTapContent<T>(content: T): T {
  return sanitizeNode(content, false) as T;
}
