// FleetGraph dock: an embedded, context-aware surface for the agent.
// - Bell + inbox: proactive findings and HITL approval cards (Approve / Snooze / Dismiss).
// - Chat: scoped to whatever document/issue/sprint the user is currently viewing.
// Reuses the existing /events WebSocket and toast system.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useCurrentDocument } from '@/contexts/CurrentDocumentContext';
import { useRealtimeEvent } from '@/hooks/useRealtimeEvents';
import { useToast } from '@/components/ui/Toast';
import {
  getInbox, resumeApproval, resolveFinding, chat,
  type FgChatScope, type Decision, type Severity,
} from '@/lib/fleetgraph';

const SEV_COLOR: Record<Severity, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-slate-400',
  info: 'bg-blue-500',
};

interface ChatMsg { role: 'user' | 'agent'; text: string; }

export function FleetGraphDock() {
  const [panel, setPanel] = useState<'inbox' | 'chat' | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [pendingAction, setPendingAction] = useState<{ threadId: string; summary: string } | null>(null);
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const { currentDocumentType, currentDocumentId, currentDocumentProjectId } = useCurrentDocument();
  const chatEndRef = useRef<HTMLDivElement>(null);

  const inbox = useQuery({
    queryKey: ['fleetgraph', 'inbox'],
    queryFn: getInbox,
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  const findings = inbox.data?.findings ?? [];
  const approvals = inbox.data?.approvals ?? [];
  const unread = findings.length + approvals.length;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['fleetgraph', 'inbox'] });
  }, [queryClient]);

  // Proactive pushes over the existing /events WebSocket.
  useRealtimeEvent('fleetgraph:finding', useCallback((e) => {
    refresh();
    const title = (e.data?.title as string) || 'New finding';
    if (!(e.data?.resolved)) showToast(`FleetGraph: ${title}`, 'info', 5000);
  }, [refresh, showToast]));

  useRealtimeEvent('fleetgraph:interrupt', useCallback((e) => {
    refresh();
    showToast(`FleetGraph needs your OK: ${(e.data?.summary as string) || 'an action'}`, 'info', 6000);
  }, [refresh, showToast]));

  useEffect(() => {
    if (panel === 'chat') chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, panel]);

  const resumeMut = useMutation({
    mutationFn: ({ threadId, decision }: { threadId: string; decision: Decision }) =>
      resumeApproval(threadId, decision, decision === 'snooze' ? 7 : undefined),
    onSuccess: (_d, vars) => {
      showToast(
        vars.decision === 'approve' ? 'FleetGraph applied the change' :
        vars.decision === 'snooze' ? 'Snoozed for 7 days' : 'Dismissed',
        'success',
      );
      refresh();
    },
    onError: () => showToast('Could not submit decision', 'error'),
  });

  // Manual dismiss/snooze for autonomous findings (those without an approval card).
  const findingMut = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'dismiss' | 'snooze' }) =>
      resolveFinding(id, decision, decision === 'snooze' ? 7 : undefined),
    onSuccess: (_d, vars) => {
      showToast(vars.decision === 'snooze' ? 'Snoozed for 7 days' : 'Dismissed', 'success');
      refresh();
    },
    onError: () => showToast('Could not update finding', 'error'),
  });

  const scope = (): FgChatScope => {
    if (!currentDocumentId || !currentDocumentType) return {};
    const s: FgChatScope = { documentId: currentDocumentId, documentType: currentDocumentType };
    if (currentDocumentType === 'sprint') s.sprintId = currentDocumentId;
    if (currentDocumentType === 'project') s.projectId = currentDocumentId;
    else if (currentDocumentProjectId) s.projectId = currentDocumentProjectId;
    return s;
  };

  const chatMut = useMutation({
    mutationFn: (message: string) => chat(message, scope()),
    onSuccess: (res) => {
      setMessages((m) => [...m, { role: 'agent', text: res.answer }]);
      setPendingAction(res.pendingApproval ?? null);
    },
    onError: () => setMessages((m) => [...m, { role: 'agent', text: 'Sorry — I could not reach the reasoning model.' }]),
  });

  // Resolve a chat-proposed action inline (reuses the same HITL resume endpoint).
  const chatActResolving = useRef(false);
  const resolveChatAction = async (decision: 'approve' | 'dismiss') => {
    if (!pendingAction || chatActResolving.current) return;
    chatActResolving.current = true;
    const { threadId, summary } = pendingAction;
    setPendingAction(null);
    try {
      await resumeApproval(threadId, decision);
      setMessages((m) => [...m, { role: 'agent', text: decision === 'approve' ? `✅ Applied: ${summary}` : `Cancelled: ${summary}` }]);
      if (decision === 'approve') showToast('FleetGraph applied the change', 'success');
      refresh();
    } catch {
      setMessages((m) => [...m, { role: 'agent', text: 'Could not complete that action.' }]);
    } finally {
      chatActResolving.current = false;
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || chatMut.isPending) return;
    setMessages((m) => [...m, { role: 'user', text }]);
    setInput('');
    chatMut.mutate(text);
  };

  const contextLabel = (() => {
    switch (currentDocumentType) {
      case 'issue': return 'this issue';
      case 'sprint': return 'this week';
      case 'project': return 'this project';
      case 'program': return 'this program';
      case 'person': return 'this person';
      default: return 'your workspace';
    }
  })();

  return (
    <div className="fixed bottom-4 right-16 z-[60] flex flex-col items-end gap-3" data-testid="fleetgraph-dock">
      {/* ---------- Inbox panel ---------- */}
      {panel === 'inbox' && (
        <div className="w-[380px] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-background shadow-2xl">
          <div className="sticky top-0 flex items-center justify-between border-b border-border bg-background px-4 py-3">
            <div className="font-semibold text-foreground">FleetGraph</div>
            <button onClick={() => setPanel(null)} className="text-muted-foreground hover:text-foreground" aria-label="Close">✕</button>
          </div>
          <div className="p-3 space-y-3">
            {approvals.length === 0 && findings.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {inbox.isLoading ? 'Loading…' : 'Nothing needs your attention. 🎉'}
              </div>
            )}

            {approvals.map((a) => (
              <div key={a.threadId} className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700/50 dark:bg-amber-950/30">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Needs approval</div>
                <div className="text-sm text-foreground">{a.summary}</div>
                {a.proposedAction?.rationale && (
                  <div className="mt-1 text-xs text-muted-foreground">{a.proposedAction.rationale}</div>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => resumeMut.mutate({ threadId: a.threadId, decision: 'approve' })}
                    disabled={resumeMut.isPending}
                    className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >Approve</button>
                  <button
                    onClick={() => resumeMut.mutate({ threadId: a.threadId, decision: 'snooze' })}
                    disabled={resumeMut.isPending}
                    className="rounded border border-border px-3 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >Snooze 7d</button>
                  <button
                    onClick={() => resumeMut.mutate({ threadId: a.threadId, decision: 'dismiss' })}
                    disabled={resumeMut.isPending}
                    className="rounded border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >Dismiss</button>
                </div>
              </div>
            ))}

            {findings.map((f) => (
              <div key={f.id} className="rounded-lg border border-border bg-background p-3">
                <div className="flex items-start gap-2">
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV_COLOR[f.severity]}`} />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{f.title}</div>
                    <div className="text-xs text-muted-foreground">{f.detail}</div>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => findingMut.mutate({ id: f.id, decision: 'snooze' })}
                    disabled={findingMut.isPending}
                    className="rounded border border-border px-2 py-0.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >Snooze 7d</button>
                  <button
                    onClick={() => findingMut.mutate({ id: f.id, decision: 'dismiss' })}
                    disabled={findingMut.isPending}
                    className="rounded border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
                  >Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ---------- Chat panel ---------- */}
      {panel === 'chat' && (
        <div className="flex h-[60vh] w-[380px] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <div className="font-semibold text-foreground">Ask FleetGraph</div>
              <div className="text-xs text-muted-foreground">Context: {contextLabel}</div>
            </div>
            <button onClick={() => setPanel(null)} className="text-muted-foreground hover:text-foreground" aria-label="Close">✕</button>
          </div>
          <div className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <div className="text-sm text-muted-foreground">
                Ask about {contextLabel} — e.g. “What's at risk here?”, “Who's overloaded?”, “Is this week on track?”
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
                <span className={`inline-block max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground'
                }`}>{m.text}</span>
              </div>
            ))}
            {chatMut.isPending && <div className="text-left text-sm text-muted-foreground">FleetGraph is thinking…</div>}
            {pendingAction && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700/50 dark:bg-amber-950/30">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Proposed action — needs your OK</div>
                <div className="text-sm text-foreground">{pendingAction.summary}</div>
                <div className="mt-2 flex gap-2">
                  <button onClick={() => resolveChatAction('approve')} className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90">Apply</button>
                  <button onClick={() => resolveChatAction('dismiss')} className="rounded border border-border px-3 py-1 text-xs font-medium text-muted-foreground hover:bg-muted">Cancel</button>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="flex gap-2 border-t border-border p-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
              placeholder={`Ask about ${contextLabel}…`}
              className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              onClick={send}
              disabled={chatMut.isPending || !input.trim()}
              className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >Send</button>
          </div>
        </div>
      )}

      {/* ---------- Launcher buttons ---------- */}
      <div className="flex gap-2">
        <button
          onClick={() => setPanel(panel === 'inbox' ? null : 'inbox')}
          className="relative flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background shadow-lg hover:bg-muted"
          aria-label="FleetGraph notifications"
        >
          <BellIcon />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
        <button
          onClick={() => setPanel(panel === 'chat' ? null : 'chat')}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90"
          aria-label="Ask FleetGraph"
        >
          <ChatIcon />
        </button>
      </div>
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-foreground">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
