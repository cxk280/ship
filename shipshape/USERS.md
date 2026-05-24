# ShipShape User Personas

Purpose: this file defines realistic user personas for future user-acceptance testing of Ship. These personas are intended to surface product, workflow, accessibility, reliability, and UX problems as real users would encounter them.

## Testing Rules

- Do not start UAT from this document yet. This document only sets up the future persona pool and testing rules.
- Human personas make up most of this list. Any persona who is human MUST interact with the application through the browser.
- Human personas must enter and use the app like a real end user would: log in through the UI, navigate through visible controls, read what is on screen, create/edit/search/filter content through the browser, and use keyboard/mouse/touch interactions as appropriate.
- Human personas must not use direct database access, API clients, browser devtools shortcuts, local storage edits, test fixtures, scripts, or code changes to bypass the browser experience.
- Human personas do not make fixes. They only produce a list of complaints, confusion points, bugs, accessibility blockers, performance issues, missing affordances, and workflow failures.
- Fixes are made only in the main implementation thread.
- Every fix made in response to persona UAT must be documented in the implementation log (`shipshape/FIXES_IMPLEMENTATION.md`).
- After fixes are made, the same persona must be re-run against the same scenario until that persona has no remaining complaints for that scenario.
- Persona runs should preserve real-world friction. Do not guide the persona around known bugs, skip hard steps, pre-create hidden state, or tell the persona which UI element to click unless the product itself would make that clear.
- Each persona complaint should include enough detail to reproduce it: persona name, scenario, browser/viewport, exact page or flow, observed result, expected result, severity, and whether it blocks task completion.

## Human Personas

### 1. Program Executive Sponsor

- Role: senior leader responsible for several active programs.
- Goals: understand program health, risk, accountability, and whether work is on track.
- Typical flows: dashboard review, program page review, project drill-down, weekly review scan, unresolved blocker review.
- Technical comfort: low to moderate.
- Device/browser: managed Windows laptop, Chrome or Edge, 1440px desktop viewport.
- UAT focus: whether high-level status, risk, owners, and next actions are obvious without learning the underlying document model.

### 2. Portfolio Operations Lead

- Role: coordinates delivery across many programs and teams.
- Goals: compare program status, spot stale updates, follow dependencies, prepare leadership briefings.
- Typical flows: search across projects, filter issue lists, open linked documents, inspect weekly plans, export or copy summary text.
- Technical comfort: moderate.
- Device/browser: desktop browser with many tabs open.
- UAT focus: information density, navigation consistency, cross-link clarity, and whether status data can be trusted at a glance.

### 3. Project Manager

- Role: manages a project with tasks, risks, milestones, and recurring status updates.
- Goals: create issues, assign owners, maintain project documentation, track sprint/week progress.
- Typical flows: create project, add issues, link issues to project/sprint, update status, prepare weekly review.
- Technical comfort: moderate.
- Device/browser: Chrome on laptop.
- UAT focus: create/edit flows, forms, validation messages, association pickers, status transitions, and save confidence.

### 4. Scrum Master

- Role: facilitates team planning, standups, retrospectives, and sprint hygiene.
- Goals: make sprint status visible, remove blockers, keep issue states accurate.
- Typical flows: sprint board/list, standup notes, weekly plan, retro, issue reassignment, blocker tagging.
- Technical comfort: moderate to high.
- Device/browser: desktop browser during meetings.
- UAT focus: repeated workflow speed, keyboard efficiency, meeting-time editing, stale data, and collaboration conflicts.

### 5. Product Owner

- Role: prioritizes work and clarifies requirements.
- Goals: maintain backlog quality, connect requirements to outcomes, review completed work.
- Typical flows: backlog triage, issue detail editing, acceptance criteria updates, document linking, search for similar work.
- Technical comfort: moderate.
- Device/browser: Chrome on laptop.
- UAT focus: issue fields, priority/status clarity, rich text editing, comments, and discoverability of linked context.

### 6. Software Engineer

