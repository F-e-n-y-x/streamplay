import axios from 'axios';
import { dohAxios } from './dns';
import { currentSignal } from './reqctx';

/**
 * Shared outbound HTTP client for the METADATA layer (TMDB / AniList / ani.zip /
 * MALSync / TVDB / enc-dec). Unlike the extractor `app` layer these used the bare
 * axios global, so they bypassed:
 *   - DoH  → lookups died on a poisoning ISP even with DOH_ENABLED=true, and
 *   - the per-request abort signal → work continued after the SSE tab closed.
 *
 * This instance folds both in. Use it exactly like `axios` (`net.get`/`net.post`).
 */
export const net = axios.create({ ...dohAxios() });
net.interceptors.request.use((cfg) => { if (!cfg.signal) cfg.signal = currentSignal() as any; return cfg; });

export default net;
