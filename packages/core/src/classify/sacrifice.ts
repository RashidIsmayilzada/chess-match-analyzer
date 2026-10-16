/**
 * Sacrifice detection.
 *
 * `detectSacrifice(fenBefore, uci)` answers: after playing `uci`, how much material does the
 * mover leave en prise that a simple capture sequence could win, net of what the move itself
 * captured and net of what was already hanging before the move?
 *
 * ALGORITHM
 * 1. Load `fenBefore`. For every piece of the mover (kings excluded) that the opponent attacks,
 *    run a static exchange evaluation (SEE) on that square with the opponent capturing first.
 *    `max(0, SEE)` is how much the opponent could win there. This is the "hanging before" map.
 * 2. Make the move (chess.js validates legality). Repeat step 1 on the new position: the
 *    "hanging after" map. Here the opponent is to move, so only squares on which the opponent has
 *    a LEGAL capture count: after a check the opponent must deal with the check first (a piece
 *    that is merely attacked is not en prise), and a piece attacked only by a pinned piece is
 *    not en prise either. After a checkmating move the opponent has no legal moves, so the plain
 *    attack-based map is used there: the material offered by a mating move still counts.
 * 3. For each square hanging after the move, subtract what was already hanging on it before
 *    (for the piece that moved, subtract what was hanging on its origin square): material that was
 *    en prise before and is still en prise is not a new sacrifice. Only positive remainders count,
 *    and those squares are reported.
 * 4. Subtract the material the move itself won: the captured piece, and for a promotion the gain
 *    from pawn to the promoted piece (a promoted queen that is immediately taken only costs a pawn).
 * 5. `value = max(0, result)`, `isSacrifice = value >= 1` (a pawn is the smallest unit).
 *    `grossValue` is the material the move offers: the FULL exchange loss on every square reported
 *    in step 3 (not reduced by what hung there before, nor by step 4). Marshall's 23...Qg3!! offers
 *    9 (the queen; net 5, because on c3 it already hung for 4), the Greek gift Bxh7+ offers 3 (net 2).
 *
 * SEE (swap-list algorithm, chessprogramming.org "SEE - The Swap Algorithm"): starting with the
 * value of the piece on the square, each side in turn captures with its least valuable attacker,
 * the attacker is lifted off the board (revealing x-ray attackers) and `gain[d] = value(capturer)
 * - gain[d-1]` is recorded. A backward negamax pass `gain[d-1] = -max(-gain[d-1], gain[d])` lets
 * each side stop the sequence when continuing would lose material. Pins are ignored; king
 * legality is respected: a king never captures on a square the other side still attacks.
 *
 * Consequences of this definition (see sacrifice.test.ts):
 * - Greek gift Bxh7+ Kxh7 nets 2 (bishop 3 - pawn 1), an exchange sac Rxc3 bxc3 nets 2, a knight
 *   left to a pawn nets 3, a capture that wins material back nets 0.
 */
import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import { PIECE_VALUES } from '../config/thresholds.js';

export interface SacrificeResult {
  isSacrifice: boolean;
  /** Net material (pawn units) the mover leaves en prise and cannot recoup by recapture. 0 if none. */
  value: number;
  /**
   * Gross material (pawn units) the move offers: the full exchange loss on every square where the
   * move left more material en prise than before, not reduced by what already hung there nor by
   * what the move captured (9 for Marshall's Qg3, 3 for Bxh7+). 0 if none.
   */
  grossValue: number;
  /** Squares of the sacrificed pieces, for display. */
  squares: string[];
}

/** Smallest unit of material: anything less than a pawn is not a sacrifice. */
const MIN_SACRIFICE_VALUE = PIECE_VALUES.p;

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

function otherColor(c: Color): Color {
  return c === 'w' ? 'b' : 'w';
}

/** Capture ordering: least valuable attacker first, the king always last. */
function captureOrder(type: PieceSymbol): number {
  return type === 'k' ? Number.POSITIVE_INFINITY : PIECE_VALUES[type];
}

function leastValuableAttacker(board: Chess, square: Square, side: Color): { from: Square; type: PieceSymbol } | undefined {
  let best: { from: Square; type: PieceSymbol } | undefined;
  for (const from of board.attackers(square, side)) {
    const piece = board.get(from);
    if (!piece) continue;
    if (!best || captureOrder(piece.type) < captureOrder(best.type)) best = { from, type: piece.type };
  }
  return best;
}

/**
 * Static exchange evaluation on `square` (which holds a piece of the side opposite to `attacker`),
 * with `attacker` capturing first. Returns the net material, in pawn units, that `attacker` wins
 * when both sides play the exchange optimally (negative when capturing would lose material;
 * 0 when no legal capture exists). With `firstFrom` the first capture is made by the piece on that
 * square (the move actually played) instead of the least valuable attacker.
 */
export function staticExchangeEvaluation(chess: Chess, square: Square, attacker: Color, firstFrom?: Square): number {
  const target = chess.get(square);
  if (!target || target.color === attacker) return 0;

  // Scratch board: pieces are lifted off as they capture so that x-ray attackers become visible.
  const board = new Chess(chess.fen(), { skipValidation: true });
  const gain: number[] = [PIECE_VALUES[target.type]];
  let side = attacker;
  let d = 0;

  for (;;) {
    const first = d === 0 && firstFrom !== undefined ? board.get(firstFrom) : undefined;
    const next = first ? { from: firstFrom as Square, type: first.type } : leastValuableAttacker(board, square, side);
    if (!next) break;
    // A king may only capture when the square is no longer attacked by the other side.
    if (next.type === 'k' && board.attackers(square, otherColor(side)).length > 0) break;
    d += 1;
    gain[d] = PIECE_VALUES[next.type] - (gain[d - 1] as number);
    board.remove(next.from);
    side = otherColor(side);
  }

  if (d === 0) return 0;
  while (--d > 0) {
    gain[d - 1] = -Math.max(-(gain[d - 1] as number), gain[d] as number);
  }
  // `|| 0` normalises -0 (from the negations above) to 0.
  return (gain[0] as number) || 0;
}

