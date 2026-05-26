// Unit tests for the tolerant JSON extraction that backs the chat/digest answers.
// Regression: a model emitting `"action": undefined` (invalid JSON) used to fail the parse,
// which made the chat node dump the raw JSON blob to the user.
import { describe, it, expect } from 'vitest';
import { extractJson } from '../llm.js';

describe('extractJson', () => {
  it('coerces invalid `undefined` values to null (LLMs emit this when omitting a field)', () => {
    expect(extractJson('{"reply":"nothing at risk","action":undefined}')).toEqual({
      reply: 'nothing at risk',
      action: null,
    });
  });

  it('tolerates trailing commas', () => {
    expect(extractJson('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('parses fenced ```json blocks', () => {
    expect(extractJson('```json\n{"x":true}\n```')).toEqual({ x: true });
  });

  it('parses JSON objects embedded in prose', () => {
    expect(extractJson('Here you go: {"k":"v"} done')).toEqual({ k: 'v' });
  });

  it('returns null for non-JSON prose', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  it('does not mangle the literal word "undefined" inside a string value', () => {
    expect(extractJson('{"reply":"the estimate is undefined"}')).toEqual({
      reply: 'the estimate is undefined',
    });
  });
});
