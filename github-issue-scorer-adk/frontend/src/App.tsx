import { useMemo, useState } from "react";
import { runTurn, type IssueCard as Card, type ScorerState } from "./agui";
import { IssueCard } from "./components/IssueCard";

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function rank(card: Card): number {
  if (card.status === "pending") return 3;
  return PRIORITY_RANK[card.priority ?? "low"] ?? 2;
}

export function App() {
  const [repo, setRepo] = useState("astropods/agents");
  const [state, setState] = useState<ScorerState>({ issues: {}, run: null });
  const [narration, setNarration] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");

  const cards = useMemo(() => {
    const list = Object.values(state.issues ?? {});
    // Priority bucket first, then Jev's continuous severity (descending) so
    // ordering within a bucket is no longer arbitrary. Cards Jev did not score
    // get -1 and sort last within their bucket; issue number is the final tiebreak.
    return list.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.severity ?? -1) - (a.severity ?? -1) ||
        a.number - b.number,
    );
  }, [state]);

  async function run() {
    if (!repo.trim() || running) return;
    setError("");
    setNarration("");
    setState({ issues: {}, run: null, plan: null });
    setRunning(true);
    await runTurn(`Score the open issues in ${repo.trim()}.`, {
      onState: setState,
      onNarration: setNarration,
      onFinished: () => setRunning(false),
      onError: (m) => {
        setError(m);
        setRunning(false);
      },
    });
  }

  async function plan() {
    if (running) return;
    setError("");
    setRunning(true);
    await runTurn(
      "Create an action plan for the issues you just scored.",
      {
        onState: setState,
        onNarration: setNarration,
        onFinished: () => setRunning(false),
        onError: (m) => {
          setError(m);
          setRunning(false);
        },
      },
    );
  }

  const run_ = state.run;
  const pct = run_ && run_.total ? Math.round((run_.done / run_.total) * 100) : 0;
  const scoredCount = cards.filter((c) => c.status === "scored").length;
  const canPlan = !running && run_?.status === "done" && scoredCount > 0;
  const planState = state.plan;

  return (
    <div className="app">
      <header className="app__header">
        <h1>🎯 GitHub Issue Scorer</h1>
        <p className="app__sub">
          Typed scoring by Jev, write-up by the LLM — streamed live via ADK +
          AG-UI, routed through the Fabric Gateway.
        </p>
        <div className="app__controls">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && run()}
            placeholder="owner/repo  ·  owner/repo 20  ·  owner/repo#123"
            spellCheck={false}
          />
          <button onClick={run} disabled={running}>
            {running ? "Working…" : "Score issues"}
          </button>
          <button className="btn-secondary" onClick={plan} disabled={!canPlan}>
            🧭 Plan top issues
          </button>
        </div>
      </header>

      {run_ && (
        <div className="progress">
          <div className="progress__bar" style={{ width: `${pct}%` }} />
          <span className="progress__label">
            {run_.repo} — {run_.done}/{run_.total} scored
          </span>
        </div>
      )}

      {narration && <p className="narration">{narration}</p>}
      {error && <p className="error">⚠️ {error}</p>}

      {planState && (
        <section className="plan">
          <h2 className="plan__title">
            🧭 Action plan{" "}
            <span className="plan__by">— via action-planner over A2A</span>
          </h2>
          {planState.status === "planning" && (
            <p className="plan__pending">Consulting the planner agent…</p>
          )}
          {planState.status === "error" && (
            <p className="error">⚠️ {planState.markdown}</p>
          )}
          {planState.status === "ready" && (
            <pre className="plan__body">{planState.markdown}</pre>
          )}
        </section>
      )}

      <div className="grid">
        {cards.map((c) => (
          <IssueCard key={c.number} card={c} />
        ))}
      </div>

      {!cards.length && !running && !error && (
        <p className="empty">Enter a repository and hit “Score issues”.</p>
      )}
    </div>
  );
}
