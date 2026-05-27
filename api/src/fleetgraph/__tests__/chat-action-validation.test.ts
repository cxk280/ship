// Unit tests for the chat-action payload validator (the trust boundary between LLM output and a
// HITL write to documents.properties). Regression: payloadOk used to accept any string for
// state/priority/due_date and negative/huge estimates, so the model (steered by untrusted issue
// titles or the user's message) could drive a garbage write past the approval gate.
import { describe, it, expect } from 'vitest';
import { isValidChatActionPayload } from '../graph.js';

const TEAM = new Set(['11111111-1111-1111-1111-111111111111']);

describe('isValidChatActionPayload', () => {
  it('reassign: only to a known team user id', () => {
    expect(isValidChatActionPayload('reassign', { assignee_id: '11111111-1111-1111-1111-111111111111' }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('reassign', { assignee_id: 'someone-else' }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('reassign', {}, TEAM)).toBe(false);
  });

  it('set_state: only known states', () => {
    expect(isValidChatActionPayload('set_state', { state: 'in_progress' }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('set_state', { state: 'done' }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('set_state', { state: 'shipped' }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_state', { state: '' }, TEAM)).toBe(false);
  });

  it('set_priority: only known priorities', () => {
    expect(isValidChatActionPayload('set_priority', { priority: 'urgent' }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('set_priority', { priority: 'CRITICAL' }, TEAM)).toBe(false);
  });

  it('set_estimate: finite, non-negative, bounded', () => {
    expect(isValidChatActionPayload('set_estimate', { estimate: 5 }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('set_estimate', { estimate: 0 }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('set_estimate', { estimate: -3 }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_estimate', { estimate: 1e9 }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_estimate', { estimate: Number.NaN }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_estimate', { estimate: Infinity }, TEAM)).toBe(false);
  });

  it('set_due_date: strict ISO date, rejects rolled-over/garbage dates', () => {
    expect(isValidChatActionPayload('set_due_date', { due_date: '2026-05-27' }, TEAM)).toBe(true);
    expect(isValidChatActionPayload('set_due_date', { due_date: '2026-02-30' }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_due_date', { due_date: '2026-13-01' }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_due_date', { due_date: '05/27/2026' }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('set_due_date', { due_date: 'tomorrow' }, TEAM)).toBe(false);
  });

  it('rejects unknown action kinds', () => {
    expect(isValidChatActionPayload('delete_issue', { id: 'x' }, TEAM)).toBe(false);
    expect(isValidChatActionPayload('comment', { body: 'hi' }, TEAM)).toBe(false);
  });
});
