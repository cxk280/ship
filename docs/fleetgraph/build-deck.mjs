// FleetGraph — Architecture Defense deck generator.
// Run: node docs/fleetgraph/build-deck.mjs  -> FleetGraph-Architecture-Defense.pptx
import pptxgen from "pptxgenjs";

const C = {
  ink: "1A2330",
  dark: "1F3A5F",
  blue: "2E6FB7",
  teal: "2C8C99",
  amber: "C9892F",
  red: "C0492B",
  green: "2E7D5B",
  gray: "5B6675",
  faint: "EAEFF4",
  panel: "F4F6F8",
  white: "FFFFFF",
  line: "C4CDD6",
};
const FONT = "Arial";

const pptx = new pptxgen();
pptx.defineLayout({ name: "W", width: 10, height: 5.625 });
pptx.layout = "W";
pptx.author = "FleetGraph";
pptx.company = "Ship";
pptx.title = "FleetGraph — Architecture Defense";

// ---- master / helpers ---------------------------------------------------
pptx.defineSlideMaster({
  title: "BASE",
  background: { color: C.white },
  objects: [
    { rect: { x: 0, y: 0, w: 10, h: 0.06, fill: { color: C.blue } } },
    { rect: { x: 0, y: 5.4, w: 10, h: 0.225, fill: { color: C.dark } } },
    { text: { text: "FleetGraph · A Project Intelligence Agent for Ship", options: { x: 0.3, y: 5.4, w: 7.5, h: 0.225, fontFace: FONT, fontSize: 8, color: C.white, align: "left", valign: "middle" } } },
  ],
  slideNumber: { x: 9.2, y: 5.4, w: 0.6, h: 0.225, fontFace: FONT, fontSize: 8, color: C.white, align: "right" },
});

function slide() {
  return pptx.addSlide({ masterName: "BASE" });
}
function header(s, kicker, title) {
  s.addText(kicker.toUpperCase(), { x: 0.3, y: 0.18, w: 9.4, h: 0.3, fontFace: FONT, fontSize: 11, bold: true, color: C.blue, charSpacing: 2 });
  s.addText(title, { x: 0.3, y: 0.42, w: 9.4, h: 0.6, fontFace: FONT, fontSize: 24, bold: true, color: C.dark });
  s.addShape(pptx.ShapeType.line, { x: 0.32, y: 1.04, w: 1.1, h: 0, line: { color: C.amber, width: 2.5 } });
}
function bullets(s, items, opts = {}) {
  s.addText(
    items.map((it) => {
      if (typeof it === "string") return { text: it, options: { bullet: { code: "2022" }, color: C.ink, fontSize: 13, paraSpaceAfter: 7 } };
      return { text: it.t, options: { bullet: it.sub ? { indent: 18 } : { code: "2022" }, indentLevel: it.sub ? 1 : 0, bold: it.b || false, color: it.c || C.ink, fontSize: it.fs || 13, paraSpaceAfter: it.sub ? 4 : 7 } };
    }),
    { x: opts.x ?? 0.45, y: opts.y ?? 1.25, w: opts.w ?? 9.1, h: opts.h ?? 3.9, fontFace: FONT, valign: "top", lineSpacingMultiple: 1.02 }
  );
}
function box(s, x, y, w, h, text, fill, o = {}) {
  s.addShape(o.diamond ? pptx.ShapeType.diamond : pptx.ShapeType.roundRect, {
    x, y, w, h, rectRadius: 0.06,
    fill: { color: fill }, line: { color: o.lineColor || fill, width: 1 },
    shadow: { type: "outer", color: "9AA6B2", blur: 3, offset: 1, angle: 90, opacity: 0.35 },
  });
  s.addText(text, { x, y, w, h, align: "center", valign: "middle", fontFace: FONT, fontSize: o.fs || 9, bold: o.bold ?? true, color: o.tc || C.white, lineSpacingMultiple: 0.9 });
}
function arrow(s, x1, y1, x2, y2, o = {}) {
  s.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color: o.color || C.gray, width: o.width || 1.5, dashType: o.dash || "solid", endArrowType: "triangle", beginArrowType: o.both ? "triangle" : "none" } });
  if (o.label) s.addText(o.label, { x: o.lx ?? (Math.min(x1, x2) - 0.1), y: o.ly ?? ((y1 + y2) / 2 - 0.16), w: o.lw ?? 1.0, h: 0.3, align: o.la || "center", fontFace: FONT, fontSize: 7.5, italic: true, color: o.color || C.gray });
}
function legendDot(s, x, y, color, label) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w: 0.16, h: 0.16, rectRadius: 0.03, fill: { color } });
  s.addText(label, { x: x + 0.2, y: y - 0.05, w: 1.9, h: 0.26, fontFace: FONT, fontSize: 8, color: C.gray, valign: "middle" });
}

