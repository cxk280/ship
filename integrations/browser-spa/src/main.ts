/**
 * Ship Browser SPA — Authorization Code + PKCE demo.
 *
 * Page states:
 *   /            → not logged in → shows "Sign in" button
 *   /callback    → exchanges the code, redirects to /
 *   / (authed)   → fetches /api/v1/documents and renders titles
 */
import { initiateLogin, handleCallback, getAccessToken } from './auth.js';
import { BASE_URL } from './config.js';

const statusEl = document.getElementById('status')!;
const loginBtn = document.getElementById('login-btn')! as HTMLButtonElement;
const listEl = document.getElementById('docs-list')!;

function setStatus(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : '';
}

async function fetchDocuments(token: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/documents?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch documents: HTTP ${res.status}`);
  const data = (await res.json()) as { data: { id: string; title: string; document_type: string }[] };

  if (data.data.length === 0) {
    setStatus('No documents found.');
    return;
  }
  setStatus(`Showing ${data.data.length} document(s):`);
  listEl.innerHTML = '';
  for (const doc of data.data) {
    const li = document.createElement('li');
    li.textContent = doc.title || '(Untitled)';
    const span = document.createElement('span');
    span.className = 'type';
    span.textContent = doc.document_type;
    li.appendChild(span);
    listEl.appendChild(li);
  }
}

async function main(): Promise<void> {
  try {
    // Check if we're handling the OAuth callback.
    if (window.location.pathname === '/callback' || window.location.search.includes('code=')) {
      setStatus('Exchanging authorization code…');
      await handleCallback();
      setStatus('Signed in — loading documents…');
    }

    const token = getAccessToken();
    if (!token) {
      setStatus('Not signed in.');
      loginBtn.style.display = 'inline-block';
      loginBtn.addEventListener('click', () => {
        initiateLogin().catch((err: unknown) => {
          setStatus(`Login error: ${err instanceof Error ? err.message : String(err)}`, true);
        });
      });
      return;
    }

    setStatus('Loading documents…');
    await fetchDocuments(token);
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

main();
