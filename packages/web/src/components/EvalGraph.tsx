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
  type TooltipContentProps,
} from 'recharts';
import type { Classification, MoveAnalysis } from '@chess-analyzer/core';
import { ClassificationIcon } from '../icons';
import { CLASSIFICATION_COLORS, CLASSIFICATION_LABELS } from '../lib/classification';
import { formatScore, GRAPH_CLAMP, scoreToPawns } from '../lib/eval';
import { plyLabel } from '../lib/chess';

export interface EvalGraphProps {
  moves: MoveAnalysis[];
  keyMoments: number[];
  currentPly: number;
  onSelectPly: (ply: number) => void;
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

function GraphTooltip(props: TooltipContentProps): JSX.Element | null {
  const entry = props.payload?.[0];
  const point = entry?.payload as GraphPoint | undefined;
  if (!props.active || point === undefined) return null;
  return (
    <div className="graph-tooltip">
      <div>
        {point.ply === 0 ? 'Start' : `${plyLabel(point.ply)} ${point.san ?? ''}`}{' '}
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
}

export function EvalGraph({ moves, keyMoments, currentPly, onSelectPly }: EvalGraphProps): JSX.Element {
  const data = useMemo<GraphPoint[]>(() => {
    const keys = new Set(keyMoments);
    const first = moves[0];
    const start: GraphPoint = {
      ply: 0,
      eval: first === undefined ? 0 : scoreToPawns(first.evalBefore),
      scoreText: first === undefined ? '0.0' : formatScore(first.evalBefore),
      key: false,
    };
    const rest = moves.map<GraphPoint>((m) => ({
      ply: m.ply,
      eval: scoreToPawns(m.evalAfter),
      san: m.san,
      classification: m.classification,
      scoreText: formatScore(m.evalAfter),
      key: keys.has(m.ply),
    }));
    return [start, ...rest];
  }, [moves, keyMoments]);

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
          <defs>
            <linearGradient id="evalFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f0ede8" stopOpacity={0.95} />
              <stop offset="50%" stopColor="#f0ede8" stopOpacity={0.95} />
              <stop offset="50%" stopColor="#1f1d1b" stopOpacity={0.95} />
              <stop offset="100%" stopColor="#1f1d1b" stopOpacity={0.95} />
            </linearGradient>
          </defs>
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
            fill="url(#evalFill)"
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
