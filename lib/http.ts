const UA = "frontier-papers/0.1 (research digest bot)";

interface Opts {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

async function req(url: string, accept: string, opts: Opts): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: accept, ...opts.headers },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

export const httpText = (url: string, opts: Opts = {}) =>
  req(url, "application/xml, text/xml, */*", opts).then((r) => r.text());

export const httpJSON = <T>(url: string, opts: Opts = {}) =>
  req(url, "application/json", opts).then((r) => r.json() as Promise<T>);

export const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
