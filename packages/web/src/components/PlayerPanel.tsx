import type { JSX } from 'react';
import type { Color, PlayerSummary } from '@chess-analyzer/core';
import { ClassificationIcon } from '../icons';
import { CLASSIFICATION_LABELS, CLASSIFICATION_ORDER } from '../lib/classification';

export interface PlayerPanelProps {
  color: Color;
  username: string;
  rating: number | undefined;
  summary: PlayerSummary | undefined;
}

export function PlayerPanel({ color, username, rating, summary }: PlayerPanelProps): JSX.Element {
  return (
    <div className="card player-panel">
      <div className="name">
        <span className={`color-swatch ${color}`} />
        <span>{username}</span>
        {rating !== undefined && <span className="muted">({rating})</span>}
      </div>
      {summary === undefined ? (
        <div className="dim small">Not analysed</div>
      ) : (
        <>
          <div className="stats">
            <div className="stat">
              <span className="v">{summary.accuracy.toFixed(1)}</span>
              <span className="k">Accuracy</span>
            </div>
            <div className="stat">
              <span className="v">{Math.round(summary.estimatedRating)}</span>
              <span className="k">Est. rating</span>
            </div>
            <div className="stat">
              <span className="v">{rating ?? '—'}</span>
              <span className="k">Rating</span>
            </div>
            <div className="stat">
              <span className="v">{summary.averageCpLoss.toFixed(0)}</span>
              <span className="k">Avg cp loss</span>
            </div>
          </div>
          <div className="counts">
            {CLASSIFICATION_ORDER.map((c) => (
              <div className="count" key={c}>
                <ClassificationIcon classification={c} size={15} />
                <span>{CLASSIFICATION_LABELS[c]}</span>
                <span className="n">{summary.counts[c] ?? 0}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
