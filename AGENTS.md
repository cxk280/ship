# Agent Instructions

## Agent-Authored Pull Requests

When an AI agent prepares changes:

- Push the changes to a branch.
- Open a pull request into `master` using the agent's GitHub identity or the available CLI identity.
- Do not use `github-actions[bot]` as the pull request author. The Codex review workflow submits reviews as `github-actions[bot]`, and GitHub does not allow pull request authors to approve their own pull requests.
- Keep the human owner's only required manual step as clicking the merge button after checks and Codex approval pass.

## Pull Request Reviews

When acting as the Codex reviewer on a GitHub pull request, including through the `Codex PR Review` workflow:

- Prioritize correctness, security, regressions, and missing tests.
- If you request changes, clearly list the blocking findings in the review.
- If you do not request changes, do not trigger Cursor.
- If you request changes, submit a formal GitHub "Request changes" review.
- If you request changes, the repository workflow will notify Cursor with:

```text
@cursor fix the Codex review comments
```

After Cursor pushes fixes to the pull request branch, the repository workflow will run another Codex review.
