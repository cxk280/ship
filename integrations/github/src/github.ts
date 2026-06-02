/**
 * Minimal GitHub REST client (via fetch — no Octokit dependency).
 *
 * Only the few endpoints the bridge needs:
 *   - list/search issues (to find an existing mirror by its embedded marker)
 *   - create an issue
 *   - update an issue (title/body/state)
 *
 * Plus the marker helpers that make the Ship → GitHub mirror idempotent.
 */

/** Embedded marker linking a GitHub issue back to a Ship issue. */
export function shipMarker(shipIssueId: string): string {
  return `<!-- ship:issue:${shipIssueId} -->`;
}

/** Extract a Ship issue id from text containing a marker, or null. */
export function parseShipMarker(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.match(/<!--\s*ship:issue:([^\s>]+)\s*-->/);
  return m ? m[1]! : null;
}

/**
 * Parse a "Closes ship#<id>" / "Fixes ship#<id>" / "ship#<id>" reference from
 * PR/issue text. Returns the first referenced Ship issue id, or null.
 * Accepts the issue id directly after `ship#` (uuid or short id).
 */
export function parseShipReference(text: string | null | undefined): string | null {
  if (!text) return null;
  // Marker wins if present (most reliable).
  const marker = parseShipMarker(text);
  if (marker) return marker;
  const m = text.match(/\bship#([A-Za-z0-9-]+)/);
  return m ? m[1]! : null;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  html_url: string;
}

export interface GitHubClientOptions {
  token: string;
  /** "owner/repo". */
  repo: string;
  apiBase?: string;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class GitHubClient {
  private readonly token: string;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GitHubClientOptions) {
    const [owner, repo] = opts.repo.split('/');
    if (!owner || !repo) {
      throw new Error(`GITHUB_REPO must be "owner/repo", got "${opts.repo}"`);
    }
    this.token = opts.token;
    this.owner = owner;
    this.repo = repo;
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ship-github-bridge',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${method} ${path} failed: HTTP ${res.status} — ${text}`);
    }
    return (await res.json()) as T;
  }

  /**
   * Find an existing mirror issue for a Ship issue id by searching for its marker.
   * Uses the search API (scoped to this repo). Returns null if none found.
   */
  async findIssueByShipId(shipIssueId: string): Promise<GitHubIssue | null> {
    const marker = shipMarker(shipIssueId);
    const q = encodeURIComponent(`repo:${this.owner}/${this.repo} in:body "${marker}"`);
    const result = await this.request<{ items: GitHubIssue[] }>(
      'GET',
      `/search/issues?q=${q}`,
    );
    // Search can be eventually-consistent; double-check the marker is in the body.
    return result.items.find((i) => parseShipMarker(i.body) === shipIssueId) ?? null;
  }

  async createIssue(input: { title: string; body: string }): Promise<GitHubIssue> {
    return this.request<GitHubIssue>('POST', `/repos/${this.owner}/${this.repo}/issues`, {
      title: input.title,
      body: input.body,
    });
  }

  async updateIssue(
    number: number,
    patch: Partial<{ title: string; body: string; state: 'open' | 'closed' }>,
  ): Promise<GitHubIssue> {
    return this.request<GitHubIssue>(
      'PATCH',
      `/repos/${this.owner}/${this.repo}/issues/${number}`,
      patch,
    );
  }
}
