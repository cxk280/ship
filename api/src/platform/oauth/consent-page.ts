/**
 * Minimal, self-contained HTML for the OAuth consent + device-verification
 * screens. A dedicated layout (no React bundle) keeps the security surface small
 * and the Playwright flow fast. Frame-busting headers are set by the route.
 */
import { scopeRegistry } from '../scopes/registry.js';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function scopeList(scopes: string[]): string {
  return scopes
    .map((s) => {
      const def = scopeRegistry.get(s);
      return `<li><code>${esc(s)}</code><span>${esc(def?.description ?? '')}</span></li>`;
    })
    .join('');
}

const STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, system-ui, sans-serif; background:#f4f6f8; margin:0;
         display:flex; min-height:100vh; align-items:center; justify-content:center; }
  .card { background:#fff; max-width:440px; width:100%; padding:32px; border-radius:12px;
          box-shadow:0 8px 30px rgba(20,38,61,.12); }
  h1 { font-size:20px; margin:0 0 4px; color:#16263d; }
  .sub { color:#5b6675; font-size:14px; margin:0 0 20px; }
  ul { list-style:none; padding:0; margin:0 0 24px; }
  li { padding:10px 12px; border:1px solid #e3e8ee; border-radius:8px; margin-bottom:8px; }
  li code { font-weight:600; color:#2e6fb7; display:block; }
  li span { color:#5b6675; font-size:13px; }
  .row { display:flex; gap:12px; }
  button { flex:1; padding:11px; border-radius:8px; border:0; font-size:15px; font-weight:600; cursor:pointer; }
  .approve { background:#2e6fb7; color:#fff; }
  .deny { background:#eef1f4; color:#16263d; }
  input.code { width:100%; padding:12px; font-size:22px; letter-spacing:3px; text-align:center;
               text-transform:uppercase; border:1px solid #c4cdd6; border-radius:8px; margin-bottom:16px; }
`;

export function consentPage(opts: {
  appName: string;
  scopes: string[];
  csrfToken: string;
  /** Hidden fields to round-trip through the POST. */
  hidden: Record<string, string>;
  /** Where the form posts. */
  action: string;
  /** Optional sub-line, e.g. for the device flow. */
  subtitle?: string;
}): string {
  const hiddenInputs = Object.entries(opts.hidden)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${esc(opts.appName)}</title><style>${STYLE}</style></head>
<body><div class="card">
  <h1>Authorize ${esc(opts.appName)}</h1>
  <p class="sub">${esc(opts.subtitle ?? `${opts.appName} is requesting access to your Ship account.`)}</p>
  <ul>${scopeList(opts.scopes)}</ul>
  <form method="post" action="${esc(opts.action)}">
    ${hiddenInputs}
    <input type="hidden" name="csrf_token" value="${esc(opts.csrfToken)}">
    <div class="row">
      <button class="deny" type="submit" name="decision" value="deny">Deny</button>
      <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
    </div>
  </form>
</div></body></html>`;
}

export function deviceVerifyPage(opts: {
  csrfToken: string;
  prefillUserCode?: string;
  action: string;
  message?: string;
}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device Login · Ship</title><style>${STYLE}</style></head>
<body><div class="card">
  <h1>Connect a device</h1>
  <p class="sub">${esc(opts.message ?? 'Enter the code shown on your device to continue.')}</p>
  <form method="post" action="${esc(opts.action)}">
    <input type="hidden" name="csrf_token" value="${esc(opts.csrfToken)}">
    <input class="code" name="user_code" autocomplete="off" autocapitalize="characters"
           placeholder="XXXX-XXXX" value="${esc(opts.prefillUserCode ?? '')}" required>
    <div class="row"><button class="approve" type="submit">Continue</button></div>
  </form>
</div></body></html>`;
}

export function devicePostedPage(message: string, ok: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device Login · Ship</title><style>${STYLE}</style></head>
<body><div class="card"><h1>${ok ? 'All set ✓' : 'Something went wrong'}</h1>
<p class="sub">${esc(message)}</p></div></body></html>`;
}
