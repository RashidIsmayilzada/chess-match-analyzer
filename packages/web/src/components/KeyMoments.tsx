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
  /** Ply offset of the game's start position (non-zero for PGNs starting from a FEN). */
  plyOffset?: number;
}

export function KeyMoments({ moves, keyMoments, onSelectPly, plyOffset = 0 }: KeyMomentsProps): JSX.Element {
  const byPly = new Map(moves.map((m) => [m.ply, m]));
  const items = keyMoments
    .map((ply) => byPly.get(ply))
    .filter((m): m is MoveAnalysis => m !== undefined);

  if (items.length === 0) return <div className="dim small">No key moments</div>;

  return (
    <div className="key-moments">
      {items.map((m) => {
        const swing = Math.abs(m.winProbBefore - m.winProbAfter) * 100;
        // After the move the opponent is to move (needed to read a delivered mate).
        const sideToMove = m.color === 'w' ? 'b' : 'w';
        return (
          <div className="key-moment" key={m.ply} onClick={() => onSelectPly(m.ply)} role="button">
            <span className="ply">{plyLabel(m.ply, plyOffset)}</span>
            <span className="san">{m.san}</span>
            <ClassificationIcon classification={m.classification} size={15} />
            <span className="muted small">{CLASSIFICATION_LABELS[m.classification]}</span>
            <span className="swing mono" title="Win-probability swing / eval after">
              {swing >= 1 ? `${swing.toFixed(0)}%` : ''} {formatScore(m.evalAfter, sideToMove)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
