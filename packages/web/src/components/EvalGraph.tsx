import { useMemo, type JSX } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  useYAxisScale,
  type TooltipContentProps,
} from 'recharts';
import type { Classification, Color, MoveAnalysis } from '@chess-analyzer/core';
import { ClassificationIcon } from '../icons';
import { CLASSIFICATION_COLORS, CLASSIFICATION_LABELS } from '../lib/classification';
import { formatScore, GRAPH_CLAMP, scoreToPawns } from '../lib/eval';
import { plyLabel } from '../lib/chess';

export interface EvalGraphProps {
  moves: MoveAnalysis[];
  keyMoments: number[];
  currentPly: number;
  onSelectPly: (ply: number) => void;
  /** Ply offset of the game's start position (non-zero for PGNs starting from a FEN). */
  plyOffset?: number;
}

interface GraphPoint {
  ply: number;
  eval: number;
  san?: string;
  classification?: Classification;
  scoreText: string;
  key: boolean;
}

interface DotRenderProps {
  cx?: number;
  cy?: number;
  payload?: GraphPoint;
  index?: number;
}

function other(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function KeyMomentDot(props: DotRenderProps): JSX.Element | null {
  const { cx, cy, payload } = props;
  if (cx === undefined || cy === undefined || payload === undefined || !payload.key) return null;
  const c = payload.classification;
  const fill = c === undefined ? '#e8e6e3' : CLASSIFICATION_COLORS[c];
  return (
    <circle
      key={`km-${payload.ply}`}
      cx={cx}
      cy={cy}
      r={4.5}
      fill={fill}
      stroke="#1f1d1b"
      strokeWidth={1.5}
      style={{ pointerEvents: 'none' }}
    />
  );
}

const FILL_GRADIENT_ID = 'evalFill';

/**
 * White-above / black-below fill for the eval area, split exactly at eval 0. The gradient is
 * defined in user space between the pixel rows of +GRAPH_CLAMP and -GRAPH_CLAMP (taken from the
 * Y axis scale), so the colour boundary is the zero line regardless of the data's range. With an
 * object-bounding-box gradient the 50% stop would sit in the middle of the area's own bounding
 * box, which only coincides with y=0 when the game reaches +GRAPH_CLAMP.
 */
function EvalFillGradient(): JSX.Element {
  const scale = useYAxisScale();
  const top = scale?.(GRAPH_CLAMP);
  const bottom = scale?.(-GRAPH_CLAMP);
  const zero = scale?.(0);
  const ready = top !== undefined && bottom !== undefined && zero !== undefined && bottom !== top;
  const y1 = ready ? top : 0;
  const y2 = ready ? bottom : 1;
  const split = ready ? ((zero - top) / (bottom - top)) * 100 : 50;
  return (
    <defs>
      <linearGradient id={FILL_GRADIENT_ID} gradientUnits="userSpaceOnUse" x1={0} y1={y1} x2={0} y2={y2}>
        <stop offset="0%" stopColor="#f0ede8" stopOpacity={0.95} />
        <stop offset={`${split}%`} stopColor="#f0ede8" stopOpacity={0.95} />
        <stop offset={`${split}%`} stopColor="#1f1d1b" stopOpacity={0.95} />
        <stop offset="100%" stopColor="#1f1d1b" stopOpacity={0.95} />
      </linearGradient>
    </defs>
  );
}

function makeTooltip(plyOffset: number) {
  return function GraphTooltip(props: TooltipContentProps): JSX.Element | null {
    const entry = props.payload?.[0];
    const point = entry?.payload as GraphPoint | undefined;
    if (!props.active || point === undefined) return null;
    return (
      <div className="graph-tooltip">
        <div>
          {point.ply === 0 ? 'Start' : `${plyLabel(point.ply, plyOffset)} ${point.san ?? ''}`}{' '}
          <span className="mono">{point.scoreText}</span>
        </div>
        {point.classification !== undefined && (
          <div className="cls" style={{ color: CLASSIFICATION_COLORS[point.classification] }}>
            <ClassificationIcon classification={point.classification} size={14} />
            {CLASSIFICATION_LABELS[point.classification]}
          </div>
        )}
      </div>
    );
  };
}

export function EvalGraph({ moves, keyMoments, currentPly, onSelectPly, plyOffset = 0 }: EvalGraphProps): JSX.Element {
  const data = useMemo<GraphPoint[]>(() => {
    const keys = new Set(keyMoments);
    const first = moves[0];
    // Side to move: before a move it is the mover, after it the opponent (needed for "mate 0").
    const start: GraphPoint = {
      ply: 0,
      eval: first === undefined ? 0 : scoreToPawns(first.evalBefore, first.color),
      scoreText: first === undefined ? '0.0' : formatScore(first.evalBefore, first.color),
      key: false,
    };
    const rest = moves.map<GraphPoint>((m) => ({
      ply: m.ply,
      eval: scoreToPawns(m.evalAfter, other(m.color)),
      san: m.san,
      classification: m.classification,
      scoreText: formatScore(m.evalAfter, other(m.color)),
      key: keys.has(m.ply),
    }));
    return [start, ...rest];
  }, [moves, keyMoments]);

  const GraphTooltip = useMemo(() => makeTooltip(plyOffset), [plyOffset]);
  const maxPly = moves.length;

  return (
    <div className="eval-graph">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 6, right: 6, bottom: 0, left: 6 }}
          onClick={(state) => {
            const label = state.activeLabel;
            const fromLabel = typeof label === 'number' ? label : Number(label);
            if (Number.isFinite(fromLabel) && label !== undefined) {
              onSelectPly(Math.max(0, Math.min(maxPly, Math.round(fromLabel))));
              return;
            }
            const idx = Number(state.activeTooltipIndex);
            if (Number.isFinite(idx)) {
              const point = data[idx];
              if (point !== undefined) onSelectPly(point.ply);
            }
          }}
          style={{ cursor: 'pointer' }}
        >
          <EvalFillGradient />
          <CartesianGrid stroke="#3a3734" strokeDasharray="2 4" vertical={false} />
          <XAxis dataKey="ply" type="number" domain={[0, Math.max(1, maxPly)]} hide />
          <YAxis domain={[-GRAPH_CLAMP, GRAPH_CLAMP]} hide />
          <ReferenceLine y={0} stroke="#6f6c69" strokeWidth={1} />
          <Tooltip
            content={GraphTooltip}
            cursor={{ stroke: '#a09d9a', strokeWidth: 1 }}
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="eval"
            stroke="#a09d9a"
            strokeWidth={1.5}
            fill={`url(#${FILL_GRADIENT_ID})`}
            baseValue={-GRAPH_CLAMP}
            isAnimationActive={false}
            dot={KeyMomentDot}
            activeDot={{ r: 4, fill: '#81b64c', stroke: '#1f1d1b', strokeWidth: 1.5 }}
          />
          <ReferenceLine x={currentPly} stroke="#81b64c" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
