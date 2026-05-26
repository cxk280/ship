/**
 * Yjs ↔ TipTap JSON Conversion Utilities
 *
 * These functions convert between Yjs XmlFragment format (used for real-time collaboration)
 * and TipTap/ProseMirror JSON format (used for REST API and static content).
 */

import * as Y from 'yjs';

// Mark types that should be converted from wrapper elements to text marks
const MARK_TYPES = new Set(['bold', 'italic', 'strike', 'underline', 'code', 'link']);

type TipTapMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

type TipTapNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: TipTapMark[];
  content?: TipTapNode[];
};

type TipTapDoc = {
  type: 'doc';
  content: TipTapNode[];
};

/**
 * Check if an element is an inline mark (bold, italic, etc.) rather than a block element
 */
function isMarkElement(nodeName: string): boolean {
  return MARK_TYPES.has(nodeName);
}

/**
 * Extract text content and marks from a mark element (e.g., <bold>text</bold>)
 * Returns array of text nodes with marks applied
 */
function extractTextWithMarks(element: Y.XmlElement, inheritedMarks: TipTapMark[] = []): TipTapNode[] {
  const nodeName = element.nodeName;
  const attrs = element.getAttributes();

  // Build mark for this element
  const mark: TipTapMark = { type: nodeName };
  if (nodeName === 'link' && attrs.href) {
    mark.attrs = { href: attrs.href, target: attrs.target || '_blank' };
  }

  const currentMarks = [...inheritedMarks, mark];
  const result: TipTapNode[] = [];

  for (let i = 0; i < element.length; i++) {
    const child = element.get(i);
    if (child instanceof Y.XmlText) {
      const text = child.toString();
      if (text) {
        result.push({ type: 'text', text, marks: currentMarks });
      }
    } else if (child instanceof Y.XmlElement) {
      if (isMarkElement(child.nodeName)) {
        // Nested mark (e.g., <bold><italic>text</italic></bold>)
        result.push(...extractTextWithMarks(child, currentMarks));
      } else {
        // Block element inside mark - shouldn't happen but handle gracefully
        result.push(...yjsElementToJson(child));
      }
    }
  }

  return result;
}

/**
 * Convert Yjs XmlFragment to TipTap JSON
 * This is used when reading documents that were edited via the collaborative editor
 */
export function yjsToJson(fragment: Y.XmlFragment): any {
  const content: TipTapNode[] = [];

  for (let i = 0; i < fragment.length; i++) {
    const item = fragment.get(i);
    if (item instanceof Y.XmlText) {
      // Handle text nodes with formatting
      const text = item.toString();
      if (text) {
        content.push({ type: 'text', text });
      }
    } else if (item instanceof Y.XmlElement) {
      // Check if this is a mark element (bold, italic, etc.)
      if (isMarkElement(item.nodeName)) {
        content.push(...extractTextWithMarks(item));
      } else {
        // Handle block element nodes
        const node: TipTapNode = { type: item.nodeName };

        // Get attributes
        const attrs = item.getAttributes();
        if (Object.keys(attrs).length > 0) {
          // Convert string attributes to proper types (e.g., level should be number)
          const typedAttrs: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(attrs)) {
            if (key === 'level' && typeof value === 'string') {
              typedAttrs[key] = parseInt(value, 10);
            } else {
              typedAttrs[key] = value;
            }
          }
          node.attrs = typedAttrs;
        }

        // Recursively convert children
        if (item.length > 0) {
          const childContent = yjsElementToJson(item);
          if (childContent.length > 0) {
            node.content = childContent;
          }
        }

        content.push(node);
      }
    }
  }

  return { type: 'doc', content };
}

/**
 * Helper to convert element children recursively
 */
function yjsElementToJson(element: Y.XmlElement): TipTapNode[] {
  const content: TipTapNode[] = [];

  for (let i = 0; i < element.length; i++) {
    const item = element.get(i);
    if (item instanceof Y.XmlText) {
      const text = item.toString();
      if (text) {
        content.push({ type: 'text', text });
      }
    } else if (item instanceof Y.XmlElement) {
      // Check if this is a mark element (bold, italic, etc.)
      if (isMarkElement(item.nodeName)) {
        content.push(...extractTextWithMarks(item));
      } else {
        const node: TipTapNode = { type: item.nodeName };

        const attrs = item.getAttributes();
        if (Object.keys(attrs).length > 0) {
          const typedAttrs: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(attrs)) {
            if (key === 'level' && typeof value === 'string') {
              typedAttrs[key] = parseInt(value, 10);
            } else {
              typedAttrs[key] = value;
            }
          }
          node.attrs = typedAttrs;
        }

        if (item.length > 0) {
          const childContent = yjsElementToJson(item);
          if (childContent.length > 0) {
            node.content = childContent;
          }
        }

        content.push(node);
      }
    }
  }

  return content;
}

/**
 * Convert TipTap JSON content to Yjs XmlFragment
 * Must be called within a transaction for proper Yjs integration
 */
export function jsonToYjs(doc: Y.Doc, fragment: Y.XmlFragment, content: any) {
  if (!content || !Array.isArray(content.content)) return;

  doc.transact(() => {
    for (const node of content.content) {
      if (node.type === 'text') {
        // Text node - create, push to parent first, then modify
        const text = new Y.XmlText();
        fragment.push([text]);
        text.insert(0, node.text || '');
        if (node.marks) {
          const attrs: Record<string, unknown> = {};
          for (const mark of node.marks) {
            attrs[mark.type] = mark.attrs || true;
          }
          text.format(0, text.length, attrs);
        }
      } else {
        // Element node (paragraph, heading, bulletList, listItem, etc.)
        const element = new Y.XmlElement(node.type);
        fragment.push([element]);
        // Set attributes after adding to parent
        if (node.attrs) {
          for (const [key, value] of Object.entries(node.attrs)) {
            element.setAttribute(key, value as string);
          }
        }
        // Recursively add children
        if (node.content) {
          jsonToYjsChildren(doc, element, node.content);
        }
      }
    }
  });
}

/**
 * Helper to add children without wrapping in another transaction
 */
function jsonToYjsChildren(doc: Y.Doc, parent: Y.XmlElement, children: TipTapNode[]) {
  for (const node of children) {
    if (node.type === 'text') {
      const text = new Y.XmlText();
      parent.push([text]);
      text.insert(0, node.text || '');
      if (node.marks) {
        const attrs: Record<string, unknown> = {};
        for (const mark of node.marks) {
          attrs[mark.type] = mark.attrs || true;
        }
        text.format(0, text.length, attrs);
      }
    } else {
      const element = new Y.XmlElement(node.type);
      parent.push([element]);
      if (node.attrs) {
        for (const [key, value] of Object.entries(node.attrs)) {
          element.setAttribute(key, value as string);
        }
      }
      if (node.content) {
        jsonToYjsChildren(doc, element, node.content);
      }
    }
  }
}

/**
 * Load document content from Yjs binary state
 * Returns TipTap JSON content or null if unable to convert
 */
export function loadContentFromYjsState(yjsState: Buffer): any | null {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, yjsState);
    const fragment = doc.getXmlFragment('default');
    return yjsToJson(fragment);
  } catch (err) {
    console.error('Failed to load content from Yjs state:', err);
    return null;
  }
}