// =========================================================================
// 1 · TITLE
// =========================================================================
{
  const s = slide();
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 5.625, fill: { color: C.dark } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: 5.625, fill: { color: C.amber } });
  s.addText("FleetGraph", { x: 0.7, y: 1.55, w: 8.6, h: 1.0, fontFace: FONT, fontSize: 54, bold: true, color: C.white });
  s.addText("A Project Intelligence Agent for Ship", { x: 0.72, y: 2.55, w: 8.6, h: 0.5, fontFace: FONT, fontSize: 20, color: "B9CBE0" });
  s.addText("Ship shows you what's happening. FleetGraph tells you what's wrong — and what to do next.", { x: 0.72, y: 3.15, w: 8.4, h: 0.5, fontFace: FONT, fontSize: 13, italic: true, color: "8FA6C4" });
  s.addText("Architecture Defense  ·  Week 5", { x: 0.72, y: 4.55, w: 8, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.white });
  s.addNotes("FleetGraph is an agent layered on Ship. One graph, two modes: it pushes findings proactively and answers in-context on demand. Goal of this defense: justify the architecture, the trigger model, the autonomy boundary, and how we hit <5 min detection — while reusing Ship's existing primitives.");
}

// =========================================================================
// 2 · PROBLEM
// =========================================================================
{
  const s = slide();
  header(s, "The problem", "Dashboards are passive. Teams drift anyway.");
  bullets(s, [
    { t: "Projects drift silently between check-ins.", b: true, c: C.dark, fs: 14 },
    { t: "Issues sit stale in-progress for days; nobody is looking.", sub: true },
    { t: "Sprints slip while confidence still reads “green.”", sub: true },
    { t: "Standups go unlogged; blockers and overdue work pile up unseen.", sub: true },
    { t: "The people responsible are busy, context-switching, and not staring at a dashboard when it matters.", b: true, c: C.dark, fs: 14 },
    { t: "The fix isn't a better dashboard — it's an agent that watches the system for them and does something about it.", b: true, c: C.red, fs: 14 },
  ], { y: 1.3 });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.55, w: 9.1, h: 0.62, rectRadius: 0.08, fill: { color: C.faint }, line: { color: C.line, width: 1 } });
  s.addText([
    { text: "Design goal:  ", options: { bold: true, color: C.dark } },
    { text: "discover the problems a graph agent can solve that ", options: { color: C.ink } },
    { text: "nothing else can", options: { italic: true, color: C.red } },
    { text: " — and prove it on real Ship data.", options: { color: C.ink } },
  ], { x: 0.6, y: 4.55, w: 8.8, h: 0.62, valign: "middle", fontFace: FONT, fontSize: 12.5 });
  s.addNotes("Frame: the value isn't catching one bug, it's that the responsible humans are not watching. The agent watches, decides what's worth surfacing, and proposes the next action. We must also make the right next action obvious, not just flag problems.");
}