- Role: implements assigned work and updates technical notes.
- Goals: find assigned issues, understand requirements, update progress, document decisions.
- Typical flows: issue search, assigned-to-me list, document editor, comment thread, status changes.
- Technical comfort: high.
- Device/browser: Chrome/Firefox on large monitor.
- UAT focus: fast navigation, reliable editor behavior, linkability, markdown/rich text expectations, and precision of error states.

### 7. Technical Lead

- Role: coordinates implementation details and reviews technical plans.
- Goals: inspect cross-project dependencies, manage technical risks, ensure decisions are recorded.
- Typical flows: project docs, architecture notes, related issues, search, document history, comments.
- Technical comfort: high.
- Device/browser: desktop browser.
- UAT focus: relationship modeling, historical traceability, stale or conflicting data, and whether the app supports technical oversight.

### 8. QA Analyst

- Role: validates completed work and files defects.
- Goals: understand what changed, reproduce defects, track acceptance criteria and bug status.
- Typical flows: create issue, attach details, search existing bugs, filter by status/owner, update verification notes.
- Technical comfort: moderate to high.
- Device/browser: Chrome and Firefox; sometimes narrow split-screen view.
- UAT focus: defect creation clarity, duplicate prevention, filters, attachments, field validation, and reproducible bug notes.

### 9. Accessibility Tester

- Role: evaluates whether the product works for users with assistive technology.
- Goals: navigate by keyboard, use screen reader semantics, verify focus order, check contrast and form labels.
- Typical flows: login, search, create/edit issue, open document editor, use modal dialogs, change filters.
- Technical comfort: high with accessibility tools.
- Device/browser: Windows with Edge/Chrome and screen reader; also keyboard-only testing.
- UAT focus: WCAG 2.1 AA issues, focus traps, missing labels, inaccessible custom controls, ambiguous link/button text, and keyboard blockers.

### 10. Keyboard-Only Power User

- Role: operations analyst who avoids mouse use for speed and ergonomics.
- Goals: complete common workflows entirely from the keyboard.
- Typical flows: login, navigate issue list, open details, edit fields, save changes, search, close dialogs.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: tab order, visible focus, skip paths, keyboard shortcuts if present, modal escape behavior, and unexpected focus loss.

### 11. Screen Magnification User

- Role: staff member with low vision using browser zoom and OS magnification.
- Goals: read and update work without hidden or clipped controls.
- Typical flows: dashboard review, issue detail edit, document reading, filters.
- Technical comfort: moderate.
- Device/browser: Edge at 200% browser zoom on laptop.
- UAT focus: responsive layout, clipped text, overlapping controls, scroll behavior, contrast, and whether critical actions remain visible.

### 12. Color-Blind User

- Role: project contributor who cannot rely on color-coded status alone.
- Goals: distinguish priority, status, due dates, and risk without guessing.
- Typical flows: issue list, status badges, dashboards, progress indicators, filters.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: non-color indicators, labels, contrast, icons, chart readability, and status ambiguity.

### 13. New Team Member

- Role: recently joined contributor learning Ship and the project.
- Goals: find onboarding material, understand current priorities, locate assigned work.
- Typical flows: login, workspace landing page, search docs, open project/program, find assigned issues.
- Technical comfort: moderate.
- Device/browser: Chrome on laptop.
- UAT focus: first-run clarity, navigation labels, empty states, page titles, breadcrumbs, and whether app concepts explain themselves through use.

### 14. Occasional Contributor

- Role: subject-matter expert who uses Ship a few times per month.
- Goals: respond to requests, edit a document, comment on an issue, find a past decision.
- Typical flows: email/deep link entry, login, open linked item, comment, edit small text section.
- Technical comfort: low to moderate.
- Device/browser: managed browser, possibly expired session.
- UAT focus: session recovery, deep links, low-frequency discoverability, save confidence, and clear permission messages.

### 15. Executive Assistant

- Role: prepares status packets and keeps leaders informed.
- Goals: gather project updates quickly and accurately.
- Typical flows: search, dashboard scan, copy summaries, open weekly reviews, identify owners and dates.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: readable summaries, copy/paste quality, date clarity, owner visibility, and navigation between many related pages.

### 16. Compliance Officer

