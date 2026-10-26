import { Router, type Request, type Response } from 'express';
import { US_STATES, SEED_CITIES, PROMPT_CATALOG, INTENTIONS, GENDER_CATEGORIES } from './data.js';

export function createCatalogRoutes() {
  const router = Router();

  /** GET /v1/catalogs — all static catalog data for the client */
  router.get('/v1/catalogs', (_req: Request, res: Response) => {
    res.json({
      data: {
        states: US_STATES,
        cities: SEED_CITIES,
        prompts: PROMPT_CATALOG.filter(p => p.active),
        intentions: INTENTIONS,
        genderCategories: GENDER_CATEGORIES,
      },
      meta: { requestId: _req.requestId },
    });
  });

  return router;
}
