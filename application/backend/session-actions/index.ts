/** Rebuilt package entry for the absorbed `session-service/index.ts` barrel
 *  (repository organization migration B7 consolidate record). The session
 *  implementation is canonical at `service.ts`; importers are re-pointed
 *  there and this entry exists so the retired barrel maps to a distinct
 *  surviving file (removal owner: B8). */
export { SessionService } from './service.js';