- Role: reviews records, auditability, permissions, and process adherence.
- Goals: confirm actions are traceable and sensitive information is handled correctly.
- Typical flows: inspect document history, review comments, verify membership/roles, search archived items.
- Technical comfort: moderate.
- Device/browser: managed desktop browser.
- UAT focus: audit trails, role visibility, permission boundaries, archived/deleted states, and ambiguous access errors.

### 17. Workspace Administrator

- Role: manages workspace users, roles, and operational settings.
- Goals: add/remove members, assign permissions, troubleshoot access, maintain workspace hygiene.
- Typical flows: admin pages, member search, role changes, workspace switching, token/session review if exposed.
- Technical comfort: high.
- Device/browser: desktop browser.
- UAT focus: admin affordances, destructive-action confirmation, permission clarity, success/failure feedback, and role edge cases.

### 18. Help Desk Support Specialist

- Role: supports users who report access or workflow problems.
- Goals: reproduce user problems and identify whether they are permissions, data, or UX issues.
- Typical flows: impersonation if available, workspace switching, search, user/member lookup, error reproduction.
- Technical comfort: high.
- Device/browser: Chrome/Edge.
- UAT focus: diagnosable error states, support-friendly identifiers, reproducibility, and avoiding vague "something went wrong" messages.

### 19. Data Steward

- Role: responsible for clean metadata, consistent naming, and reusable project structure.
- Goals: find duplicates, normalize titles, ensure associations are correct, archive stale content.
- Typical flows: search, filter, bulk-like repeated edits if available, rename documents, update relationships.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: duplicate detection, editing friction, association clarity, archive/delete semantics, and stale references.

### 20. Meeting Facilitator

- Role: uses Ship live while running planning or review meetings.
- Goals: update notes, assign follow-ups, capture decisions, keep participants aligned.
- Typical flows: collaborative document editing, issue creation during meeting, status update, link sharing.
- Technical comfort: moderate.
- Device/browser: projected desktop browser and laptop.
- UAT focus: real-time editing reliability, latency, autosave visibility, focus behavior while presenting, and avoiding accidental destructive edits.

### 21. Remote Collaborator

- Role: contributor joining from a slower network or VPN.
- Goals: read and update issues/docs despite latency.
- Typical flows: login, open documents, edit text, change issue status, search.
- Technical comfort: moderate.
- Device/browser: Chrome over VPN.
- UAT focus: loading states, retry behavior, offline/poor-network feedback, duplicate submissions, and delayed save states.

### 22. Mobile Reviewer

- Role: leader or contributor checking status away from desk.
- Goals: read updates, comment, maybe change a status from phone.
- Typical flows: mobile login, dashboard/project scan, open issue, add comment.
- Technical comfort: moderate.
- Device/browser: iPhone Safari or Android Chrome.
- UAT focus: responsive layout, tap targets, mobile nav, sticky controls, editor usability, and whether critical content is hidden.

### 23. Tablet Meeting User

- Role: manager using a tablet during meetings.
- Goals: review and lightly update project status.
- Typical flows: open dashboard, navigate project, edit simple fields, comment.
- Technical comfort: moderate.
- Device/browser: iPad Safari or Chrome tablet viewport.
- UAT focus: touch interactions, responsive breakpoints, virtual keyboard behavior, popovers, and scroll containment.

### 24. Security Reviewer

- Role: evaluates whether sensitive workflows expose risky behavior.
- Goals: verify authentication, session timeout messaging, CSRF-sensitive flows, permission failures, and token surfaces.
- Typical flows: login/logout, expired session, role-restricted pages, state-changing forms.
- Technical comfort: high.
- Device/browser: browser-only for human UAT, using visible app behavior rather than direct API probing.
- UAT focus: user-visible security failures, confusing auth redirects, stale sessions, insufficient confirmation, and data exposure in the UI.

### 25. Records Manager

- Role: ensures documents can be retained, found, and interpreted later.
- Goals: locate historical documents, understand authorship and dates, distinguish active from archived material.
- Typical flows: search, archived/deleted views if exposed, document history, project hierarchy review.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: timestamps, authorship, archive labels, stable links, search accuracy, and historical context.

