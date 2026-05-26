import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

const refreshDocuments = vi.fn();

vi.mock('@/contexts/DocumentsContext', () => ({
  useDocuments: () => ({
    documents: [],
    loading: false,
    error: { message: 'Network unavailable' },
    refreshDocuments,
    createDocument: vi.fn(),
    updateDocument: vi.fn(),
    deleteDocument: vi.fn(),
  }),
}));

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { DocumentsPage } from './Documents';

function renderDocumentsPage() {
  return render(
    <BrowserRouter>
      <DocumentsPage />
    </BrowserRouter>
  );
}

describe('DocumentsPage error state', () => {
  beforeEach(() => {
    refreshDocuments.mockClear();
  });

  it('shows a retryable error instead of a blank document list', () => {
    renderDocumentsPage();

    expect(screen.getByRole('heading', { name: 'Documents did not load' })).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refreshDocuments).toHaveBeenCalledTimes(1);
  });
});
