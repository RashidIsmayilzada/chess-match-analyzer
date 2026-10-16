/**
 * Our own classification glyphs. Each icon is a coloured disc with a white glyph,
 * drawn in a 24x24 viewBox. Glyphs are pure paths (no text) so they render
 * identically everywhere.
 */
import type { Classification } from '@chess-analyzer/core';
import type { JSX } from 'react';
import { CLASSIFICATION_COLORS } from '../lib/classification';

const INK = '#ffffff';

/** Exclamation mark centred at x, spanning y 5.5..18.5. */
function Exclaim({ x }: { x: number }): JSX.Element {
  return (
    <>
      <path d={`M${x - 1.4} 5.5h2.8l-.5 8.4h-1.8z`} fill={INK} />
      <circle cx={x} cy={16.9} r={1.6} fill={INK} />
    </>
  );
}

/** Question mark centred at x, spanning y 5.5..18.5. */
function Question({ x }: { x: number }): JSX.Element {
  return (
    <>
      <path
        d={`M${x - 3.3} 9.2a3.3 3.3 0 0 1 6.6 0c0 1.5-.9 2.3-1.9 3-.9.6-1.3 1-1.3 2v.5h-2.4v-.7c0-1.6.7-2.5 1.8-3.2.8-.6 1.3-1 1.3-1.7a1 1 0 0 0-2 0z`}
        fill={INK}
      />
      <circle cx={x} cy={16.9} r={1.6} fill={INK} />
    </>
  );
}

const GLYPHS: Record<Classification, JSX.Element> = {
  // "!!" — two exclamation marks, slightly compressed to fit the disc.
  brilliant: (
    <g transform="translate(12 12) scale(0.9) translate(-12 -12)">
      <Exclaim x={9.4} />
      <Exclaim x={14.6} />
    </g>
  ),
  // "!"
  great: <Exclaim x={12} />,
  // five-pointed star
  best: (
    <path
      d="M12 4.6l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.9l5-.7z"
      fill={INK}
    />
  ),
  // thumbs-up
  excellent: (
    <path
      d="M7 11h2.4v7.4H7zM10.6 18.4V11l2.9-5.4c.3-.6.8-.9 1.4-.9 1 0 1.6.8 1.4 1.8l-.6 3.2h2.6c1.1 0 1.9 1 1.6 2l-1.2 5.2c-.2.9-1 1.5-1.9 1.5z"
      fill={INK}
    />
  ),
  // check mark
  good: (
    <path
      d="M5.5 12.6l2.2-2.2 2.9 2.9 5.8-5.8 2.2 2.2-8 8z"
      fill={INK}
    />
  ),
  // open book
  book: (
    <path
      d="M12 7.6c-1.2-1-2.9-1.5-5.2-1.5v10.6c2.3 0 4 .5 5.2 1.5 1.2-1 2.9-1.5 5.2-1.5V6.1c-2.3 0-4 .5-5.2 1.5zm-.9 8.6c-1-.5-2.3-.8-3.5-.9V7.9c1.3.1 2.5.4 3.5 1zm5.3-.9c-1.2.1-2.5.4-3.5.9V8.9c1-.6 2.2-.9 3.5-1z"
      fill={INK}
    />
  ),
  // "?!"
  inaccuracy: (
    <g transform="translate(12 12) scale(0.9) translate(-12 -12)">
      <Question x={9.2} />
      <Exclaim x={15.2} />
    </g>
  ),
  // "?"
  mistake: <Question x={12} />,
  // crossed-out target: a circle with a diagonal slash ("missed")
  miss: (
    <>
      <circle cx={12} cy={12} r={5.4} fill="none" stroke={INK} strokeWidth={2.2} />
      <path d="M7.6 16.4l8.8-8.8" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />
    </>
  ),
  // "??"
  blunder: (
    <g transform="translate(12 12) scale(0.9) translate(-12 -12)">
      <Question x={8.9} />
      <Question x={15.1} />
    </g>
  ),
};

export interface ClassificationIconProps {
  classification: Classification;
  size?: number;
  title?: string;
  className?: string;
}

export function ClassificationIcon({
  classification,
  size = 18,
  title,
  className,
}: ClassificationIconProps): JSX.Element {
  const color = CLASSIFICATION_COLORS[classification];
  return (
    <svg
      className={className === undefined ? 'cls-icon' : `cls-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title ?? classification}
    >
      {title !== undefined && <title>{title}</title>}
      <circle cx={12} cy={12} r={11} fill={color} />
      {GLYPHS[classification]}
    </svg>
  );
}

// ---------- navigation / UI glyphs ----------

type SvgProps = { size?: number };

export function IconImport({ size = 18 }: SvgProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M6 9l6 6 6-6M4 19h16" />
    </svg>
  );
}

export function IconGames({ size = 18 }: SvgProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x={3} y={3} width={18} height={18} rx={2} />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </svg>
  );
}

export function IconOpenings({ size = 18 }: SvgProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 6c-2-1.5-4.5-2-8-2v14c3.5 0 6 .5 8 2 2-1.5 4.5-2 8-2V4c-3.5 0-6 .5-8 2zM12 6v14" />
    </svg>
  );
}

export function IconSettings({ size = 18 }: SvgProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx={12} cy={12} r={3} />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

export function IconKnight({ size = 28 }: SvgProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32">
      <rect width={32} height={32} rx={6} fill="#81b64c" />
      <path
        d="M10 25h12v-2H10zM11 22h10l-1.5-3h-7zM12.5 18h7c0-3-1-4.5-2.5-6 1.2-.6 2-1.8 2-3.2A3.8 3.8 0 0 0 15 5a3.8 3.8 0 0 0-3.9 3.8c0 1.4.8 2.6 2 3.2-1.6 1.5-2.6 3-2.6 6z"
        fill="#15200a"
      />
    </svg>
  );
}

export function IconFlip({ size = 16 }: SvgProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9a8 8 0 0 1 14-3l2 2M20 4v4h-4M20 15a8 8 0 0 1-14 3l-2-2M4 20v-4h4" />
    </svg>
  );
}

export function IconChevron({ size = 16, dir }: SvgProps & { dir: 'left' | 'right' | 'first' | 'last' }): JSX.Element {
  const d =
    dir === 'left'
      ? 'M15 5l-7 7 7 7'
      : dir === 'right'
        ? 'M9 5l7 7-7 7'
        : dir === 'first'
          ? 'M17 5l-7 7 7 7M8 5v14'
          : 'M7 5l7 7-7 7M16 5v14';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
