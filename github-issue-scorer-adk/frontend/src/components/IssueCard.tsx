import type { IssueCard as Card } from "../agui";

const SENTIMENT_EMOJI: Record<string, string> = {
  frustration: "😠",
  urgency: "⏰",
  neutral: "😐",
  positive: "🙂",
};

export function IssueCard({ card }: { card: Card }) {
  const pending = card.status === "pending";
  return (
    <div className={`card ${pending ? "card--pending" : ""} pri-${card.priority ?? "none"}`}>
      <div className="card__top">
        <span className={`badge badge--${card.priority ?? "none"}`}>
          {pending ? "scoring…" : (card.priority ?? "—")}
        </span>
        <a className="card__num" href={card.url} target="_blank" rel="noreferrer">
          #{card.number}
        </a>
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
        </>
      )}
    </div>
  );
}
