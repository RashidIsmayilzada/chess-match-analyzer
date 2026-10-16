import type { Classification } from '@chess-analyzer/core';

/** Classification colours from docs/ARCHITECTURE.md. */
export const CLASSIFICATION_COLORS: Record<Classification, string> = {
  brilliant: '#1baca6',
  great: '#5c8bb0',
  best: '#95b776',
  excellent: '#96bc4b',
  good: '#96af8b',
  book: '#a88865',
  inaccuracy: '#f0c15c',
  mistake: '#e58f2a',
  miss: '#ee6b55',
  blunder: '#ca3431',
};

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  brilliant: 'Brilliant',
  great: 'Great',
  best: 'Best',
  excellent: 'Excellent',
  good: 'Good',
  book: 'Book',
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  miss: 'Miss',
  blunder: 'Blunder',
};

/** Display order for count panels (same as ALL_CLASSIFICATIONS in core). */
export const CLASSIFICATION_ORDER: readonly Classification[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

const PHRASES: Record<Classification, string> = {
  brilliant: 'is brilliant',
  great: 'is a great move',
  best: 'is the best move',
  excellent: 'is excellent',
  good: 'is good',
  book: 'is a book move',
  inaccuracy: 'is an inaccuracy',
  mistake: 'is a mistake',
  miss: 'is a miss',
  blunder: 'is a blunder',
};

/** "Bxh7+ is brilliant", "Nf3 is a book move". */
export function classificationPhrase(san: string, c: Classification): string {
  return `${san} ${PHRASES[c]}`;
}

export function emptyCounts(): Record<Classification, number> {
  return {
    brilliant: 0,
    great: 0,
    best: 0,
    excellent: 0,
    good: 0,
    book: 0,
    inaccuracy: 0,
    mistake: 0,
    miss: 0,
    blunder: 0,
  };
}
