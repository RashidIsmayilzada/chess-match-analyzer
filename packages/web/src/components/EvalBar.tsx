import type { JSX } from 'react';
import type { Color, EngineScore } from '@chess-analyzer/core';
import { formatBarLabel, whiteBarPercent } from '../lib/eval';

export interface EvalBarProps {
  /** White-POV score of the shown position. */
  score: EngineScore | undefined;
  orientation: Color;
}

/** Vertical evaluation bar; white's share grows from the bottom when white is at the bottom. */
export function EvalBar({ score, orientation }: EvalBarProps): JSX.Element {
  const whitePct = score === undefined ? 50 : whiteBarPercent(score);
  const blackPct = 100 - whitePct;
  const label = score === undefined ? '' : formatBarLabel(score);
  const whiteAhead = score !== undefined && score.value >= 0;
  // When white is at the bottom, black's part sits on top.
  const flipped = orientation === 'b';
  const topPct = flipped ? whitePct : blackPct;
  const topClass = flipped ? 'white' : 'black';
  const bottomClass = flipped ? 'black' : 'white';
  // Put the label inside the bigger side so it stays readable.
  const labelOnTop = flipped ? whiteAhead : !whiteAhead;
  return (
    <div className="eval-bar" title={score === undefined ? 'No evaluation' : `Eval ${label}`}>
      <div className={topClass} style={{ height: `${topPct}%` }} />
      <div className={bottomClass} />
      {label !== '' && (
        <span
          className={`label ${labelOnTop ? 'top' : 'bottom'}`}
          style={{ color: (labelOnTop ? topClass : bottomClass) === 'white' ? '#1f1d1b' : '#f0ede8' }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