// =========================================================================
// 3 · WHAT FLEETGRAPH IS
// =========================================================================
{
  const s = slide();
  header(s, "What it is", "An agent that decides — not a bot that fetches");
  // two mode cards
  const cardY = 1.35, cardH = 2.55, cardW = 4.45;
  s.addShape(pptx.ShapeType.roundRect, { x: 0.4, y: cardY, w: cardW, h: cardH, rectRadius: 0.08, fill: { color: C.panel }, line: { color: C.blue, width: 1.5 } });
  s.addText("PROACTIVE  —  the agent pushes", { x: 0.6, y: cardY + 0.12, w: cardW - 0.4, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: C.blue });
  s.addText([
    { text: "Runs on its own — schedule + Ship events, no user present.", options: { bullet: { code: "2022" }, paraSpaceAfter: 6 } },
    { text: "Monitors project state, detects what's worth surfacing.", options: { bullet: { code: "2022" }, paraSpaceAfter: 6 } },
    { text: "Decides when to act and when to stay quiet.", options: { bullet: { code: "2022" }, paraSpaceAfter: 6 } },
    { text: "Delivers findings to the right people in-app.", options: { bullet: { code: "2022" } } },
  ], { x: 0.62, y: cardY + 0.55, w: cardW - 0.45, h: cardH - 0.7, fontFace: FONT, fontSize: 11.5, color: C.ink, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: 5.15, y: cardY, w: cardW, h: cardH, rectRadius: 0.08, fill: { color: C.panel }, line: { color: C.teal, width: 1.5 } });
  s.addText("ON-DEMAND  —  the user pulls", { x: 5.35, y: cardY + 0.12, w: cardW - 0.4, h: 0.35, fontFace: FONT, fontSize: 13, bold: true, color: C.teal });
  s.addText([
    { text: "Embedded chat, scoped to what you're looking at.", options: { bullet: { code: "2022" }, paraSpaceAfter: 6 } },
    { text: "A chat on an issue knows that issue; on a sprint, that sprint.", options: { bullet: { code: "2022" }, paraSpaceAfter: 6 } },
    { text: "Answers questions and proposes concrete actions.", options: { bullet: { code: "2022" }, paraSpaceAfter: 6 } },
    { text: "A power feature in context — not a standalone chatbot.", options: { bullet: { code: "2022" } } },
  ], { x: 5.37, y: cardY + 0.55, w: cardW - 0.45, h: cardH - 0.7, fontFace: FONT, fontSize: 11.5, color: C.ink, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: 0.4, y: 4.2, w: 9.2, h: 0.95, rectRadius: 0.08, fill: { color: C.dark } });
  s.addText([
    { text: "Both modes run through the SAME graph.  ", options: { bold: true, color: C.white, fontSize: 14 } },
    { text: "The difference is the trigger, not the graph.", options: { color: "B9CBE0", fontSize: 13, italic: true } },
  ], { x: 0.6, y: 4.2, w: 8.9, h: 0.95, valign: "middle", fontFace: FONT });
  s.addNotes("Key claim to defend: it makes decisions, not just data fetches; it knows when to act vs wait. And the two modes are one graph with two entry points — that's what keeps it coherent and is why a single set of traces covers both.");
}

// =========================================================================
// 4 · TWO MODES, ONE GRAPH (table)
// =========================================================================
{
  const s = slide();
  header(s, "Two modes, one graph", "Same nodes, different entry");
  const rows = [
    [
      { text: "", options: { fill: { color: C.dark } } },
      { text: "Proactive · mutation", options: { fill: { color: C.blue }, color: C.white, bold: true } },
      { text: "Proactive · cron sweep", options: { fill: { color: C.blue }, color: C.white, bold: true } },
      { text: "On-demand · chat", options: { fill: { color: C.teal }, color: C.white, bold: true } },
    ],
    ["Trigger", "Doc changed in Ship (debounced)", "Scheduled sweep", "User asks from a doc view"],
    ["Actor", "system (no user)", "system (no user)", "the asking user"],
    ["Scope", "the single changed doc", "active sprints / workspace", "useCurrentDocument() view"],
    ["Catches", "changes, fast (<1 min)", "absences: stale, overdue, missing", "any question + proposes action"],
    ["Ends at", "notify / HITL gate", "notify / HITL gate", "chat answer (+ optional HITL)"],
  ];
  const tbl = rows.map((r, ri) =>
    r.map((c, ci) => {
      const cell = typeof c === "string" ? { text: c } : c;
      const base = { fontFace: FONT, fontSize: 11, valign: "middle", margin: 4, border: { type: "solid", color: C.line, pt: 0.5 } };
      if (ri === 0) return { text: cell.text, options: { ...base, ...(cell.options || {}), align: "center" } };
      if (ci === 0) return { text: cell.text, options: { ...base, bold: true, color: C.dark, fill: { color: C.faint } } };
      return { text: cell.text, options: { ...base, color: C.ink, fill: { color: ri % 2 ? C.white : C.panel } } };
    })
  );
  s.addTable(tbl, { x: 0.4, y: 1.3, w: 9.2, colW: [1.3, 2.63, 2.63, 2.64], rowH: [0.5, 0.55, 0.45, 0.55, 0.6, 0.55] });
  s.addText("One graph definition; the entry router reads `mode` and picks the lane. One set of LangSmith traces covers everything.", { x: 0.4, y: 4.85, w: 9.2, h: 0.4, fontFace: FONT, fontSize: 11, italic: true, color: C.gray });
  s.addNotes("If asked 'why not two agents': shared fetch + reasoning means one place to maintain detectors, one tool layer, one trace project. The only branch is at entry and at the autonomy gate.");
}

