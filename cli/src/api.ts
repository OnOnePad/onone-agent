/** Thin client for the public OnOne agent API. Never sends a private key anywhere. */
import { env } from "./config.js";

export const DEFAULT_BASE_URL = "https://onone.fun";

export class OnOneError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type OnOneClient = {
  baseUrl: string;
  apiKey?: string;
  get<T = unknown>(path: string, auth?: boolean): Promise<T>;
  post<T = unknown>(path: string, body: unknown, auth?: boolean): Promise<T>;
  del<T = unknown>(path: string): Promise<T>;
  upload<T = unknown>(path: string, form: FormData): Promise<T>;
};

function cleanBase(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    throw new Error("ONONE_URL must be https.");
  }
  return u.origin;
}

export function createClient(opts: { baseUrl?: string; apiKey?: string } = {}): OnOneClient {
  const baseUrl = cleanBase(opts.baseUrl ?? env("URL") ?? DEFAULT_BASE_URL);
  const apiKey = opts.apiKey;

  async function call<T>(method: string, path: string, body?: unknown, auth = false, form?: FormData): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "onone-agent/0.3" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!apiKey) throw new OnOneError(401, "unauthorized", "No API key. Run `onone-agent login` first.");
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
      redirect: "error",
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } | string } | null)?.error;
      const code = typeof err === "object" && err?.code ? err.code : `http_${res.status}`;
      const message = typeof err === "object" && err?.message ? err.message : typeof err === "string" ? err : `Request failed (${res.status}).`;
      throw new OnOneError(res.status, code, message);
    }
    return json as T;
  }

  return {
    baseUrl,
    apiKey,
    get: (p, auth = false) => call("GET", p, undefined, auth),
    post: (p, b, auth = true) => call("POST", p, b, auth),
    del: (p) => call("DELETE", p, undefined, true),
    upload: (p, form) => call("POST", p, undefined, true, form),
  };
}
