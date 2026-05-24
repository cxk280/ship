import { useCallback, useEffect, useState } from 'react';
import { api, apiPost } from '@/lib/api';

type CheckStatus = 'pass' | 'fail' | 'skip';
type Severity = 'critical' | 'high' | 'medium' | 'low';

interface ProbeCheck { category: string; name: string; status: CheckStatus; details?: Record<string, unknown>; }
interface ProbeFinding { category: string; severity: Severity; title: string; description: string; reproductionSteps?: string[]; status: string; }
interface ProbeReport {
  tool: string;
  startedAt: string;
  completedAt?: string;
  target: string;
  checks: ProbeCheck[];
  findings: ProbeFinding[];
  summary: { totalChecks: number; passedChecks: number; failedChecks: number; skippedChecks: number; totalFindings: number; bySeverity: Record<string, number>; byCategory: Record<string, number>; };
  cleanup: { createdDocumentIds: string[]; deleted: number; failed: number };
}

const SURFACE_LABELS: Record<string, string> = {
  'auth-session': 'Auth & Session',
  'websocket-validation': 'WebSocket validation',
  'input-sanitization': 'Input sanitization',
  dependencies: 'Dependencies',
  'manual-review': 'Headers (CSP / CORS)',
  'probe-tool': 'Probe tool',
};

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: 'bg-red-500/15 text-red-400',
  high: 'bg-orange-500/15 text-orange-400',
  medium: 'bg-yellow-500/15 text-yellow-400',
  low: 'bg-border text-muted',
};