// =========================================================================
// 5 · THE GRAPH (native diagram)
// =========================================================================
{
  const s = slide();
  header(s, "The graph", "Context → parallel fetch → detect → reason → act");
  const BW = 1.5, BH = 0.5;
  const col = (i) => 0.28 + i * 1.62;
  const rA = 1.2, rB = 2.35, rC = 3.5, rD = 4.5;

  // Row A backbone
  box(s, col(0), rA, BW, BH, "Trigger\nmutation · cron · chat", C.gray, { fs: 8 });
  box(s, col(1), rA, BW, BH, "entryRouter\n{ mode }", C.dark, { diamond: false, fs: 8.5 });
  box(s, col(2), rA, BW, BH + 0.18, "Parallel Fetch ×7\nread-only REST / MCP", C.teal, { fs: 8 });
  box(s, col(3), rA, BW, BH, "detectSignals\nrules — no LLM", C.blue, { fs: 8.5 });
  box(s, col(4), rA, BW, BH, "dedupFilter\n{ novel? }", C.blue, { fs: 8.5 });
  box(s, col(5), rA - 0.02, BW, BH, "END · quiet\nno LLM call", C.green, { fs: 8 });

  arrow(s, col(0) + BW, rA + BH / 2, col(1), rA + BH / 2);
  arrow(s, col(1) + BW, rA + BH / 2, col(2), rA + BH / 2);
  arrow(s, col(2) + BW, rA + BH / 2, col(3), rA + BH / 2);
  arrow(s, col(3) + BW, rA + BH / 2, col(4), rA + BH / 2);
  arrow(s, col(4) + BW, rA + BH / 2, col(5), rA + BH / 2, { color: C.green, label: "novel=0", ly: rA + BH / 2 - 0.32, lw: 0.9, lx: col(4) + BW - 0.05 });

  // ondemand entry note from router downward to fetch (shares fetch)
  arrow(s, col(1) + BW / 2, rA + BH, col(2) + BW / 2, rB, { dash: "dash", color: C.teal, label: "ondemand", lx: col(1) + 0.05, ly: rB - 0.45, la: "left" });

  // Row B: triage -> reason -> classify (right to left under the backbone)
  box(s, col(4), rB, BW, BH, "triageSignals\nHaiku (T1) · batched", C.amber, { fs: 8 });
  box(s, col(3), rB, BW, BH, "reasonAndDraft\nOpus (T2)", C.amber, { fs: 8.5 });
  box(s, col(2), rB, BW, BH, "answerQuestion\nOpus (T2) · chat", C.teal, { fs: 8 });

  arrow(s, col(4) + BW / 2, rA + BH, col(4) + BW / 2, rB, { color: C.red, label: "novel>0", lx: col(4) + BW / 2 + 0.08, ly: rA + BH + 0.05, la: "left", lw: 1 });
  arrow(s, col(4), rB + BH / 2, col(3) + BW, rB + BH / 2); // triage -> reason
  // classify on row C left
  box(s, col(3), rC, BW, BH, "classifyActions\n{ autonomy }", C.dark, { fs: 8.5 });
  arrow(s, col(3) + BW / 2, rB + BH, col(3) + BW / 2, rC); // reason -> classify
  // answer -> respond / classify
  box(s, col(1), rC, BW, BH, "respond\nchat answer", C.teal, { fs: 8.5 });
  arrow(s, col(2) + BW / 2, rB + BH, col(1) + BW / 2, rC, { color: C.teal, label: "read-only", lx: col(1) + 0.0, ly: rC - 0.3, la: "center", lw: 1.1 });
  arrow(s, col(2) + BW / 2, rB + BH, col(3) + BW / 2, rC, { color: C.teal, dash: "dash", label: "proposes write", lx: col(2) + 0.55, ly: rC - 0.18, la: "left", lw: 1.4 });

  // Row C/D: auto + HITL
  box(s, col(4), rC, BW, BH, "applyAutonomous\ncomment · flag", C.green, { fs: 8 });
  arrow(s, col(3) + BW, rC + BH / 2, col(4), rC + BH / 2, { color: C.green, label: "all auto", ly: rC + BH / 2 - 0.3, lw: 0.9, lx: col(3) + BW - 0.05 });
  box(s, col(5), rC, BW, BH, "notify\nbroadcastToUser", C.green, { fs: 8 });
  arrow(s, col(4) + BW, rC + BH / 2, col(5), rC + BH / 2);

  box(s, col(3), rD, BW, BH, "humanGate · INTERRUPT\nPostgresSaver", C.red, { fs: 7.6 });
  arrow(s, col(3) + BW / 2, rC + BH, col(3) + BW / 2, rD, { color: C.red, label: "any hitl", lx: col(3) + BW / 2 + 0.06, ly: rC + BH + 0.0, la: "left", lw: 0.9 });
  box(s, col(4), rD, BW, BH, "executeApproved\nPATCH issue/doc", C.red, { fs: 8 });
  arrow(s, col(3) + BW, rD + BH / 2, col(4), rD + BH / 2, { color: C.red, label: "approve", ly: rD + BH / 2 - 0.3, lw: 0.9, lx: col(3) + BW - 0.05 });
  arrow(s, col(4) + BW, rD + BH / 2, col(5) + BW / 2, rC + BH, { color: C.red }); // execute -> notify
  s.addText("dismiss → suppress\nsnooze → re-surface later", { x: col(5) - 0.18, y: rD + 0.02, w: 1.9, h: 0.5, fontFace: FONT, fontSize: 7.5, italic: true, color: C.red, valign: "top" });

  // legend
  const ly = 5.14;
  legendDot(s, 0.35, ly, C.teal, "fetch / chat");
  legendDot(s, 2.05, ly, C.blue, "deterministic");
  legendDot(s, 3.75, ly, C.amber, "LLM (tiered)");
  legendDot(s, 5.55, ly, C.red, "HITL / write");
  legendDot(s, 7.35, ly, C.green, "auto / output");
  s.addNotes("Walk it: router splits proactive vs ondemand; both fan out into 7 parallel read-only fetches. Detection is pure rules (cheap). dedupFilter is the cost gate — most proactive runs end here with zero LLM. Survivors go Haiku triage -> Opus draft. classifyActions stamps auto vs hitl. Auto = post comment + notify. HITL = interrupt, persisted in Postgres, resumes on approve/dismiss/snooze. On-demand enters at the router, shares fetch, ends at a chat answer or routes a proposed write through the SAME gate.");
}

