import { describe, it, expect } from 'vitest';
import { eventRegistry, EVENT_TYPES } from '../events.js';

describe('event registry (events-as-data)', () => {
  it('registers the 8 PRD event types', () => {
    expect(eventRegistry.list()).toEqual([
      'document.created', 'document.updated', 'document.deleted',
      'issue.created', 'issue.assigned', 'issue.status_changed',
      'sprint.started', 'sprint.completed',
    ]);
    expect(EVENT_TYPES).toHaveLength(8);
  });

  it('has() narrows unknown strings', () => {
    expect(eventRegistry.has('document.created')).toBe(true);
    expect(eventRegistry.has('document.exploded')).toBe(false);
  });

  it('validates a good document.created payload and rejects a bad one', () => {
    const ok = {
      id: '11111111-1111-1111-1111-111111111111',
      document_type: 'wiki',
      title: 'Hi',
      workspace_id: '22222222-2222-2222-2222-222222222222',
    };
    expect(() => eventRegistry.validate('document.created', ok)).not.toThrow();
    expect(() => eventRegistry.validate('document.created', { id: 'not-a-uuid' })).toThrow();
  });
});
