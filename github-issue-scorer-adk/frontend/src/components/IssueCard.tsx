import type { IssueCard as Card } from "../agui";

const SENTIMENT_EMOJI: Record<string, string> = {
  frustration: "😠",
  urgency: "⏰",
  neutral: "😐",
  positive: "🙂",
};

// Below this, an answer is worth a human look rather than silent trust — the
// whole point of a calibrated confidence.
const LOW_CONFIDENCE = 0.6;

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Distribution rows, most likely first, hiding anything that rounds to zero. */
function rows(
  probs: Record<string, number> | undefined,
  label: (key: string) => string,
): string[] {
  if (!probs) return [];
  return Object.entries(probs)
    .filter(([, v]) => v >= 0.005)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${pct(v)}  ${label(k)}`);
}

/**
 * Tooltips use a styled `data-tip` rather than the native `title` attribute:
 * `title` is slow to appear, unstyleable, and easy to miss entirely.
 */
function Confidence({
  value,
  probs,
}: {
  value?: number;
  probs?: Record<string, number>;
}) {
  if (typeof value !== "number") return null;
  const low = value < LOW_CONFIDENCE;
  const tip = [
    low
      ? `Jev confidence ${pct(value)} — low, worth checking by hand`
      : `Jev confidence ${pct(value)}`,
    ...rows(probs, (k) => k),
  ].join("\n");
  return (
    <span className={`conf tip ${low ? "conf--low" : ""}`} data-tip={tip}>
      {pct(value)}
    </span>
  );
}

function Severity({ card }: { card: Card }) {
  const { severity, severity_legend: legend, severity_probabilities } = card;
  if (typeof severity !== "number") return null;
  // Levels come from Jev's own legend, so the meter matches the rubric the
  // model actually scored against rather than a hardcoded guess.
  const levels = legend ? Object.keys(legend).length : 3;
  const tip = [
    `Impact ${severity.toFixed(1)} of ${levels - 1}`,
    ...rows(severity_probabilities, (k) => legend?.[k] ?? `level ${k}`),
  ].join("\n");
  return (
    <span
      className="sev tip"
      data-tip={tip}
      aria-label={`Impact ${severity.toFixed(1)} of ${levels - 1}`}
    >
      {Array.from({ length: levels }, (_, i) => (
        <i key={i} className={severity >= i ? "sev__on" : undefined} />
      ))}
    </span>
  );
}

export function IssueCard({ card }: { card: Card }) {
  const pending = card.status === "pending";
  // Jev spotted something the write-up did not pull out. Say so rather than
  // showing nothing — it tells a human which threads are worth reading.
  const missedWorkaround = !card.workarounds?.length && card.workaround_signal;
  const missedCompetitor =
    !card.competitive_mentions?.length && card.competitor_signal;
  // The rubric level the score rounds to. Shown as text, not hidden behind a
  // hover, because it is the one thing that explains the impact number.
  const impact =
    typeof card.severity === "number"
      ? card.severity_legend?.[String(Math.round(card.severity))]
      : undefined;

  return (
    <div className={`card ${pending ? "card--pending" : ""} pri-${card.priority ?? "none"}`}>
      <div className="card__top">
        <span className="card__badges">
          <span className={`badge badge--${card.priority ?? "none"}`}>
            {pending ? "scoring…" : (card.priority ?? "—")}
          </span>
          <Confidence
            value={card.priority_confidence}
            probs={card.priority_probabilities}
          />
        </span>
        <span className="card__badges">
          <Severity card={card} />
          <a className="card__num" href={card.url} target="_blank" rel="noreferrer">
            #{card.number}
          </a>
        </span>
      </div>

      <h3 className="card__title">{card.title}</h3>

      {pending ? (
        <div className="card__skeleton">
          <span className="shimmer" />
          <span className="shimmer" />
        </div>
      ) : (
        <>
          <p className="card__summary">{card.summary}</p>
          {card.priority_reason && (
            <p className="card__reason">
              <strong>Why {card.priority}:</strong> {card.priority_reason}
            </p>
          )}
          {impact && (
            <p className="card__reason">
              <strong>Impact:</strong> {impact}
            </p>
          )}
          <div className="card__chips">
            {card.sentiment && (
              <span className={`chip chip--${card.sentiment}`}>
                {SENTIMENT_EMOJI[card.sentiment] ?? ""} {card.sentiment}
                <Confidence
                  value={card.sentiment_confidence}
                  probs={card.sentiment_probabilities}
                />
              </span>
            )}
            <span className="chip chip--muted">👍 {card.upvotes}</span>
            <span className="chip chip--muted">💬 {card.comments}</span>
          </div>
          {card.sentiment_details && (
            <p className="card__meta">{card.sentiment_details}</p>
          )}
          {card.competitive_mentions && card.competitive_mentions.length > 0 && (
            <p className="card__meta">
              <strong>Competitors:</strong> {card.competitive_mentions.join(", ")}
            </p>
          )}
          {card.workarounds && card.workarounds.length > 0 && (
            <p className="card__meta">
              <strong>Workarounds:</strong> {card.workarounds.join("; ")}
            </p>
          )}
          {missedCompetitor && (
            <p className="card__meta card__meta--hint">
              Jev detected a competitor comparison the write-up didn’t extract.
            </p>
          )}
          {missedWorkaround && (
            <p className="card__meta card__meta--hint">
              Jev detected a workaround the write-up didn’t extract.
            </p>
          )}
        </>
      )}
    </div>
  );
}