### 26. Cross-Team Dependency Owner

- Role: tracks dependencies between teams and projects.
- Goals: identify blocked work, owners, related projects, and due dates.
- Typical flows: issue filters, project associations, dependency notes, dashboards, weekly reviews.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: relationship visibility, navigation between linked records, owner clarity, blocker states, and cross-workspace confusion.

### 27. Finance/Budget Stakeholder

- Role: monitors delivery progress related to funding commitments.
- Goals: understand whether projects are on schedule and where risk exists.
- Typical flows: dashboard, program/project pages, status notes, risk/blocker summaries.
- Technical comfort: low to moderate.
- Device/browser: desktop browser.
- UAT focus: plain-language status, date clarity, lack of jargon, print/copy usefulness, and avoiding hidden critical context.

### 28. Legal/Policy Reviewer

- Role: reviews policy-sensitive documents and implementation plans.
- Goals: comment on documents, trace decisions, verify final wording.
- Typical flows: document editor, comments, search, document history, linked issue review.
- Technical comfort: moderate.
- Device/browser: managed desktop browser.
- UAT focus: editor reliability, version confidence, comment discoverability, accidental edit prevention, and readable history.

### 29. Public Feedback Triage User

- Role: receives or reviews public/user feedback if the product exposes feedback flows.
- Goals: classify feedback, link it to internal work, create follow-up issues.
- Typical flows: feedback list, issue creation from feedback, search duplicates, status updates.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: feedback-to-issue handoff, field mapping clarity, privacy warnings, and duplicate management.

### 30. Super Admin

- Role: highly privileged operator with cross-workspace responsibilities.
- Goals: manage system-level access and diagnose workspace-level problems.
- Typical flows: admin navigation, workspace switching, user lookup, role management, high-privilege settings.
- Technical comfort: high.
- Device/browser: desktop browser.
- UAT focus: privilege boundaries, clear workspace context, irreversible-action safeguards, and visibility into admin outcomes.

### 31. Government User On Managed Device

- Role: typical agency staff member using locked-down hardware and browser policies.
- Goals: complete normal work despite pop-up restrictions, strict cookies, and limited extensions.
- Typical flows: login, document editing, search, issue updates, file attachment if supported.
- Technical comfort: moderate.
- Device/browser: managed Windows laptop, Edge, possible restrictive policies.
- UAT focus: auth compatibility, cookie/session behavior, download/upload affordances, and reliance on blocked browser features.

### 32. High-Volume Triage Coordinator

- Role: processes many issues quickly during an operational push.
- Goals: sort, filter, assign, update, and close many items without losing place.
- Typical flows: issue list filters, pagination/infinite scroll, detail open/close, rapid status changes.
- Technical comfort: high.
- Device/browser: large monitor desktop browser.
- UAT focus: list performance, preserving filters and scroll position, batch friction, stale list state, and accidental duplicate actions.

### 33. Documentation Maintainer

- Role: keeps project and program docs accurate.
- Goals: edit rich documents, organize pages, link related records, maintain consistent structure.
- Typical flows: create document, edit content, add headings/lists/links, link issues/projects, search docs.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: rich text editor expectations, autosave, collaboration, link creation, formatting persistence, and document hierarchy.

### 34. Stakeholder With Read-Only Permissions

- Role: needs visibility but should not be able to modify content.
- Goals: read updates, search, follow links, understand status.
- Typical flows: dashboard, program/project pages, issue details, document viewing.
- Technical comfort: low to moderate.
- Device/browser: desktop browser.
- UAT focus: read-only affordances, disabled edit controls, permission messages, accidental edit prevention, and no hidden dead ends.

### 35. User With Expired Session

- Role: any returning user whose session timed out.
- Goals: resume work without losing context.
- Typical flows: leave app idle, return to edit, save/comment/change status, re-authenticate.
- Technical comfort: varies.
- Device/browser: desktop browser.
- UAT focus: timeout messaging, preserving unsaved work, re-login redirect, duplicate submissions, and clarity about whether changes saved.

### 36. User Entering From Deep Link

