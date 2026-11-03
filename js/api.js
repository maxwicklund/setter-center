import { ENDPOINT_URL, REFRESH_MS } from '../config.js';

// The team password is the endpoint token. localStorage (not sessionStorage) so setters
// don't retype it per tab; "Sign out" clears it.
const TOKEN_KEY = 'rwsc.token';

export const token = {
  get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set(v) { try { localStorage.setItem(TOKEN_KEY, v); } catch { /* private mode: works for this tab only */ } },
  clear() { try { localStorage.removeItem(TOKEN_KEY); } catch { /* nothing stored */ } }
};

export class ApiError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail || '';
  }
}

/**
 * POSTs as text/plain, which browsers send without a CORS preflight; Apps Script would
 * fail a preflight. The token rides in the body, never in a header or the URL.
 */
export async function post(body) {
  let res;
  try {
    res = await fetch(ENDPOINT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer'
    });
  } catch {
    throw new ApiError('network', 'Could not reach the data service. Check your connection.');
  }
  const text = await res.text();
  try {
    return { data: JSON.parse(text), text };
  } catch {
    throw new ApiError('not_json', `The data service answered ${res.status} without data. A wrong URL in config.js or a script error looks like this.`);
  }
}

export async function fetchPayload(tok) {
  const { data, text } = await post({ token: tok });
  if (data.error) throw new ApiError(data.error, data.detail);
  return { payload: data, text };
}

/** Calls run() every REFRESH_MS +/-15%; pauses while hidden, catches up when shown again. */
export function startPolling(run) {
  let timer = null;
  let stopped = false;
  let last = Date.now();
  const schedule = () => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(tick, REFRESH_MS * (0.85 + Math.random() * 0.3));
  };
  async function tick() {
    if (stopped || document.visibilityState === 'hidden') return;
    last = Date.now();
    await run();
    schedule();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearTimeout(timer);
    else if (Date.now() - last > REFRESH_MS) tick();
    else schedule();
  });
  schedule();
  return { now: tick, stop: () => { stopped = true; clearTimeout(timer); } };
}
