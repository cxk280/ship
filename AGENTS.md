# Agent Instructions

## Pull Request Reviews

When acting as the Codex reviewer on a GitHub pull request:

- Prioritize correctness, security, regressions, and missing tests.
- If you request changes, clearly list the blocking findings in the review.
- If you do not request changes, do not trigger Cursor.
- If you request changes, submit a formal GitHub "Request changes" review.
- If you request changes, the repository workflow will notify Cursor with:

```text
@cursor fix the Codex review comments
```

After Cursor pushes fixes to the pull request branch, the repository workflow will request another Codex review.