- Role: receives a link to a specific issue or document.
- Goals: authenticate and land on the intended item.
- Typical flows: open direct URL, login if needed, read or comment on linked item.
- Technical comfort: low to moderate.
- Device/browser: desktop or mobile browser.
- UAT focus: deep-link preservation, permission failures, loading states, missing item handling, and breadcrumbs after landing.

### 37. User Creating Bad or Incomplete Data

- Role: realistic hurried user who mistypes, omits fields, or enters long content.
- Goals: complete task despite mistakes.
- Typical flows: create issue with missing title, paste long text, select invalid date, submit forms repeatedly.
- Technical comfort: low to moderate.
- Device/browser: desktop browser.
- UAT focus: validation quality, inline errors, length handling, disabled submit states, duplicate prevention, and recovery without data loss.

### 38. User Switching Workspaces

- Role: member of multiple workspaces.
- Goals: work in the correct workspace without mixing data.
- Typical flows: switch workspace, search, create issue, open recent documents, return to previous workspace.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: workspace context visibility, data isolation, recent-item correctness, stale cache, and accidental cross-workspace creation.

### 39. User Reviewing Accountability

- Role: manager focused on follow-through and commitments.
- Goals: see who owns what, what changed, and what remains blocked.
- Typical flows: accountability dashboard, weekly plans/reviews, issue owners, comments, project status.
- Technical comfort: moderate.
- Device/browser: desktop browser.
- UAT focus: owner clarity, due dates, unresolved commitments, status history, and whether accountability language is actionable.

### 40. Non-Technical Business Owner

- Role: business stakeholder accountable for outcomes, not implementation details.
- Goals: understand whether Ship reflects real progress and what needs a decision.
- Typical flows: project page, weekly review, dashboard, issue summary, comments.
- Technical comfort: low.
- Device/browser: desktop browser.
- UAT focus: plain-language labels, minimal cognitive load, clear next actions, and avoiding implementation jargon in primary workflows.

## Non-Human or Tool-Assisted Personas

These personas may support later testing, but they do not replace human browser UAT. They can help identify technical issues, but any end-user complaint they raise should be validated through a human browser persona before being considered resolved.

### 41. Automated Accessibility Scanner

- Type: tool-assisted persona.
- Goals: detect WCAG violations using tools such as axe or Lighthouse.
- UAT focus: missing labels, color contrast, ARIA misuse, heading order, focusable hidden elements.
- Constraint: scanner findings must be verified in the browser experience before fixes are closed.

### 42. Automated Performance Observer

- Type: tool-assisted persona.
- Goals: measure page load, interaction delay, long tasks, bundle impact, and network waterfall behavior.
- UAT focus: slow initial load, blocking JavaScript, slow route changes, expensive filters, delayed editor startup.
- Constraint: metrics should be tied back to a real user workflow.

### 43. API Contract Sentinel

- Type: tool-assisted persona.
- Goals: detect server/client contract mismatches that become visible as UI defects.
- UAT focus: malformed API responses, missing fields, inconsistent status codes, error-shape drift.
- Constraint: does not file final UX complaints unless a browser user can experience the failure.

### 44. Cross-Browser Smoke Runner

- Type: automated browser persona.
- Goals: repeat essential flows in Chromium, Firefox, and WebKit.
- UAT focus: rendering differences, editor compatibility, focus behavior, responsive regressions.
- Constraint: should use the browser UI, not direct API setup, except for controlled test data seeding when explicitly allowed by the main thread.

### 45. Regression Re-Runner

- Type: automated or semi-automated persona.
- Goals: rerun a previously complaining persona's exact scenario after fixes.
- UAT focus: confirming that each documented complaint is resolved and no new complaint appears in the same flow.
- Constraint: must preserve the same persona, scenario, viewport, and browser assumptions used when the complaint was first recorded.

## Complaint Format For Future UAT

Use this format when a persona reports issues:

```markdown
## Persona Complaint Report

- Persona:
- Scenario:
- Date:
- Browser and viewport:
- Starting URL:
- Steps taken:
- Expected result:
- Observed result:
- Severity: Blocker | High | Medium | Low
- Complaint:
- Evidence:
- Re-run required after fix: Yes
```

