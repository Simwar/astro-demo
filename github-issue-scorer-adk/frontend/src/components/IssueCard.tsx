import type { IssueCard as Card } from "../agui";

const SENTIMENT_EMOJI: Record<string, string> = {
  frustration: "😠",
  urgency: "⏰",
  neutral: "😐",
  positive: "🙂",
};

// The severity rubric has three ordered levels, so Jev's continuous score runs
// 0..2. Segment i lights up once the score reaches i.
const SEVERITY_LEVELS = 3;

// Below this, the answer is worth a human look rather than silent trust — the
// whole point of a calibrated confidence.
const LOW_CONFIDENCE = 0.6;

function Confidence({ value }: { value?: number }) {
  if (typeof value !== "number") return null;
  const pct = Math.round(value * 100);
  const low = value < LOW_CONFIDENCE;
  return (
    <span
      className={`conf ${low ? "conf--low" : ""}`}
      title={
        low
          ? `Jev confidence ${pct}% — low, worth checking by hand`
          : `Jev confidence ${pct}%`
      }
    >
      {pct}%
    </span>
  );
}

function Severity({ value }: { value?: number }) {
  if (typeof value !== "number") return null;
  return (
    <span
      className="sev"
      title={`Impact ${value.toFixed(1)} of ${SEVERITY_LEVELS - 1} — orders cards within a priority`}
      aria-label={`Impact ${value.toFixed(1)} of ${SEVERITY_LEVELS - 1}`}
    >
      {Array.from({ length: SEVERITY_LEVELS }, (_, i) => (
        <i key={i} className={value >= i ? "sev__on" : undefined} />
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

  return (
    <div className={`card ${pending ? "card--pending" : ""} pri-${card.priority ?? "none"}`}>
      <div className="card__top">
        <span className="card__badges">
          <span className={`badge badge--${card.priority ?? "none"}`}>
            {pending ? "scoring…" : (card.priority ?? "—")}
          </span>
          <Confidence value={card.priority_confidence} />
        </span>
        <span className="card__badges">
          <Severity value={card.severity} />
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
          <div className="card__chips">
            {card.sentiment && (
              <span className={`chip chip--${card.sentiment}`} title={card.sentiment_details}>
                {SENTIMENT_EMOJI[card.sentiment] ?? ""} {card.sentiment}
                {typeof card.sentiment_confidence === "number" && (
                  <Confidence value={card.sentiment_confidence} />
                )}
              </span>
            )}
            <span className="chip chip--muted">👍 {card.upvotes}</span>
            <span className="chip chip--muted">💬 {card.comments}</span>
          </div>
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
