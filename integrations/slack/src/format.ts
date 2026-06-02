/**
 * Format Ship webhook events as Slack messages.
 * Returns a Slack message payload (compatible with Incoming Webhooks API).
 */

export interface ShipEvent {
  type: string;
  data: Record<string, unknown>;
  created: number;
}

export interface SlackMessage {
  text: string;
  blocks?: unknown[];
}

export function formatEvent(event: ShipEvent): SlackMessage {
  switch (event.type) {
    case 'document.created': {
      const title = (event.data.title as string | undefined) ?? 'Untitled';
      const id = (event.data.id as string | undefined) ?? '?';
      const docType = (event.data.document_type as string | undefined) ?? 'document';
      return {
        text: `New ${docType} created: *${title}* (\`${id}\`)`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:memo: New *${docType}* created: *${title}*\n\`id: ${id}\``,
            },
          },
        ],
      };
    }

    case 'issue.assigned': {
      const title = (event.data.title as string | undefined) ?? 'Untitled';
      const assignee = (event.data.assignee_name as string | undefined) ??
        (event.data.assignee_id as string | undefined) ?? 'someone';
      const id = (event.data.id as string | undefined) ?? '?';
      return {
        text: `Issue assigned: *${title}* → ${assignee}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:ticket: Issue *${title}* assigned to *${assignee}*\n\`id: ${id}\``,
            },
          },
        ],
      };
    }

    default:
      return {
        text: `Ship event: \`${event.type}\``,
      };
  }
}