// =========================================================================
// 6 · DIFFERENT PATHS (not a pipeline)
// =========================================================================
{
  const s = slide();
  header(s, "A graph, not a pipeline", "Different conditions → different traces");
  const data = [
    ["#", "Condition", "Path through the graph", "LLM"],
    ["1", "Nothing new (dedup hit)", "router → fetch → detect → dedup → END", "none"],
    ["2", "Low-stakes finding", "… triage → reason → applyAutonomous → notify", "T1+T2"],
    ["3", "High-stakes action", "… classify → humanGate INTERRUPT → approve → PATCH", "T1+T2"],
    ["4", "On-demand question", "router → resolveContext → fetch → answer → respond", "T2"],
    ["5", "On-demand action", "… answer → classify → humanGate → execute", "T2"],
  ];
  const tbl = data.map((r, ri) =>
    r.map((c, ci) => {
      const base = { fontFace: FONT, fontSize: 11, valign: "middle", margin: 4, border: { type: "solid", color: C.line, pt: 0.5 } };
      if (ri === 0) return { text: c, options: { ...base, bold: true, color: C.white, fill: { color: C.dark }, align: ci === 0 ? "center" : "left" } };
      return { text: c, options: { ...base, color: C.ink, fill: { color: ri % 2 ? C.white : C.panel }, align: ci === 0 ? "center" : "left", bold: ci === 0 } };
    })
  );
  s.addTable(tbl, { x: 0.4, y: 1.3, w: 9.2, colW: [0.5, 2.6, 5.05, 1.05], rowH: 0.55 });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.4, y: 4.7, w: 9.2, h: 0.55, rectRadius: 0.08, fill: { color: C.faint }, line: { color: C.line, width: 1 } });
  s.addText([
    { text: "LangSmith from day one.  ", options: { bold: true, color: C.dark } },
    { text: "Five visibly different execution shapes prove branching — we submit ≥2 trace links per deliverable.", options: { color: C.ink } },
  ], { x: 0.6, y: 4.7, w: 8.9, h: 0.55, valign: "middle", fontFace: FONT, fontSize: 11.5 });
  s.addNotes("The grader checks that the graph branches. Path 1 (quiet) vs Path 3 (HITL) are the cleanest contrast: one has zero LLM nodes, the other pauses mid-run. That's the evidence it's a graph, not a fixed pipeline.");
}

