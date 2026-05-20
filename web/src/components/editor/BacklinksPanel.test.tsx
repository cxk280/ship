import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

import { BacklinksPanel } from './BacklinksPanel';

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    value,
  });
}

function renderBacklinksPanel() {
  return render(
    <BrowserRouter>
      <BacklinksPanel documentId="doc-123" />
    </BrowserRouter>
  );
}

describe('BacklinksPanel offline handling', () => {
  beforeEach(() => {
    setNavigatorOnline(false);
    vi.spyOn(window, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setNavigatorOnline(true);
  });

  it('does not poll or show fetch errors while offline', async () => {
    renderBacklinksPanel();

    await screen.findByText('Backlinks unavailable offline');
    expect(window.fetch).not.toHaveBeenCalled();
  });
});