// ---- Login layer (same credentials as the main app, super-admin required) ----
function LoginView({ onAuthed }: { onAuthed: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.auth.login(email, password);
      if (!res.success || !res.data) {
        setError(res.error?.message || 'Invalid email or password');
      } else if (!res.data.user.isSuperAdmin) {
        setError('Super-admin access is required to run the security probe.');
      } else {
        onAuthed();
      }
    } catch {
      setError('Sign in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-8 space-y-5">
        <div className="space-y-1.5">
          <h1 className="text-xl font-bold text-foreground">🛡 ShipShape Security Probe</h1>
          <p className="text-sm text-muted">Sign in with your ShipShape admin credentials to run security checks.</p>
        </div>
        {error && <div role="alert" className="rounded-md bg-red-500/15 text-red-400 text-sm px-3 py-2">{error}</div>}
        <div className="space-y-1.5">
          <label htmlFor="probe-email" className="text-xs font-medium text-muted">Email address</label>
          <input id="probe-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required
            className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-accent focus:outline-none" />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="probe-password" className="text-xs font-medium text-muted">Password</label>
          <input id="probe-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required
            className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-accent focus:outline-none" />
        </div>
        <button type="submit" disabled={submitting}
          className="w-full rounded-md bg-accent py-3 text-sm font-semibold text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="rounded-md bg-background px-3 py-2.5 text-xs text-muted">Super-admin access required · same credentials as the main app.</p>
      </form>
    </div>
  );
}

// ---- Dashboard ----
function StatCard({ value, label, valueClass }: { value: string; label: string; valueClass: string }) {
  return (
    <div className="flex-1 rounded-xl border border-border bg-surface p-4">
      <div className={`text-2xl font-bold ${valueClass}`}>{value}</div>
      <div className="text-xs font-medium text-muted mt-1">{label}</div>
    </div>
  );
}

function SurfaceGroup({ category, checks }: { category: string; checks: ProbeCheck[] }) {
  const pass = checks.filter((c) => c.status === 'pass').length;
  const total = checks.length;
  const allPass = pass === total;
  return (
    <div className="rounded-lg bg-background/60 p-3.5 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-foreground">{SURFACE_LABELS[category] || category}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${allPass ? 'bg-green-500/15 text-green-400' : 'bg-yellow-500/15 text-yellow-400'}`}>{pass}/{total} pass</span>
      </div>
      {checks.map((c, i) => (
        <div key={i} className="flex items-center gap-2.5 text-[13px]">
          <span className={c.status === 'pass' ? 'text-green-400' : c.status === 'fail' ? 'text-red-400' : 'text-muted'}>
            {c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '–'}
          </span>
          <span className={c.status === 'fail' ? 'text-muted' : 'text-foreground'}>{c.name}</span>
        </div>
      ))}
    </div>
  );
}

function Dashboard() {
  const [report, setReport] = useState<ProbeReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await apiPost('/api/security-probe/run');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error || `Probe failed (HTTP ${res.status})`);
        return;
      }
      setReport(await res.json());
    } catch {
      setError('Probe request failed. The run may have exceeded the request timeout — try again.');
    } finally {
      setRunning(false);
    }
  }, []);

  const categories = report ? Array.from(new Set(report.checks.map((c) => c.category))) : [];
  const highCritical = report ? (report.summary.bySeverity.critical || 0) + (report.summary.bySeverity.high || 0) : 0;

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-[1320px] space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">ShipShape Security Probe</h1>
            <p className="text-sm text-muted mt-1">Active probe across 4 attack surfaces · auth · websocket · input · dependencies</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-[13px] text-muted">
              {report?.target ? <span className="text-foreground">{report.target}</span> : 'this app (own origin)'}
            </span>
            <button onClick={run} disabled={running}
              className="rounded-lg bg-accent px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50 transition-colors">
              {running ? 'Running…' : '▶  Run Probe'}
            </button>
          </div>
        </div>

        {error && <div role="alert" className="rounded-lg bg-red-500/15 text-red-400 text-sm px-4 py-3">{error}</div>}

        {running && !report && (
          <div className="rounded-xl border border-border bg-surface p-8 text-center text-muted">
            Running active security checks against this app — auth, websocket fuzzing, input payloads, and a dependency audit. This can take up to a minute.
          </div>
        )}

        {!report && !running && (
          <div className="rounded-xl border border-border bg-surface p-8 text-center text-muted">
            Click <span className="text-foreground font-medium">Run Probe</span> to actively test this deployment. The probe creates a few test documents and automatically deletes them when it finishes.
          </div>
        )}

        {report && (
          <>
            <div className="flex gap-4 flex-wrap">
              <StatCard value={`${report.summary.passedChecks} / ${report.summary.totalChecks}`} label="Checks passed" valueClass="text-green-400" />
              <StatCard value={String(report.summary.totalFindings)} label="Open findings" valueClass={report.summary.totalFindings ? 'text-yellow-400' : 'text-green-400'} />
              <StatCard value={String(highCritical)} label="Critical / High" valueClass={highCritical ? 'text-red-400' : 'text-green-400'} />
              <StatCard value={String(report.cleanup.deleted)} label="Test docs cleaned up" valueClass="text-accent" />
            </div>

            <div className="flex gap-4 items-start flex-wrap lg:flex-nowrap">
              {/* Checks by surface */}
              <div className="flex-[3] min-w-[320px] rounded-xl border border-border bg-surface p-4 space-y-3.5">
                <h2 className="text-[15px] font-semibold text-foreground">Checks by attack surface</h2>
                {categories.map((cat) => (
                  <SurfaceGroup key={cat} category={cat} checks={report.checks.filter((c) => c.category === cat)} />
                ))}
              </div>

              {/* Findings */}
              <div className="flex-[2] min-w-[300px] rounded-xl border border-border bg-surface p-4 space-y-3">
                <h2 className="text-[15px] font-semibold text-foreground">Findings</h2>
                {report.findings.length === 0 && <p className="text-sm text-muted">No findings — all checks passed.</p>}
                {report.findings.map((f, i) => (
                  <div key={i} className="rounded-lg bg-background/60 p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_STYLES[f.severity]}`}>{f.severity}</span>
                      <span className="text-xs text-muted">{SURFACE_LABELS[f.category] || f.category}</span>
                    </div>
                    <div className="text-sm font-medium text-foreground">{f.title}</div>
                    <div className="text-xs text-muted leading-relaxed">{f.description}</div>
                  </div>
                ))}
                <p className="text-[11px] text-muted pt-1">
                  Completed {report.completedAt ? new Date(report.completedAt).toLocaleString() : ''} · {report.cleanup.deleted} test doc(s) cleaned up{report.cleanup.failed ? `, ${report.cleanup.failed} failed` : ''}.
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SecurityProbePage() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  const checkAuth = useCallback(async () => {
    try {
      const res = await api.auth.me();
      setAuthed(Boolean(res.success && res.data?.user.isSuperAdmin));
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => { void checkAuth(); }, [checkAuth]);

  if (authed === null) {
    return <div className="min-h-screen bg-background flex items-center justify-center text-muted">Loading…</div>;
  }
  if (!authed) return <LoginView onAuthed={() => setAuthed(true)} />;
  return <Dashboard />;
}
