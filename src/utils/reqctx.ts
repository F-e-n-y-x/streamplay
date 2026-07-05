import { AsyncLocalStorage } from 'async_hooks';

/**
 * Per-request cancellation context.
 *
 * The SSE /sources route fans out to every provider concurrently. When the browser
 * tab closes mid-scan we want to STOP the abandoned provider work (and especially
 * the slow FlareSolverr solves it spawned) instead of letting it run to completion
 * and starve the single-browser FlareSolverr pool for the next real request.
 *
 * Rather than thread an AbortSignal through all ~24 providers' invoke(data) calls
 * and every app.get(), we carry it in AsyncLocalStorage — exactly like the WARP
 * context — so the shared HTTP layer (utils/http.ts) and the FlareSolverr client
 * can read it and pass `signal` to axios, which cancels the in-flight request.
 */

interface ReqCtx { signal?: AbortSignal; }

const als = new AsyncLocalStorage<ReqCtx>();

/** Run `fn` with an AbortSignal that nested HTTP calls will honour. */
export const runWithSignal = <T>(signal: AbortSignal | undefined, fn: () => T): T =>
    als.run({ signal }, fn);

/** The AbortSignal for the request currently in flight, if any. */
export const currentSignal = (): AbortSignal | undefined => als.getStore()?.signal;
