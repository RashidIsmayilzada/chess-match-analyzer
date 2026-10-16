import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { validate } from '../http.js';
import type { SettingsPatch } from '../settings.js';

const analysisPatchSchema = z
  .object({
    depth: z.number().int().min(1).max(99),
    multiPv: z.number().int().min(1).max(10),
    threads: z.number().int().min(1).max(512),
    hashMb: z.number().int().min(1).max(65_536),
    movetimeMs: z.number().int().positive().max(600_000).nullable(),
    enginePath: z.string().trim().min(1),
  })
  .partial()
  .strict();

const ratingByTimeClass = z.object({ base: z.number(), slope: z.number() }).partial().strict();

const thresholdsPatchSchema = z
  .object({
    winProb: z.object({ k: z.number().positive(), mateCp: z.number().positive() }).partial().strict(),
    bands: z
      .object({
        excellent: z.number().min(0).max(1),
        good: z.number().min(0).max(1),
        inaccuracy: z.number().min(0).max(1),
        mistake: z.number().min(0).max(1),
      })
      .partial()
      .strict(),
    brilliant: z
      .object({
        maxLossFromBest: z.number().min(0).max(1),
        minSacrificeValue: z.number().min(0),
        maxWinProbBefore: z.number().min(0).max(1),
        allowWhenWinningIfMate: z.boolean(),
        minWinProbAfter: z.number().min(0).max(1),
        excludeMateInOne: z.boolean(),
      })
      .partial()
      .strict(),
    great: z
      .object({
        maxLossFromBest: z.number().min(0).max(1),
        minGapToSecondBest: z.number().min(0).max(1),
        maxWinProbBefore: z.number().min(0).max(1),
        minWinProbBefore: z.number().min(0).max(1),
        excludeForcedMoves: z.boolean(),
        excludeRecaptures: z.boolean(),
        excludeFreeCaptures: z.boolean(),
      })
      .partial()
      .strict(),
    miss: z
      .object({
        minOpponentLoss: z.number().min(0).max(1),
        minGiveBackFraction: z.number().min(0).max(1),
        minOwnLoss: z.number().min(0).max(1),
      })
      .partial()
      .strict(),
    accuracy: z.object({ a: z.number(), b: z.number(), c: z.number() }).partial().strict(),
    rating: z
      .object({
        byTimeClass: z
          .object({ bullet: ratingByTimeClass, blitz: ratingByTimeClass, rapid: ratingByTimeClass })
          .partial()
          .strict(),
        min: z.number(),
        max: z.number(),
        evalClampCp: z.number().positive(),
      })
      .partial()
      .strict(),
    keyMoments: z.object({ minSwing: z.number().min(0).max(1), max: z.number().int().min(0) }).partial().strict(),
  })
  .partial()
  .strict();

export const settingsPatchSchema = z
  .object({
    analysis: analysisPatchSchema.optional(),
    thresholds: thresholdsPatchSchema.optional(),
  })
  .strict();

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/settings', async () => ctx.settings.getAll());

  app.put('/api/settings', async (request) => {
    const patch = validate(settingsPatchSchema, request.body ?? {}, 'settings');
    return ctx.settings.update(patch as SettingsPatch);
  });

  app.delete('/api/settings', async () => ctx.settings.reset());
}