// =========================================================================
// 7 · TRIGGER MODEL
// =========================================================================
{
  const s = slide();
  header(s, "Trigger model", "Hybrid: event-hook + cron sweep");
  bullets(s, [
    { t: "Real-time (mutation): an in-process event fires in Ship's PATCH post-commit hook, debounced ~30–60s, enqueued in the same process — no broker.", b: true, c: C.dark, fs: 12.5 },
    { t: "Fetch (narrow, parallel) ≈0.5–2s  ·  Haiku triage ≈1–3s  ·  Opus draft ≈3–8s  ·  notify ≈instant  →  end-to-end ≪ 1 min.", sub: true },
    { t: "Scheduled (cron sweep) every 5 min: catches absences no mutation fires for — stale, overdue, missing standups, sprint slip.", b: true, c: C.dark, fs: 12.5 },
    { t: "For those classes the interval IS the latency → 5 min honors the SLA.", sub: true },
    { t: "Why hybrid: webhook-only misses “nothing happened”; poll-only wastes runs and couples latency to the interval. Hybrid gets sub-minute on changes and bounded latency on absences.", b: true, c: C.red, fs: 12.5 },
    { t: "Scale guard: pg_try_advisory_lock so the sweep fires once across a multi-instance EB fleet.", sub: true },
  ], { y: 1.25 });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.62, w: 9.1, h: 0.55, rectRadius: 0.08, fill: { color: C.dark } });
  s.addText([
    { text: "Detection latency target  ", options: { color: "B9CBE0" } },
    { text: "< 5 min", options: { bold: true, color: C.white } },
    { text: "   —  mutation path lands well inside it; cron covers the rest.", options: { color: "B9CBE0" } },
  ], { x: 0.6, y: 4.62, w: 8.9, h: 0.55, valign: "middle", fontFace: FONT, fontSize: 12 });
  s.addNotes("Defensible, not 'correct'. The timed test introduces an event and starts a clock — mutation path answers that in under a minute. Cron is the safety net and the only way to catch the absence-class conditions. Advisory lock is the answer to 'what about horizontal scaling'.");
}

// =========================================================================
// 8 · HITL + AUTONOMY BOUNDARY
// =========================================================================
{
  const s = slide();
  header(s, "Human-in-the-loop", "Free to inform; must ask to mutate");
  // two columns
  s.addShape(pptx.ShapeType.roundRect, { x: 0.4, y: 1.3, w: 4.5, h: 2.5, rectRadius: 0.08, fill: { color: C.panel }, line: { color: C.green, width: 1.5 } });
  s.addText("AUTONOMOUS  (reversible)", { x: 0.58, y: 1.4, w: 4.2, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.green });
  s.addText([
    { text: "Post a comment / finding", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Create an in-app notification", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Raise a flag / badge", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Write an audit-trail history row", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Ask a clarifying question in chat", options: { bullet: { code: "2022" } } },
  ], { x: 0.6, y: 1.8, w: 4.2, h: 1.9, fontFace: FONT, fontSize: 11.5, color: C.ink, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: 5.1, y: 1.3, w: 4.5, h: 2.5, rectRadius: 0.08, fill: { color: C.panel }, line: { color: C.red, width: 1.5 } });
  s.addText("ALWAYS CONFIRM  (system of record)", { x: 5.28, y: 1.4, w: 4.2, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.red });
  s.addText([
    { text: "Change issue state / priority / assignee / estimate / due date", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Edit a plan, retro, or its approval", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Change sprint confidence / project ICE / owner", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Anything that notifies another human (reassign, escalate to reports_to)", options: { bullet: { code: "2022" } } },
  ], { x: 5.3, y: 1.8, w: 4.2, h: 1.9, fontFace: FONT, fontSize: 11.5, color: C.ink, valign: "top" });

  s.addText([
    { text: "Gate:  ", options: { bold: true, color: C.dark } },
    { text: "LangGraph interrupt() + a Postgres checkpointer (survives EB deploy/scale). Approve → PATCH (stamped automated_by=‘fleetgraph’).  Dismiss → suppress.  Snooze → re-surface later.", options: { color: C.ink } },
  ], { x: 0.45, y: 3.95, w: 9.1, h: 0.65, fontFace: FONT, fontSize: 11.5, valign: "top" });
  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.62, w: 9.1, h: 0.55, rectRadius: 0.08, fill: { color: C.faint }, line: { color: C.line, width: 1 } });
  s.addText([
    { text: "Defense-in-depth:  ", options: { bold: true, color: C.dark } },
    { text: "even a prompt-injected agent can't exceed Ship's Zod-validated write surface — and every write is audit-stamped for instant rollback.", options: { color: C.ink } },
  ], { x: 0.6, y: 4.62, w: 8.9, h: 0.55, valign: "middle", fontFace: FONT, fontSize: 11 });
  s.addNotes("The line: produce information freely (additive, reversible); ask before mutating the state humans are accountable for. The API only allows five issue fields anyway, so the boundary is enforced in depth, not just in the prompt.");
}

