import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  api,
  OAuthApp,
  OAuthAppCreateResponse,
  RotateSecretResponse,
  WebhookSubscription,
  WebhookDelivery,
  AuditCallRow,
  UsageStats,
  UsageWindow,
  CreateAppInput,
} from '@/lib/api';
import { cn } from '@/lib/cn';

// ---------------------------------------------------------------------------
// Scope definitions — mirrors api/src/platform/scopes/registry.ts
// ---------------------------------------------------------------------------
const AVAILABLE_SCOPES = [
  { name: 'documents:read', description: 'Read documents (wikis, issues, projects, sprints).' },
  { name: 'documents:write', description: 'Create and update documents.' },
  { name: 'issues:read', description: 'Read issues.' },
  { name: 'issues:write', description: 'Create and update issues, change status and assignment.' },
  { name: 'sprints:read', description: 'Read sprints (weeks) and their contents.' },
  { name: 'sprints:write', description: 'Start and complete sprints, manage sprint membership.' },
  { name: 'webhooks:manage', description: 'Manage webhook subscriptions and replay deliveries.' },
];

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
type Tab = 'apps' | 'webhooks' | 'usage';
const VALID_TABS: Tab[] = ['apps', 'webhooks', 'usage'];

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
        active
          ? 'border-accent text-foreground'
          : 'border-transparent text-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function DeveloperPortalPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as Tab | null;
  const activeTab: Tab = tabParam && VALID_TABS.includes(tabParam) ? tabParam : 'apps';

  const [apps, setApps] = useState<OAuthApp[]>([]);
  const [loading, setLoading] = useState(true);

  const handleTabChange = useCallback(
    (tab: Tab) => setSearchParams({ tab }, { replace: true }),
    [setSearchParams],
  );

  useEffect(() => {
    loadApps();
  }, []);

  async function loadApps() {
    setLoading(true);
    const res = await api.developerPortal.listApps();
    if (res.success && res.data) setApps(res.data);
    setLoading(false);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 items-center border-b border-border px-6">
        <h1 className="text-lg font-semibold text-foreground">Developer Portal</h1>
      </header>

      <div className="border-b border-border">
        <nav className="flex px-6">
          <TabButton active={activeTab === 'apps'} onClick={() => handleTabChange('apps')}>
            OAuth Apps
          </TabButton>
          <TabButton active={activeTab === 'webhooks'} onClick={() => handleTabChange('webhooks')}>
            Webhooks
          </TabButton>
          <TabButton active={activeTab === 'usage'} onClick={() => handleTabChange('usage')}>
            Usage
          </TabButton>
        </nav>
      </div>

      <main className="flex-1 overflow-auto p-6 pb-20">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <div className="text-muted">Loading...</div>
          </div>
        ) : (
          <>
            {activeTab === 'apps' && (
              <AppsTab
                apps={apps}
                onAppCreated={(app) => setApps((prev) => [app, ...prev])}
                onAppDeleted={(appId) => setApps((prev) => prev.filter((a) => a.id !== appId))}
              />
            )}
            {activeTab === 'webhooks' && <WebhooksTab apps={apps} />}
            {activeTab === 'usage' && <UsageTab apps={apps} />}
          </>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apps Tab
// ---------------------------------------------------------------------------
function AppsTab({
  apps,
  onAppCreated,
  onAppDeleted,
}: {
  apps: OAuthApp[];
  onAppCreated: (app: OAuthApp) => void;
  onAppDeleted: (appId: string) => void;
}) {
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  // After create/rotate: hold the revealed secret
  const [revealedSecret, setRevealedSecret] = useState<{
    client_id: string;
    client_secret: string;
    warning: string;
  } | null>(null);

  function handleAppCreated(full: OAuthAppCreateResponse) {
    onAppCreated(full);
    setRevealedSecret({
      client_id: full.client_id,
      client_secret: full.client_secret,
      warning: full.warning,
    });
    setShowRegisterForm(false);
  }

  function handleRotated(res: RotateSecretResponse) {
    setRevealedSecret({
      client_id: res.client_id,
      client_secret: res.client_secret,
      warning: res.warning,
    });
  }

  return (
    <div className="space-y-6">
      {/* One-time secret reveal */}
      {revealedSecret && (
        <SecretRevealBanner
          clientId={revealedSecret.client_id}
          clientSecret={revealedSecret.client_secret}
          warning={revealedSecret.warning}
          onDismiss={() => setRevealedSecret(null)}
        />
      )}

      {/* Register form or button */}
      {showRegisterForm ? (
        <RegisterAppForm
          onCreated={handleAppCreated}
          onCancel={() => setShowRegisterForm(false)}
        />
      ) : (
        <button
          onClick={() => setShowRegisterForm(true)}
          className="px-4 py-2 bg-accent text-white rounded-md hover:bg-accent/90 transition-colors text-sm"
        >
          Register App
        </button>
      )}

      {/* App list */}
      {apps.length === 0 ? (
        <div className="text-muted text-sm">No apps registered yet.</div>
      ) : (
        <div className="space-y-4">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onRotated={handleRotated}
              onDeleted={() => onAppDeleted(app.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Secret Reveal Banner (shown once after create or rotate)
// ---------------------------------------------------------------------------
function SecretRevealBanner({
  clientId,
  clientSecret,
  warning,
  onDismiss,
}: {
  clientId: string;
  clientSecret: string;
  warning: string;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(clientSecret);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="p-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg space-y-3">
      <div className="flex items-start gap-2">
        <span className="text-yellow-500 text-lg" aria-hidden="true">!</span>
        <div>
          <p className="text-sm font-medium text-foreground">New client secret for {clientId}</p>
          <p className="text-xs text-muted mt-0.5">{warning}</p>
        </div>
      </div>

      {visible ? (
        <div className="flex gap-2">
          <code className="flex-1 px-3 py-2 bg-background border border-border rounded-md text-sm font-mono text-foreground overflow-x-auto select-all">
            {clientSecret}
          </code>
          <button
            onClick={handleCopy}
            className={cn(
              'px-3 py-2 rounded-md text-sm transition-colors',
              copied
                ? 'bg-green-500/20 text-green-500'
                : 'bg-border/50 text-foreground hover:bg-border',
            )}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setVisible(true)}
          className="px-3 py-1.5 rounded-md text-sm bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30 transition-colors"
        >
          Click to reveal secret
        </button>
      )}

      <button
        onClick={onDismiss}
        className="text-xs text-muted hover:text-foreground transition-colors"
      >
        {visible ? "I've saved the secret, dismiss this" : 'Dismiss'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Register App Form
// ---------------------------------------------------------------------------
function RegisterAppForm({
  onCreated,
  onCancel,
}: {
  onCreated: (app: OAuthAppCreateResponse) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [redirectUris, setRedirectUris] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);
  const [appType, setAppType] = useState<'confidential' | 'public' | 'first_party'>('confidential');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const uris = redirectUris
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean);

    const input: CreateAppInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      redirect_uris: uris,
      requested_scopes: selectedScopes,
      app_type: appType,
    };

    const res = await api.developerPortal.createApp(input);
    if (res.success && res.data) {
      onCreated(res.data as OAuthAppCreateResponse);
    } else {
      setError(res.error?.message ?? 'Failed to register app');
    }
    setSubmitting(false);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border border-border rounded-lg p-5 space-y-4 bg-background"
    >
      <h2 className="text-sm font-semibold text-foreground">Register a new OAuth App</h2>

      {error && (
        <div className="text-sm text-red-500 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div>
        <label className="block text-xs text-muted mb-1">App Name *</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="My Integration"
          className="w-full max-w-sm px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent text-sm"
        />
      </div>

      <div>
        <label className="block text-xs text-muted mb-1">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
          rows={2}
          placeholder="Optional description"
          className="w-full max-w-sm px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent text-sm resize-none"
        />
      </div>

      <div>
        <label className="block text-xs text-muted mb-1">App Type</label>
        <select
          value={appType}
          onChange={(e) => setAppType(e.target.value as typeof appType)}
          className="px-3 py-2 bg-background border border-border rounded-md text-foreground text-sm"
        >
          <option value="confidential">Confidential (server-side)</option>
          <option value="public">Public (SPA / mobile)</option>
          <option value="first_party">First-party (internal)</option>
        </select>
      </div>

      <div>
        <label className="block text-xs text-muted mb-1">
          Redirect URIs <span className="text-muted">(one per line)</span>
        </label>
        <textarea
          value={redirectUris}
          onChange={(e) => setRedirectUris(e.target.value)}
          rows={3}
          placeholder="https://myapp.example.com/callback"
          className="w-full max-w-sm px-3 py-2 bg-background border border-border rounded-md text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent text-sm font-mono resize-none"
        />
      </div>

      <div>
        <p className="text-xs text-muted mb-2">Requested Scopes</p>
        <div className="space-y-1.5">
          {AVAILABLE_SCOPES.map((s) => (
            <label key={s.name} className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedScopes.includes(s.name)}
                onChange={() => toggleScope(s.name)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-border text-accent focus:ring-accent/50"
              />
              <span className="text-sm">
                <span className="font-mono text-xs text-accent">{s.name}</span>
                <span className="text-muted ml-2 text-xs">{s.description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-3 pt-1">
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="px-4 py-2 bg-accent text-white rounded-md hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {submitting ? 'Registering...' : 'Register App'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 bg-background border border-border text-foreground rounded-md hover:bg-border/30 transition-colors text-sm"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// App Card
// ---------------------------------------------------------------------------
function AppCard({
  app,
  onRotated,
  onDeleted,
}: {
  app: OAuthApp;
  onRotated: (res: RotateSecretResponse) => void;
  onDeleted: () => void;
}) {
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleRotate() {
    if (!confirm('Rotate secret? The current secret will be immediately invalidated.')) return;
    setRotating(true);
    const res = await api.developerPortal.rotateSecret(app.id);
    if (res.success && res.data) onRotated(res.data as RotateSecretResponse);
    setRotating(false);
  }

  async function handleDelete() {
    if (!confirm(`Delete "${app.name}"? This will deactivate the app and revoke all tokens.`)) return;
    setDeleting(true);
    await api.developerPortal.deleteApp(app.id);
    onDeleted();
    setDeleting(false);
  }

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{app.name}</h3>
          {app.description && (
            <p className="text-xs text-muted mt-0.5">{app.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <span className="text-xs text-muted font-mono">ID: {app.client_id}</span>
            <span
              className={cn(
                'text-xs px-1.5 py-0.5 rounded-full',
                app.is_active
                  ? 'bg-green-500/10 text-green-500'
                  : 'bg-red-500/10 text-red-500',
              )}
            >
              {app.is_active ? 'Active' : 'Inactive'}
            </span>
            <span className="text-xs text-muted capitalize">{app.app_type}</span>
          </div>
        </div>

        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleRotate}
            disabled={rotating || !app.is_active}
            className="px-3 py-1.5 text-xs border border-border rounded-md text-foreground hover:bg-border/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {rotating ? 'Rotating...' : 'Rotate Secret'}
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="px-3 py-1.5 text-xs border border-red-500/30 rounded-md text-red-500 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        </div>
      </div>

      {app.requested_scopes.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {app.requested_scopes.map((s) => (
            <span key={s} className="text-xs font-mono px-1.5 py-0.5 bg-accent/10 text-accent rounded">
              {s}
            </span>
          ))}
        </div>
      )}

      {app.redirect_uris.length > 0 && (
        <div>
          <p className="text-xs text-muted mb-1">Redirect URIs</p>
          <ul className="space-y-0.5">
            {app.redirect_uris.map((uri) => (
              <li key={uri} className="text-xs font-mono text-foreground">{uri}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted">
        Registered {new Date(app.created_at).toLocaleDateString()}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Webhooks Tab
// ---------------------------------------------------------------------------
function WebhooksTab({ apps }: { apps: OAuthApp[] }) {
  const [selectedAppId, setSelectedAppId] = useState<string>(apps[0]?.id ?? '');
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [testEventResult, setTestEventResult] = useState<{ subId: string; status: number | null; error?: string } | null>(null);

  useEffect(() => {
    if (!selectedAppId) return;
    loadWebhookData(selectedAppId);
  }, [selectedAppId]);

  async function loadWebhookData(appId: string) {
    setLoadingWebhooks(true);
    const [subsRes, delRes] = await Promise.all([
      api.developerPortal.listSubscriptions(appId),
      api.developerPortal.listDeliveries(appId),
    ]);
    if (subsRes.success && subsRes.data) setSubscriptions(subsRes.data);
    if (delRes.success && delRes.data) setDeliveries(delRes.data);
    setLoadingWebhooks(false);
  }

  async function handleReplay(deliveryId: string) {
    const res = await api.developerPortal.replayDelivery(deliveryId);
    if (res.success) {
      if (selectedAppId) loadWebhookData(selectedAppId);
    }
  }

  async function handleSendTestEvent(subId: string) {
    setTestEventResult(null);
    const res = await api.developerPortal.sendTestEvent(selectedAppId, subId);
    if (res.success && res.data) {
      setTestEventResult({ subId, status: res.data.response_status });
      // Refresh to show the new test delivery in the log.
      if (selectedAppId) loadWebhookData(selectedAppId);
    } else {
      setTestEventResult({ subId, status: null, error: res.error?.message ?? 'Failed' });
    }
  }

  if (apps.length === 0) {
    return (
      <div className="text-muted text-sm">
        No apps yet. Register an app on the OAuth Apps tab first.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* App selector */}
      <div>
        <label className="block text-xs text-muted mb-1">Select App</label>
        <select
          value={selectedAppId}
          onChange={(e) => setSelectedAppId(e.target.value)}
          className="px-3 py-2 bg-background border border-border rounded-md text-foreground text-sm"
        >
          {apps.map((app) => (
            <option key={app.id} value={app.id}>
              {app.name}
            </option>
          ))}
        </select>
      </div>

      {/* Test event result banner */}
      {testEventResult && (
        <div className={cn(
          'p-3 rounded-md border text-sm flex items-center justify-between',
          testEventResult.error
            ? 'bg-red-500/10 border-red-500/30 text-red-500'
            : testEventResult.status != null && testEventResult.status >= 200 && testEventResult.status < 300
              ? 'bg-green-500/10 border-green-500/30 text-green-500'
              : 'bg-yellow-500/10 border-yellow-500/30 text-yellow-600',
        )}>
          <span>
            {testEventResult.error
              ? `Test event failed: ${testEventResult.error}`
              : testEventResult.status != null
                ? `Test event sent — endpoint responded with HTTP ${testEventResult.status}`
                : 'Test event enqueued (delivery pending)'}
          </span>
          <button onClick={() => setTestEventResult(null)} className="text-xs opacity-70 hover:opacity-100 ml-4">
            Dismiss
          </button>
        </div>
      )}

      {loadingWebhooks ? (
        <div className="text-muted text-sm">Loading...</div>
      ) : (
        <>
          {/* Subscriptions */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">Subscriptions</h2>
            {subscriptions.length === 0 ? (
              <p className="text-muted text-sm">
                No webhook subscriptions. Create subscriptions via the{' '}
                <code className="font-mono text-xs bg-border/50 px-1 py-0.5 rounded">
                  POST /api/v1/webhooks/subscriptions
                </code>{' '}
                API.
              </p>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-border/30">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Event Type</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Target URL</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Health</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Created</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {subscriptions.map((sub) => (
                      <SubscriptionRow
                        key={sub.id}
                        sub={sub}
                        onSendTestEvent={() => handleSendTestEvent(sub.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Delivery Log */}
          <section>
            <h2 className="text-sm font-semibold text-foreground mb-3">Delivery Log</h2>
            {deliveries.length === 0 ? (
              <p className="text-muted text-sm">No deliveries yet.</p>
            ) : (
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full">
                  <thead className="bg-border/30">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Event</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Status</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Attempts</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Response</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Latency</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-muted">Created</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-muted">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {deliveries.map((d) => (
                      <DeliveryRow key={d.id} delivery={d} onReplay={() => handleReplay(d.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subscription row — shows health (consecutive failures / auto-disabled badge)
// and a "Send test event" button.
// ---------------------------------------------------------------------------
function SubscriptionRow({
  sub,
  onSendTestEvent,
}: {
  sub: WebhookSubscription;
  onSendTestEvent: () => Promise<void>;
}) {
  const [sending, setSending] = useState(false);

  async function handleTest() {
    setSending(true);
    await onSendTestEvent();
    setSending(false);
  }

  const isAutoDisabled = !sub.active && sub.disabled_reason?.startsWith('auto-disabled');

  return (
    <tr>
      <td className="px-4 py-3 text-sm font-mono text-foreground">{sub.event_type}</td>
      <td className="px-4 py-3 text-sm text-muted font-mono truncate max-w-xs">{sub.target_url}</td>
      <td className="px-4 py-3 text-sm">
        <div className="flex flex-col gap-1">
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded-full w-fit',
            sub.active
              ? 'bg-green-500/10 text-green-500'
              : 'bg-red-500/10 text-red-500',
          )}>
            {sub.active ? 'Active' : 'Inactive'}
          </span>
          {isAutoDisabled && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-500 w-fit">
              Auto-disabled
            </span>
          )}
        </div>
      </td>
      <td className="px-4 py-3 text-sm">
        {sub.consecutive_failures > 0 ? (
          <span className={cn(
            'text-xs font-mono',
            sub.consecutive_failures >= 10 ? 'text-red-500' : 'text-yellow-600',
          )}>
            {sub.consecutive_failures} failure{sub.consecutive_failures !== 1 ? 's' : ''}
          </span>
        ) : (
          <span className="text-xs text-green-500">Healthy</span>
        )}
        {sub.disabled_reason && !isAutoDisabled && (
          <p className="text-xs text-muted mt-0.5 truncate max-w-[180px]" title={sub.disabled_reason}>
            {sub.disabled_reason}
          </p>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-muted">
        {new Date(sub.created_at).toLocaleDateString()}
      </td>
      <td className="px-4 py-3 text-right">
        <button
          onClick={handleTest}
          disabled={sending}
          className="text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
        >
          {sending ? 'Sending...' : 'Send test event'}
        </button>
      </td>
    </tr>
  );
}

function DeliveryRow({ delivery: d, onReplay }: { delivery: WebhookDelivery; onReplay: () => Promise<void> }) {
  const [replaying, setReplaying] = useState(false);

  async function handleReplay() {
    setReplaying(true);
    await onReplay();
    setReplaying(false);
  }

  const statusColors: Record<WebhookDelivery['status'], string> = {
    pending: 'bg-yellow-500/10 text-yellow-500',
    delivered: 'bg-green-500/10 text-green-500',
    dead: 'bg-red-500/10 text-red-500',
  };

  return (
    <tr>
      <td className="px-4 py-3 text-sm font-mono text-foreground">{d.event_type}</td>
      <td className="px-4 py-3 text-sm">
        <span className={cn('text-xs px-1.5 py-0.5 rounded-full', statusColors[d.status])}>
          {d.status}
        </span>
      </td>
      <td className="px-4 py-3 text-sm text-muted text-center">{d.attempt_number}</td>
      <td className="px-4 py-3 text-sm text-muted">
        {d.response_status != null ? (
          <span className={cn(
            'font-mono text-xs',
            d.response_status >= 200 && d.response_status < 300 ? 'text-green-500' : 'text-red-500',
          )}>
            {d.response_status}
          </span>
        ) : (
          <span className="text-muted/50">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-muted">
        {d.latency_ms != null ? `${d.latency_ms}ms` : '—'}
      </td>
      <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">
        {new Date(d.created_at).toLocaleString()}
      </td>
      <td className="px-4 py-3 text-right">
        {(d.status === 'dead' || d.status === 'pending') && (
          <button
            onClick={handleReplay}
            disabled={replaying}
            className="text-xs text-accent hover:text-accent/80 disabled:opacity-50 transition-colors"
          >
            {replaying ? 'Replaying...' : 'Replay'}
          </button>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Usage Tab — API call audit trail
// ---------------------------------------------------------------------------
const USAGE_WINDOW_OPTIONS: { value: UsageWindow; label: string }[] = [
  { value: '1h', label: 'Last 1h' },
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7d' },
  { value: '30d', label: 'Last 30d' },
];

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(rate > 0 && rate < 0.001 ? 2 : 1)}%`;
}

function UsageTab({ apps }: { apps: OAuthApp[] }) {
  const [selectedAppId, setSelectedAppId] = useState<string>(apps[0]?.id ?? '');
  const [usageWindow, setUsageWindow] = useState<UsageWindow>('24h');
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [rows, setRows] = useState<AuditCallRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selectedAppId) return;
    loadUsage(selectedAppId, usageWindow);
  }, [selectedAppId, usageWindow]);

  async function loadUsage(appId: string, window: UsageWindow) {
    setLoading(true);
    const [statsRes, auditRes] = await Promise.all([
      api.developerPortal.getUsageStats(appId, window),
      api.developerPortal.listAuditCalls(appId),
    ]);
    if (statsRes.success && statsRes.data) setStats(statsRes.data);
    if (auditRes.success && auditRes.data) setRows(auditRes.data);
    setLoading(false);
  }

  if (apps.length === 0) {
    return (
      <div className="text-muted text-sm">
        No apps yet. Register an app on the OAuth Apps tab first.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* App + window selectors */}
      <div className="flex flex-wrap gap-4">
        <div>
          <label className="block text-xs text-muted mb-1">Select App</label>
          <select
            value={selectedAppId}
            onChange={(e) => setSelectedAppId(e.target.value)}
            className="px-3 py-2 bg-background border border-border rounded-md text-foreground text-sm"
          >
            {apps.map((app) => (
              <option key={app.id} value={app.id}>
                {app.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted mb-1">Window</label>
          <select
            value={usageWindow}
            onChange={(e) => setUsageWindow(e.target.value as UsageWindow)}
            className="px-3 py-2 bg-background border border-border rounded-md text-foreground text-sm"
          >
            {USAGE_WINDOW_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="text-muted text-sm">Loading...</div>
      ) : (
        <>
        {/* Analytics summary */}
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3">Analytics</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Total Calls" value={(stats?.total_calls ?? 0).toLocaleString()} />
            <StatCard
              label="Error Rate"
              value={formatPercent(stats?.error_rate ?? 0)}
              tone={(stats?.error_rate ?? 0) > 0 ? 'error' : 'ok'}
            />
            <StatCard
              label="p50 Latency"
              value={stats?.p50_ms != null ? `${stats.p50_ms}ms` : '—'}
            />
            <StatCard
              label="p95 Latency"
              value={stats?.p95_ms != null ? `${stats.p95_ms}ms` : '—'}
            />
          </div>
        </section>

        {/* Top routes */}
        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3">Top Routes</h2>
          {!stats || stats.top_routes.length === 0 ? (
            <p className="text-muted text-sm">No API calls in this window.</p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-border/30">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Route</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-muted">Calls</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-muted">Errors</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-muted">Error Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stats.top_routes.map((r) => (
                    <tr key={r.route}>
                      <td className="px-4 py-3 text-xs font-mono text-foreground">{r.route}</td>
                      <td className="px-4 py-3 text-xs text-right text-muted">{r.calls.toLocaleString()}</td>
                      <td className="px-4 py-3 text-xs text-right text-muted">{r.errors.toLocaleString()}</td>
                      <td className="px-4 py-3 text-xs text-right">
                        <span className={cn('font-mono', r.error_rate > 0 ? 'text-red-500' : 'text-green-500')}>
                          {formatPercent(r.error_rate)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="text-sm font-semibold text-foreground mb-3">API Calls</h2>
          {rows.length === 0 ? (
            <p className="text-muted text-sm">No API calls recorded yet.</p>
          ) : (
            <div className="border border-border rounded-lg overflow-hidden">
              <table className="w-full">
                <thead className="bg-border/30">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Time</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Method</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Route</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Scope</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Status</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-muted">Latency</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => {
                    const d = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
                    const statusOk = d.status >= 200 && d.status < 300;
                    return (
                      <tr key={row.id}>
                        <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">
                          {new Date(row.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-foreground">
                          {d.method}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-muted">
                          {d.route}
                        </td>
                        <td className="px-4 py-3 text-xs font-mono text-accent">
                          {d.scope ?? <span className="text-muted/50">—</span>}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <span className={cn(
                            'font-mono',
                            statusOk ? 'text-green-500' : 'text-red-500',
                          )}>
                            {d.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted">
                          {d.latency_ms != null ? `${d.latency_ms}ms` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        </>
      )}
    </div>
  );
}

// Small metric card used in the Usage analytics summary.
function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'error';
}) {
  return (
    <div className="border border-border rounded-lg p-4 bg-background">
      <div className="text-xs text-muted mb-1">{label}</div>
      <div
        className={cn(
          'text-lg font-semibold',
          tone === 'error' ? 'text-red-500' : 'text-foreground',
        )}
      >
        {value}
      </div>
    </div>
  );
}
