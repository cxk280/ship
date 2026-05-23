import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UnifiedEditor } from '@/components/UnifiedEditor';
import type { UnifiedDocument, SidebarData } from '@/components/UnifiedEditor';
import { useAuth } from '@/hooks/useAuth';
import { useAssignableMembersQuery } from '@/hooks/useTeamMembersQuery';
import { useIssuesQuery } from '@/hooks/useIssuesQuery';
import { apiGet, apiPatch, apiDelete } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { DocumentTabProps } from '@/lib/document-tabs';

interface ProgramProjectSummary {
  id: string;
  title: string;
}

/**
 * ProgramOverviewTab - Renders the program document in the UnifiedEditor
 *
 * This is the "Overview" tab content when viewing a program document.
 */
export default function ProgramOverviewTab({ documentId, document }: DocumentTabProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Fetch team members for sidebar
  const { data: teamMembersData = [] } = useAssignableMembersQuery();
  const teamMembers = useMemo(() => teamMembersData.map(m => ({
    id: m.id,
    user_id: m.user_id,
    name: m.name,
    email: m.email || '',
  })), [teamMembersData]);
  const { data: issues = [] } = useIssuesQuery({ programId: documentId });
  const { data: projects = [] } = useQuery<ProgramProjectSummary[]>({
    queryKey: ['program-projects', documentId],
    queryFn: async () => {
      const response = await apiGet(`/api/programs/${documentId}/projects`);
      if (!response.ok) {
        throw new Error('Failed to fetch projects');
      }
      return response.json();
    },
  });

  // Update mutation with optimistic updates
  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<UnifiedDocument>) => {
      const response = await apiPatch(`/api/documents/${documentId}`, updates);
      if (!response.ok) {
        throw new Error('Failed to update document');
      }
      return response.json();
    },
    onMutate: async (updates) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['document', documentId] });
      await queryClient.cancelQueries({ queryKey: ['programs'] });

      // Snapshot the previous value
      const previousDocument = queryClient.getQueryData<Record<string, unknown>>(['document', documentId]);

      // Optimistically update the document cache
      if (previousDocument) {
        const programUpdates = updates as Record<string, unknown>;
        queryClient.setQueryData(['document', documentId], { ...previousDocument, ...programUpdates });
      }

      // Return context with the previous value for rollback
      return { previousDocument };
    },
    onError: (_err, _updates, context) => {
      // Rollback to the previous value on error
      if (context?.previousDocument) {
        queryClient.setQueryData(['document', documentId], context.previousDocument);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      queryClient.invalidateQueries({ queryKey: ['programs'] });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiDelete(`/api/documents/${documentId}`);
      if (!response.ok) {
        throw new Error('Failed to delete document');
      }
    },
    onSuccess: () => {
      navigate('/programs');
    },
  });

  // Handle back navigation
  const handleBack = useCallback(() => {
    navigate('/programs');
  }, [navigate]);

  // Handle update
  const handleUpdate = useCallback(async (updates: Partial<UnifiedDocument>) => {
    await updateMutation.mutateAsync(updates);
  }, [updateMutation]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!window.confirm('Are you sure you want to delete this program?')) return;
    await deleteMutation.mutateAsync();
  }, [deleteMutation]);

  // Build sidebar data
  const sidebarData: SidebarData = useMemo(() => ({
    people: teamMembers,
  }), [teamMembers]);

  const programSummary = useMemo(() => {
    const totalIssues = issues.length;
    const completedIssues = issues.filter(issue => issue.state === 'done' || Boolean(issue.completed_at)).length;
    const openIssues = totalIssues - completedIssues;
    const highPriorityOpenIssues = issues.filter(issue => (
      issue.state !== 'done'
      && !issue.completed_at
      && ['high', 'critical'].includes(issue.priority)
    )).length;
    const completionPercent = totalIssues > 0 ? Math.round((completedIssues / totalIssues) * 100) : 0;
    const owner = teamMembers.find(member => member.id === document.owner_id || member.user_id === document.owner_id);
    const health = highPriorityOpenIssues > 0
      ? 'At risk'
      : completionPercent >= 75
        ? 'On track'
        : 'Needs attention';

    return {
      totalIssues,
      completedIssues,
      openIssues,
      highPriorityOpenIssues,
      completionPercent,
      ownerName: owner?.name ?? 'Unassigned',
      projectCount: projects.length,
      health,
    };
  }, [document.owner_id, issues, projects.length, teamMembers]);

  // Transform to UnifiedDocument format
  const unifiedDocument: UnifiedDocument = useMemo(() => ({
    id: document.id,
    title: document.title,
    document_type: 'program',
    created_at: document.created_at,
    updated_at: document.updated_at,
    created_by: document.created_by as string | undefined,
    properties: document.properties as Record<string, unknown> | undefined,
    color: (document.color as string) || '#6366f1',
    emoji: (document.emoji as string) || null,
    owner_id: document.owner_id as string | undefined,
    // RACI fields
    accountable_id: document.accountable_id as string | undefined,
    consulted_ids: (document.consulted_ids as string[]) || [],
    informed_ids: (document.informed_ids as string[]) || [],
  }), [document]);

  if (!user) return null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <section
        aria-label="Program health summary"
        className="border-b border-border bg-background px-4 py-3"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <SummaryMetric label="Owner" value={programSummary.ownerName} muted={programSummary.ownerName === 'Unassigned'} />
          <SummaryMetric label="Health" value={programSummary.health} tone={programSummary.health === 'At risk' ? 'risk' : undefined} />
          <SummaryMetric label="Projects" value={String(programSummary.projectCount)} />
          <SummaryMetric label="Completion" value={`${programSummary.completionPercent}%`} detail={`${programSummary.completedIssues}/${programSummary.totalIssues} issues done`} />
          <SummaryMetric label="Open high priority" value={String(programSummary.highPriorityOpenIssues)} detail={`${programSummary.openIssues} open total`} tone={programSummary.highPriorityOpenIssues > 0 ? 'risk' : undefined} />
        </div>
      </section>
      <div className="min-h-0 flex-1">
        <UnifiedEditor
          document={unifiedDocument}
          sidebarData={sidebarData}
          onUpdate={handleUpdate}
          onBack={handleBack}
          backLabel="programs"
          onDelete={handleDelete}
          showTypeSelector={false}
        />
      </div>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  detail,
  tone,
  muted,
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'risk';
  muted?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-surface px-3 py-2">
      <div className="text-xs font-medium uppercase text-muted">{label}</div>
      <div className={cn(
        'mt-1 truncate text-sm font-semibold',
        tone === 'risk' ? 'text-amber-400' : muted ? 'text-muted' : 'text-foreground'
      )}>
        {value}
      </div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted">{detail}</div>}
    </div>
  );
}
