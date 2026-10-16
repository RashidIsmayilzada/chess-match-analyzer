import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { detectSacrifice, legalCaptureSquares } from './sacrifice.js';

describe('detectSacrifice', () => {
  it('queen moved en prise to an undefended square: value 9', () => {
    // White Qd1 -> d5, attacked by the e6 pawn, nothing defends d5.
    const r = detectSacrifice('6k1/5ppp/4p3/8/8/8/5PPP/3Q2K1 w - - 0 1', 'd1d5');
    expect(r.value).toBe(9);
    expect(r.isSacrifice).toBe(true);
    expect(r.squares).toEqual(['d5']);
  });

  it('protected piece attacked only by a higher-value piece: 0', () => {
    // Nb3 -> d4, attacked by Rd8 but defended by the e3 pawn. RxN loses the exchange, so nothing hangs.
    const r = detectSacrifice('3r2k1/5ppp/8/8/8/1N2P3/5PPP/6K1 w - - 0 1', 'b3d4');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
    expect(r.squares).toEqual([]);
  });

  it('exchange sac Rxc3 bxc3: value 2 (rook 5 for knight 3)', () => {
    // Black Rc8 takes the knight on c3; the b2 pawn recaptures, black cannot recapture on c3.
    const r = detectSacrifice('2r3k1/5ppp/8/8/8/2N5/1P3PPP/4R1K1 b - - 0 1', 'c8c3');
    expect(r.value).toBe(2);
    expect(r.isSacrifice).toBe(true);
    expect(r.squares).toEqual(['c3']);
  });

  it('pawn push that leaves a knight hanging: 3', () => {
    // Nd4 is attacked by Bb6 and defended only by the e3 pawn. e3-e4 removes the defender.
    const r = detectSacrifice('6k1/5ppp/1b6/8/3N4/4P3/5PPP/6K1 w - - 0 1', 'e3e4');
    expect(r.value).toBe(3);
    expect(r.isSacrifice).toBe(true);
    expect(r.squares).toEqual(['d4']);
  });

  it('a piece already en prise that moves to another en prise square is not a new sacrifice: 0', () => {
    // Qd1 is already attacked by Rd8 down the open d-file (9 hanging). Qd1-d4 (defended by Nf3, 4 hanging) adds nothing.
    const r = detectSacrifice('3r2k1/5ppp/8/8/8/5N2/5PPP/3Q2K1 w - - 0 1', 'd1d4');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
  });

  it('a piece hanging before and after the move is not a new sacrifice: 0', () => {
    // Nd4 is already attacked by Bb6 and undefended; h2-h3 does nothing about it.
    const r = detectSacrifice('6k1/5ppp/1b6/8/3N4/8/5PPP/6K1 w - - 0 1', 'h2h3');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
    expect(r.squares).toEqual([]);
  });

  it('a capture that wins material back is not a sacrifice', () => {
    // Rxd8 taking a queen with the rook hanging to Kxd8 afterwards: 5 lost, 9 gained -> 0.
    const r = detectSacrifice('3qk3/8/8/8/8/8/8/3R2K1 w - - 0 1', 'd1d8');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
  });

  it('Greek gift Bxh7+ nets bishop minus pawn: 2', () => {
    const fen = 'rnb2rk1/pp1nqppp/4p3/2ppP3/3P4/2NB1N2/PPP2PPP/R2QK2R w KQ - 0 9';
    const r = detectSacrifice(fen, 'd3h7');
    expect(r.value).toBe(2);
    expect(r.isSacrifice).toBe(true);
    expect(r.squares).toEqual(['h7']);
  });

  it('Legal-style Nxe5 leaves the queen en prise to Bxd1 (king recaptures): knight 3 + (9 - 3) - pawn 1 = 8', () => {
    // 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6 5.Nxe5
    const fen = 'rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5';
    const r = detectSacrifice(fen, 'f3e5');
    expect(r.value).toBe(8);
    expect(r.isSacrifice).toBe(true);
    expect(r.squares.sort()).toEqual(['d1', 'e5']);
  });

  it('SEE respects a protected piece via a swap sequence: a defended queen attacked by a rook is not hanging', () => {
    // Qa1 -> d4; Rd8 attacks d4, Nf3 defends it. RxQ, NxR nets the opponent 9 - 5 = 4 -> still a loss of 4.
    const r = detectSacrifice('3r2k1/5ppp/8/8/8/5N2/5PPP/Q5K1 w - - 0 1', 'a1d4');
    expect(r.value).toBe(4);
    expect(r.squares).toEqual(['d4']);
  });

  it('the king cannot capture a protected piece (king legality in SEE)', () => {
    // Rh1-h7: the rook is "attacked" by Kg8 but protected by the g6 pawn, so Kxh7 is illegal -> nothing hangs.
    // (The g6 pawn itself hangs to f7xg6 both before and after the move, so it is not new material.)
    const protectedRook = detectSacrifice('6k1/5p2/6P1/8/8/8/5PP1/6KR w - - 0 1', 'h1h7');
    expect(protectedRook.value).toBe(0);
    expect(protectedRook.squares).toEqual([]);
    // Without the g6 pawn the king simply takes the rook.
    const looseRook = detectSacrifice('6k1/5p2/8/8/8/8/5PP1/6KR w - - 0 1', 'h1h7');
    expect(looseRook.value).toBe(5);
    expect(looseRook.squares).toEqual(['h7']);
  });

  it('promoting into a capture does not count the promoted queen as given-up material', () => {
    // a7-a8=Q where the new queen is immediately captured by Rh8: only the pawn (1) is really invested.
    const r = detectSacrifice('7r/P7/8/8/8/8/8/K5k1 w - - 0 1', 'a7a8q');
    expect(r.value).toBe(1);
  });

  it('handles black movers (POV of attackers flips)', () => {
    // Black Nf6 -> e4 where the d3 pawn attacks it and nothing defends.
    const r = detectSacrifice('6k1/5ppp/5n2/8/8/3P4/5PPP/6K1 b - - 0 1', 'f6e4');
    expect(r.value).toBe(3);
    expect(r.squares).toEqual(['e4']);
  });

  it('a queen trade with check is not a sacrifice: the opponent must answer the check, not grab a pawn', () => {
    // game1 ply 28: 14...Qxd2+ (Rxd2 follows). The c7 pawn is attacked by Be5 and loses its
    // defender (the queen), but White is in check and cannot take it.
    const r = detectSacrifice('1r1q1rk1/p1p2pbp/b1p3p1/2n1B3/4P3/2N2N2/PPPQ1PPP/2KR3R b - - 0 14', 'd8d2');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
    expect(r.squares).toEqual([]);
  });

  it('a non-capturing check that stops defending a piece does not count that piece as en prise', () => {
    // Qc3 defends Nd4 against Bb6. Qc8+ leaves the knight "attacked", but Black's only legal
    // reply is Kh7, so nothing can be taken this move.
    const r = detectSacrifice('6k1/5pp1/1b5p/8/3N4/2Q5/5PPP/6K1 w - - 0 1', 'c3c8');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
  });

  it('a piece attacked only by a pinned piece is not en prise', () => {
    // Black's Bb4 is pinned to Ke7 by Re1... moving Nc3-d5 "attacked" by the pinned bishop.
    // Re1 pins Bb4? No: the pin is on the e-file. Use: Black Bb4 pinned along the a3-f8 diagonal
    // by Ba3 to Kf8; White Nc3-d5 is attacked by Bb4 but Bxd5 is illegal.
    const r = detectSacrifice('5k2/8/8/8/1b6/B1N5/8/6K1 w - - 0 1', 'c3d5');
    expect(r.value).toBe(0);
    expect(r.isSacrifice).toBe(false);
  });

  it('legalCaptureSquares maps en passant to the captured pawn', () => {
    const chess = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
    expect([...legalCaptureSquares(chess)]).toEqual(['d5']);
  });

  it('throws on an illegal move', () => {
    expect(() => detectSacrifice('6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1', 'g1g3')).toThrow();
  });
});
