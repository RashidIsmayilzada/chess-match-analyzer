import { useEffect, useRef, type JSX } from 'react';
import { Chessground } from '@lichess-org/chessground';
import type { Api } from '@lichess-org/chessground/api';
import type { Config } from '@lichess-org/chessground/config';
import type { DrawBrushes, DrawShape } from '@lichess-org/chessground/draw';
import type { Color as CgColor, Key } from '@lichess-org/chessground/types';
import type { Classification, Color } from '@chess-analyzer/core';
import { CLASSIFICATION_COLORS } from '../lib/classification';
import { isCheck, turnFromFen } from '../lib/chess';

export interface BoardArrow {
  from: Key;
  to: Key;
  /** Brush name: a classification, or one of the default chessground colours. */
  brush: Classification | 'green' | 'red' | 'blue' | 'yellow';
}

export interface BoardProps {
  fen: string;
  orientation: Color;
  lastMove?: [Key, Key] | undefined;
  arrows?: BoardArrow[];
  /** Show check highlight when the side to move is in check (default true). */
  showCheck?: boolean;
  coordinates?: boolean;
}

function buildBrushes(): DrawBrushes {
  const brushes: DrawBrushes = {
    green: { key: 'green', color: '#15781B', opacity: 1, lineWidth: 10 },
    red: { key: 'red', color: '#882020', opacity: 1, lineWidth: 10 },
    blue: { key: 'blue', color: '#003088', opacity: 1, lineWidth: 10 },
    yellow: { key: 'yellow', color: '#e68f00', opacity: 1, lineWidth: 10 },
  };
  for (const [name, color] of Object.entries(CLASSIFICATION_COLORS)) {
    brushes[name] = { key: name, color, opacity: 0.9, lineWidth: 10 };
  }
  return brushes;
}

const BRUSHES = buildBrushes();

function toCgColor(c: Color): CgColor {
  return c === 'w' ? 'white' : 'black';
}

function shapesFromArrows(arrows: BoardArrow[] | undefined): DrawShape[] {
  if (arrows === undefined) return [];
  return arrows.map((a) => ({ orig: a.from, dest: a.to, brush: a.brush }));
}

/** Read-only chessground board that mirrors its props. */
export function Board({
  fen,
  orientation,
  lastMove,
  arrows,
  showCheck = true,
  coordinates = true,
}: BoardProps): JSX.Element {
  const elRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

  // Create / destroy the chessground instance with the element.
  useEffect(() => {
    const el = elRef.current;
    if (el === null) return;
    const config: Config = {
      fen,
      orientation: toCgColor(orientation),
      turnColor: toCgColor(turnFromFen(fen)),
      coordinates,
      viewOnly: true,
      disableContextMenu: true,
      animation: { enabled: true, duration: 180 },
      highlight: { lastMove: true, check: true },
      movable: { free: false, color: undefined, showDests: false },
      draggable: { enabled: false },
      selectable: { enabled: false },
      premovable: { enabled: false },
      drawable: {
        enabled: false,
        visible: true,
        brushes: BRUSHES,
        autoShapes: shapesFromArrows(arrows),
      },
    };
    if (lastMove !== undefined) config.lastMove = lastMove;
    if (showCheck && isCheck(fen)) config.check = true;
    const api = Chessground(el, config);
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
    // Only the mount/unmount lifecycle lives here; updates go through api.set below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Position, orientation and highlights.
  useEffect(() => {
    const api = apiRef.current;
    if (api === null) return;
    const turn = turnFromFen(fen);
    api.set({
      fen,
      orientation: toCgColor(orientation),
      turnColor: toCgColor(turn),
      lastMove: lastMove ?? [],
      check: showCheck && isCheck(fen) ? true : false,
      coordinates,
    });
  }, [fen, orientation, lastMove, showCheck, coordinates]);

  // Arrows.
  useEffect(() => {
    const api = apiRef.current;
    if (api === null) return;
    api.setAutoShapes(shapesFromArrows(arrows));
  }, [arrows]);

  return <div ref={elRef} className="board" />;
}