/**
 * Squares on which the side to move has a legal capture. An en passant capture is mapped to the
 * square of the pawn it takes.
 */
export function legalCaptureSquares(chess: Chess): Set<Square> {
  const squares = new Set<Square>();
  for (const move of chess.moves({ verbose: true })) {
    if (!move.captured) continue;
    if (move.flags.includes('e')) {
      const rank = Number(move.to[1]) + (move.color === 'w' ? -1 : 1);
      squares.add(`${move.to[0]}${rank}` as Square);
    } else {
      squares.add(move.to);
    }
  }
  return squares;
}

/**
 * Material of `color` that the other side can win by capturing, per square (kings excluded).
 * When `capturable` is given (the other side is to move), only those squares are considered.
 */
function hangingMaterial(chess: Chess, color: Color, capturable?: ReadonlySet<Square>): Map<Square, number> {
  const result = new Map<Square, number>();
  const enemy = otherColor(color);
  for (const rank of chess.board()) {
    for (const cell of rank) {
      if (!cell || cell.color !== color || cell.type === 'k') continue;
      if (capturable && !capturable.has(cell.square)) continue;
      if (chess.attackers(cell.square, enemy).length === 0) continue;
      const loss = staticExchangeEvaluation(chess, cell.square, enemy);
      if (loss > 0) result.set(cell.square, loss);
    }
  }
  return result;
}

/** Detect whether playing `uci` in `fenBefore` sacrifices material. See the module comment. */
export function detectSacrifice(fenBefore: string, uci: string): SacrificeResult {
  const m = UCI_RE.exec(uci.trim());
  if (!m) throw new Error(`detectSacrifice: invalid UCI move "${uci}"`);
  const from = m[1] as Square;
  const to = m[2] as Square;
  const promotion = m[3] as PieceSymbol | undefined;

  const chess = new Chess(fenBefore);
  const mover = chess.turn();

  const before = hangingMaterial(chess, mover);
  // Throws on an illegal move; that is a caller bug and must not be silently classified.
  const move = chess.move({ from, to, promotion });
  // The opponent is to move now: only what they can legally take is en prise. After a delivered
  // checkmate they have no moves at all; the material the move offered still counts (a mating
  // queen sacrifice stays a sacrifice, and `brilliant.excludeMateInOne` decides what to do with it).
  const capturable = chess.isCheckmate() ? undefined : legalCaptureSquares(chess);
  const after = hangingMaterial(chess, mover, capturable);

  let addedValue = 0;
  let grossValue = 0;
  const squares: string[] = [];
  for (const [square, lossAfter] of after) {
    const prior = (square === move.to ? before.get(move.from) : before.get(square)) ?? 0;
    const added = lossAfter - prior;
    if (added > 0) {
      addedValue += added;
      grossValue += lossAfter;
      squares.push(square);
    }
  }

  const captured = move.captured ? PIECE_VALUES[move.captured] : 0;
  const promotionGain = move.promotion ? PIECE_VALUES[move.promotion] - PIECE_VALUES.p : 0;
  const value = Math.max(0, addedValue - captured - promotionGain);

  const isSacrifice = value >= MIN_SACRIFICE_VALUE;
  return { isSacrifice, value, grossValue, squares: isSacrifice ? squares : [] };
}

export interface CaptureExchange {
  /** The move captures something (en passant included). */
  isCapture: boolean;
  /**
   * Static exchange evaluation for the MOVER on the destination square before the move, with the
   * moving piece capturing first (pawn units). > 0 means the captured piece was hanging or
   * under-defended, i.e. taking it simply wins material. 0 for a non-capture.
   */
  gain: number;
}

/**
 * How much the mover wins by the exchange that `uci` starts on its destination square. Used by
 * the Great rule (`great.excludeFreeCaptures`): taking a hanging piece is obvious, not great.
 * En passant is evaluated as if the captured pawn stood on the destination square.
 */
export function captureExchange(fenBefore: string, uci: string): CaptureExchange {
  const m = UCI_RE.exec(uci.trim());
  if (!m) throw new Error(`captureExchange: invalid UCI move "${uci}"`);
  const from = m[1] as Square;
  const to = m[2] as Square;
  const promotion = m[3] as PieceSymbol | undefined;

  const chess = new Chess(fenBefore);
  const mover = chess.turn();
  // Throws on an illegal move, like detectSacrifice.
  const move = new Chess(fenBefore).move({ from, to, promotion });
  if (!move.captured) return { isCapture: false, gain: 0 };

  if (move.flags.includes('e')) {
    const board = new Chess(fenBefore, { skipValidation: true });
    const capturedSquare = `${to[0]}${from[1]}` as Square;
    board.remove(capturedSquare);
    board.put({ type: 'p', color: otherColor(mover) }, to);
    return { isCapture: true, gain: staticExchangeEvaluation(board, to, mover, from) };
  }
  return { isCapture: true, gain: staticExchangeEvaluation(chess, to, mover, from) };
}
