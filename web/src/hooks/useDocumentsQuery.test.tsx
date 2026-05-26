import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { apiGet } from '@/lib/api';
import { buildDocumentsListPath, useDocuments, useDocumentsQuery } from './useDocumentsQuery';

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
}));

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const okResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('buildDocumentsListPath', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
  });

  it('requests summary mode for wiki navigation lists', () => {
    expect(buildDocumentsListPath('wiki')).toBe('/api/documents?type=wiki&summary=true');
  });

  it('keeps full payloads for typed document lists', () => {
    expect(buildDocumentsListPath('issue')).toBe('/api/documents?type=issue');
  });

  it('fetches wiki documents through the summary list endpoint', async () => {
    const documents = [{
      id: 'doc-1',
      title: 'Doc',
      document_type: 'wiki',
      parent_id: null,
      position: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      visibility: 'workspace' as const,
    }];
    vi.mocked(apiGet).mockResolvedValueOnce(okResponse(documents) as Response);

    const { result } = renderHook(() => useDocumentsQuery('wiki'), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith('/api/documents?type=wiki&summary=true');
    expect(result.current.data).toEqual(documents);
  });

  it('exposes loading, error, and retry state through the compatibility hook', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ ok: false, status: 503 } as Response);

    const { result } = renderHook(() => useDocuments(), { wrapper });

    await waitFor(() => expect(result.current.error?.status).toBe(503));
    expect(result.current.documents).toEqual([]);
    await result.current.refreshDocuments();
    expect(apiGet).toHaveBeenCalledWith('/api/documents?type=wiki&summary=true');
  });
});