// =========================================================================
// 9 · EMBEDDED CONTEXT-AWARE CHAT
// =========================================================================
{
  const s = slide();
  header(s, "On-demand", "Embedded chat, scoped to the view");
  bullets(s, [
    { t: "Lives inside the document editor — not a standalone chatbot page (a hard constraint).", b: true, c: C.dark, fs: 13 },
    { t: "Reads useCurrentDocument() → the open doc's id, type, and project become the chat's starting context automatically.", sub: true },
    { t: "Chat on an issue knows that issue; on a sprint, that sprint. No “which issue do you mean?”", sub: true },
    { t: "Same fetch + reasoning nodes as proactive mode — it can answer (“Is this sprint on track? Who's overloaded?”) and propose a fix.", b: true, c: C.dark, fs: 13 },
    { t: "Proposed writes route through the same HITL gate.", sub: true },
    { t: "Delivery is in-app: a notification bell + inbox and toasts, reusing Ship's existing /events WebSocket + toast system.", b: true, c: C.dark, fs: 13 },
    { t: "New event types fleetgraph:finding / fleetgraph:interrupt ride the channel that already exists.", sub: true },
  ], { y: 1.25 });
  s.addNotes("Why embedded matters for grading: 'a chat window on an issue should know about that issue.' We get that for free from the existing CurrentDocument context. It should feel like a power feature, not the primary interaction.");
}

