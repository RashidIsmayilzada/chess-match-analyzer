import type { JSX } from 'react';
import type { MoveAnalysis } from '@chess-analyzer/core';
import { ClassificationIcon } from '../icons';
import { CLASSIFICATION_LABELS } from '../lib/classification';
import { formatScore } from '../lib/eval';
import { plyLabel } from '../lib/chess';

export interface KeyMomentsProps {
  moves: MoveAnalysis[];
  keyMoments: number[];
  onSelectPly: (ply: number) => void;
}

export function KeyMoments({ moves, keyMoments, onSelectPly }: KeyMomentsProps): JSX.Element {
  const byPly = new Map(moves.map((m) => [m.ply, m]));
  const items = keyMoments
    .map((ply) => byPly.get(ply))
    .filter((m): m is MoveAnalysis => m !== undefined);

  if (items.length === 0) return <div className="dim small">No key moments</div>;

  return (
    <div className="key-moments">
      {items.map((m) => {
        const swing = Math.abs(m.winProbBefore - m.winProbAfter) * 100;
        return (
          <div className="key-moment" key={m.ply} onClick={() => onSelectPly(m.ply)} role="button">
            <span className="ply">{plyLabel(m.ply)}</span>
            <span className="san">{m.san}</span>
            <ClassificationIcon classification={m.classification} size={15} />
            <span className="muted small">{CLASSIFICATION_LABELS[m.classification]}</span>
            <span className="swing mono" title="Win-probability swing / eval after">
              {swing >= 1 ? `${swing.toFixed(0)}%` : ''} {formatScore(m.evalAfter)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
