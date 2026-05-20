import { describe, expect, it } from 'vitest';
import { buildDocumentsListPath } from './useDocumentsQuery';

describe('buildDocumentsListPath', () => {
  it('requests summary mode for wiki navigation lists', () => {
    expect(buildDocumentsListPath('wiki')).toBe('/api/documents?type=wiki&summary=true');
  });

  it('keeps full payloads for typed document lists', () => {
    expect(buildDocumentsListPath('issue')).toBe('/api/documents?type=issue');
  });
});
