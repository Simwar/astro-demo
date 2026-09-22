// Thin wrapper around @ag-ui/client's HttpAgent for the scorer dashboard.
//
// The backend streams the scored issues into AG-UI shared state (STATE_SNAPSHOT
// + STATE_DELTA); the client merges deltas into `agent.state` automatically and
// fires onStateChanged after each merge. We render from that. Assistant
// narration arrives as TEXT_MESSAGE_CONTENT.
import { HttpAgent } from "@ag-ui/client";

export interface IssueCard {
  number: number;
  title: string;
  url: string;
  status: "pending" | "scored";
  upvotes: number;
  total_reactions: number;
  comments: number;
  summary?: string;
  sentiment?: "frustration" | "urgency" | "neutral" | "positive";
  sentiment_details?: string;
  competitive_mentions?: string[];
  workarounds?: string[];
  priority?: "high" | "medium" | "low";
  priority_reason?: string;
}

export interface RunState {
  total: number;
  done: number;
  repo: string;
  status: "scoring" | "done";
}

export interface PlanState {
  status: "planning" | "ready" | "error";
  markdown: string;
}

export interface ScorerState {
  issues: Record<string, IssueCard>;
  run: RunState | null;
  plan?: PlanState | null;
}

export interface RunCallbacks {
  onState: (state: ScorerState) => void;
  onNarration: (text: string) => void;
  onFinished: () => void;
  onError: (message: string) => void;
}

// Same-origin in production (FastAPI serves the SPA); dev uses the Vite proxy.
const agent = new HttpAgent({
  url: "/agui",
  initialState: { issues: {}, run: null, plan: null } satisfies ScorerState,
});

// Send a user message on the shared thread and stream the turn. Used for both
// scoring and (as a follow-up on the same thread) requesting an action plan —
// the server keeps the scored issues in session state across turns.
export async function runTurn(prompt: string, cb: RunCallbacks): Promise<void> {
  agent.messages.push({
    id: crypto.randomUUID(),
    role: "user",
    content: prompt,
  });

  try {
    await agent.runAgent(
      { runId: crypto.randomUUID() },
      {
        // Initial full state (skeleton cards).
        onStateSnapshotEvent: ({ event }: any) => cb.onState(event.snapshot),
        // Fires after each JSON-Patch delta is merged into agent.state.
        onStateChanged: ({ state }: any) => cb.onState(state),
        // Streaming assistant narration.
        onTextMessageContentEvent: ({ textMessageBuffer }: any) =>
          cb.onNarration(textMessageBuffer),
        onRunFinishedEvent: () => cb.onFinished(),
        onRunErrorEvent: ({ event }: any) =>
          cb.onError(event?.message || "Run failed"),
      } as any,
    );
  } catch (err) {
    cb.onError(err instanceof Error ? err.message : String(err));
  }
}
