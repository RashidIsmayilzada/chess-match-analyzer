import { useEffect, useRef, type JSX } from 'react';
import type { Classification } from '@chess-analyzer/core';
import { ClassificationIcon } from '../icons';
import { CLASSIFICATION_LABELS } from '../lib/classification';
import { isWhitePly, moveNumber } from '../lib/chess';

export interface MoveListItem {
  ply: number;
  san: string;
  classification?: Classification | undefined;
}

export interface MoveListProps {
  moves: MoveListItem[];
  currentPly: number;
  onSelectPly: (ply: number) => void;
  /** Ply offset of the game's start position (non-zero for PGNs starting from a FEN). */
  plyOffset?: number;
}

interface Row {
  number: number;
  white?: MoveListItem;
  black?: MoveListItem;
}

function buildRows(moves: MoveListItem[], plyOffset: number): Row[] {
  const rows: Row[] = [];
  for (const m of moves) {
    const number = moveNumber(m.ply, plyOffset);
    let row = rows[rows.length - 1];
    if (row === undefined || row.number !== number) {
      row = { number };
      rows.push(row);
    }
    if (isWhitePly(m.ply, plyOffset)) row.white = m;
    else row.black = m;
  }
  return rows;
}

function MoveCell({
  move,
  current,
  onSelect,
}: {
  move: MoveListItem | undefined;
  current: boolean;
  onSelect: (ply: number) => void;
}): JSX.Element {
  if (move === undefined) return <div className="move empty-cell" />;
  const cls = move.classification;
  return (
    <div
      className={`move${cls !== undefined ? ` c-${cls}` : ''}${current ? ' current' : ''}`}
      data-ply={move.ply}
      onClick={() => onSelect(move.ply)}
      role="button"
      tabIndex={-1}
      title={cls !== undefined ? CLASSIFICATION_LABELS[cls] : undefined}
    >
      {cls !== undefined && <ClassificationIcon classification={cls} size={16} />}
      <span className="san">{move.san}</span>
    </div>
  );
}

export function MoveList({ moves, currentPly, onSelectPly, plyOffset = 0 }: MoveListProps): JSX.Element {
  const rows = buildRows(moves, plyOffset);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const el = container.querySelector<HTMLElement>(`[data-ply="${currentPly}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [currentPly]);

  if (rows.length === 0) {
    return <div className="empty small">No moves</div>;
  }

  return (
    <div className="move-list" ref={containerRef}>
      {rows.map((row) => (
        <div className="row" key={row.number}>
          <div className="num">{row.number}.</div>
          <MoveCell move={row.white} current={row.white?.ply === currentPly} onSelect={onSelectPly} />
          <MoveCell move={row.black} current={row.black?.ply === currentPly} onSelect={onSelectPly} />
        </div>
      ))}
    </div>
  );
}