// =========================================================================
// 10 · DEPLOYMENT & STACK
// =========================================================================
{
  const s = slide();
  header(s, "Deployment & stack", "Reuse Ship's primitives; add little");
  s.addText("REUSED (already in Ship, in prod)", { x: 0.45, y: 1.25, w: 4.5, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.green });
  s.addText([
    { text: "AWS Bedrock → Claude Opus 4.5 + Haiku (IAM role, no new key)", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "broadcastToUser() + /events WebSocket + toast", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Deterministic detectors (accountability.ts pattern)", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Every REST route → MCP tool via OpenAPI", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Bearer token auth (no user session) for proactive runs", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "document_history.automated_by audit trail", options: { bullet: { code: "2022" } } },
  ], { x: 0.5, y: 1.6, w: 4.45, h: 3.0, fontFace: FONT, fontSize: 11, color: C.ink, valign: "top" });

  s.addText("NET-NEW (kept minimal)", { x: 5.15, y: 1.25, w: 4.5, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.blue });
  s.addText([
    { text: "The LangGraph.js graph (runs inside the EB API)", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Postgres checkpointer (HITL survives deploy/scale)", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "One fleetgraph_findings table (dedup + lifecycle)", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Debounced run queue + node-cron sweep (advisory lock)", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "2 WS event types + chat/inbox/resume endpoints", options: { bullet: { code: "2022" }, paraSpaceAfter: 5 } },
    { text: "Embedded ChatPanel + notification bell/inbox UI", options: { bullet: { code: "2022" } } },
  ], { x: 5.2, y: 1.6, w: 4.45, h: 3.0, fontFace: FONT, fontSize: 11, color: C.ink, valign: "top" });

  s.addShape(pptx.ShapeType.roundRect, { x: 0.45, y: 4.62, w: 9.1, h: 0.55, rectRadius: 0.08, fill: { color: C.dark } });
  s.addText([
    { text: "No new service, no new secret store, no Python.  ", options: { bold: true, color: C.white } },
    { text: "LangSmith tracing on from day one; Bedrock token usage feeds cost reporting.", options: { color: "B9CBE0" } },
  ], { x: 0.6, y: 4.62, w: 8.9, h: 0.55, valign: "middle", fontFace: FONT, fontSize: 11.5 });
  s.addNotes("Authentication with no user present: Bearer service token. Where it runs: same EB process as the API, so it inherits the IAM role for Bedrock and the DB pool. The only real infra decision we defend is the Postgres checkpointer over MemorySaver — required because EB is multi-instance and ephemeral.");
}

// =========================================================================
// 11 · COST & LATENCY
// =========================================================================
{
  const s = slide();
  header(s, "Cost & latency", "Most runs cost nothing");
  const data = [
    ["Path", "Tier-1", "Tier-2", "Note"],
    ["Quiet (dedup short-circuit)", "0", "0", "dominant case — pure SQL/REST"],
    ["Autonomous finding", "~1–3k", "~2–5k", "one batched triage + one draft"],
    ["HITL", "~1–3k", "~3–6k", "resume adds 0 model tokens"],
    ["On-demand answer", "0", "~3–9k", "user-initiated, latency-tolerant"],
  ];
  const tbl = data.map((r, ri) =>
    r.map((c, ci) => {
      const base = { fontFace: FONT, fontSize: 11, valign: "middle", margin: 4, border: { type: "solid", color: C.line, pt: 0.5 } };
      if (ri === 0) return { text: c, options: { ...base, bold: true, color: C.white, fill: { color: C.dark }, align: ci === 0 ? "left" : "center" } };
      return { text: c, options: { ...base, color: C.ink, fill: { color: ri % 2 ? C.white : C.panel }, align: ci === 0 ? "left" : "center", bold: ci === 0 } };
    })
  );
  s.addTable(tbl, { x: 0.4, y: 1.25, w: 9.2, colW: [3.3, 1.2, 1.4, 3.3], rowH: 0.5 });
  s.addText("Cost cliffs — and how the graph defends them", { x: 0.45, y: 3.95, w: 9, h: 0.3, fontFace: FONT, fontSize: 12, bold: true, color: C.dark });
  bullets(s, [
    { t: "Dedup before any LLM call — known conditions never re-reason (the big lever).", sub: true },
    { t: "Batch triage on the cheap tier; the expensive tier only sees triage survivors.", sub: true },
    { t: "Scope fetches to active sprints; cache within a run — no fan-out explosion.", sub: true },
  ], { y: 4.25, h: 1.0 });
  s.addNotes("Headline: the dominant proactive run is the quiet path at zero tokens, because dedup short-circuits before the LLM. Tiering keeps the high-volume classification on Haiku. Full dev-spend numbers and 100/1k/10k projections land in the Cost Analysis section by final submission.");
}

// =========================================================================
// 12 · ROADMAP
// =========================================================================
{
  const s = slide();
  header(s, "Roadmap", "Four deadlines");
  const data = [
    ["Checkpoint", "Lands"],
    ["Architecture Defense  (now)", "This deck: agent scope, graph, trigger model, autonomy boundary, deployment"],
    ["MVP  (Tue)", "Graph live + ≥1 proactive detection e2e on real data; ≥2 LangSmith traces (diff paths); HITL gate; chat + notifications in UI; deployed; FLEETGRAPH.md (Responsibility, Diagram, ≥5 Use Cases, Trigger)"],
    ["Early  (Thu)", "Test Cases + Architecture Decisions sections; broader detectors; on-demand action path"],
    ["Final  (Sun noon)", "Cost Analysis (dev spend + 100/1k/10k projections); PRESEARCH.md; polish"],
  ];
  const tbl = data.map((r, ri) =>
    r.map((c, ci) => {
      const base = { fontFace: FONT, fontSize: 10.5, valign: "middle", margin: 4, border: { type: "solid", color: C.line, pt: 0.5 } };
      if (ri === 0) return { text: c, options: { ...base, bold: true, color: C.white, fill: { color: C.dark } } };
      return { text: c, options: { ...base, color: C.ink, fill: { color: ri % 2 ? C.white : C.panel }, bold: ci === 0, align: "left" } };
    })
  );
  s.addTable(tbl, { x: 0.4, y: 1.3, w: 9.2, colW: [2.4, 6.8], rowH: [0.4, 0.55, 1.15, 0.6, 0.6] });
  s.addText([
    { text: "Thesis:  ", options: { bold: true, color: C.dark } },
    { text: "an agent that watches Ship, decides what's worth a human's attention, and makes the next action obvious — built by reusing what Ship already has.", options: { italic: true, color: C.ink } },
  ], { x: 0.4, y: 4.75, w: 9.2, h: 0.5, fontFace: FONT, fontSize: 11.5, valign: "middle" });
  s.addNotes("Close on the thesis. We're not bolting on a chatbot; we're adding judgment to a system that already has the data and the plumbing.");
}

const out = "FleetGraph-Architecture-Defense.pptx";
await pptx.writeFile({ fileName: new URL(out, import.meta.url).pathname });
console.log("wrote", out);
