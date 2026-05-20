import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { yjsToJson, jsonToYjs, loadContentFromYjsState } from '../yjsConverter.js';

function buildFragment(seed: (doc: Y.Doc, fragment: Y.XmlFragment) => void): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('default');
  doc.transact(() => {
    seed(doc, fragment);
  });
  return fragment;
}

describe('yjsConverter', () => {
  describe('yjsToJson', () => {
    it('returns an empty doc for an empty fragment', () => {
      const fragment = buildFragment(() => {});
      expect(yjsToJson(fragment)).toEqual({ type: 'doc', content: [] });
    });

    it('converts a paragraph with plain text', () => {
      const fragment = buildFragment((_doc, frag) => {
        const paragraph = new Y.XmlElement('paragraph');
        frag.push([paragraph]);
        const text = new Y.XmlText();
        paragraph.push([text]);
        text.insert(0, 'Hello world');
      });

      const result = yjsToJson(fragment);
      expect(result.type).toBe('doc');
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello world' }],
      });
    });

    it('converts a link mark wrapping text, including href and target attrs (covers extractTextWithMarks link branch)', () => {
      const fragment = buildFragment((_doc, frag) => {
        const link = new Y.XmlElement('link');
        frag.push([link]);
        link.setAttribute('href', 'https://treasury.gov');
        link.setAttribute('target', '_self');
        const text = new Y.XmlText();
        link.push([text]);
        text.insert(0, 'click here');
      });

      const result = yjsToJson(fragment);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toEqual({
        type: 'text',
        text: 'click here',
        marks: [{ type: 'link', attrs: { href: 'https://treasury.gov', target: '_self' } }],
      });
    });

    it('defaults link target to _blank when not provided', () => {
      const fragment = buildFragment((_doc, frag) => {
        const link = new Y.XmlElement('link');
        frag.push([link]);
        link.setAttribute('href', 'https://example.com');
        const text = new Y.XmlText();
        link.push([text]);
        text.insert(0, 'docs');
      });

      const result = yjsToJson(fragment);
      expect(result.content[0]).toMatchObject({
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.com', target: '_blank' } }],
      });
    });

    it('handles nested marks: <bold><italic>text</italic></bold>', () => {
      const fragment = buildFragment((_doc, frag) => {
        const bold = new Y.XmlElement('bold');
        frag.push([bold]);
        const italic = new Y.XmlElement('italic');
        bold.push([italic]);
        const text = new Y.XmlText();
        italic.push([text]);
        text.insert(0, 'styled');
      });

      const result = yjsToJson(fragment);
      expect(result.content).toHaveLength(1);
      const node = result.content[0];
      expect(node.type).toBe('text');
      expect(node.text).toBe('styled');
      expect(node.marks).toEqual([
        { type: 'bold' },
        { type: 'italic' },
      ]);
    });

    it('converts heading level attribute from string to number', () => {
      const fragment = buildFragment((_doc, frag) => {
        const heading = new Y.XmlElement('heading');
        frag.push([heading]);
        heading.setAttribute('level', '2');
        const text = new Y.XmlText();
        heading.push([text]);
        text.insert(0, 'Title');
      });

      const result = yjsToJson(fragment);
      expect(result.content[0]).toMatchObject({
        type: 'heading',
        attrs: { level: 2 },
      });
    });
  });

  describe('jsonToYjs round-trip', () => {
    it('writes TipTap JSON into a Yjs fragment that yjsToJson can read back', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');

      jsonToYjs(doc, fragment, {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'plain' }],
          },
        ],
      });

      const result = yjsToJson(fragment);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: 'paragraph',
        content: [{ type: 'text', text: 'plain' }],
      });
    });

    it('is a no-op when given malformed content', () => {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');

      jsonToYjs(doc, fragment, null);
      jsonToYjs(doc, fragment, { type: 'doc' });

      expect(yjsToJson(fragment)).toEqual({ type: 'doc', content: [] });
    });
  });

  describe('loadContentFromYjsState', () => {
    it('returns parsed TipTap JSON for a valid Yjs update buffer', () => {
      const source = new Y.Doc();
      const sourceFragment = source.getXmlFragment('default');
      source.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        sourceFragment.push([paragraph]);
        const text = new Y.XmlText();
        paragraph.push([text]);
        text.insert(0, 'persisted');
      });

      const update = Y.encodeStateAsUpdate(source);
      const buffer = Buffer.from(update);

      const result = loadContentFromYjsState(buffer);
      expect(result).not.toBeNull();
      expect(result.type).toBe('doc');
      expect(result.content[0]).toMatchObject({
        type: 'paragraph',
        content: [{ type: 'text', text: 'persisted' }],
      });
    });

    it('returns null when the buffer is not a valid Yjs update', () => {
      const result = loadContentFromYjsState(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      expect(result).toBeNull();
    });
  });
});
