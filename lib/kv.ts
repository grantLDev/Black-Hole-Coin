/**
 * Vercel KV (Upstash Redis) over the REST API, with no client library.
 *
 * Deliberately dependency-free: the route needs GET, SET and DEL, and rolling
 * them by hand buys precise control over the one thing that actually matters
 * here — the timeout. KV being slow or down must degrade the response, never
 * hang or fail it, and a hand-rolled client makes that guarantee explicit.
 *
 * Every function is total: nothing here throws. Callers read `backend` to find
 * out whether they got real persistence or the per-instance memory mirror, and
 * flag `degraded` accordingly.
 *
 * Server-only. Reads KV_REST_API_URL / KV_REST_API_TOKEN, which are never
 * exposed to the client.
 */

import { fetchWithTimeout } from "./cache";

const KV_TIMEOUT_MS = 1_500;

/**
 * Per-instance mirror. Used when KV is unconfigured or unreachable, and kept
 * warm on every successful KV read so a mid-life KV outage falls back to
 * something recent rather than to nothing.
 *
 * This is the "better a possibly-reset peak than a crashed route" path. It does
 * NOT survive a cold start, which is exactly why KV is the primary.
 */
const memory = new Map<string, string>();

export type KvBackend = "kv" | "memory";

export interface KvRead<T> {
  readonly value: T | null;
  readonly backend: KvBackend;
}

function credentials(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** True when the environment is configured for real persistence. */
export function isKvConfigured(): boolean {
  return credentials() !== null;
}

/**
 * Run one Redis command through the Upstash REST endpoint.
 *
 * Commands are posted as a JSON array to the root URL rather than built into
 * the path, which sidesteps URL-encoding entirely for values that contain
 * slashes or unicode.
 */
async function command(args: (string | number)[]): Promise<{ result: unknown } | null> {
  const creds = credentials();
  if (!creds) return null;

  try {
    const response = await fetchWithTimeout(
      creds.url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${creds.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(args),
      },
      KV_TIMEOUT_MS,
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { result?: unknown; error?: string };
    if (typeof body?.error === "string") return null;
    return { result: body.result ?? null };
  } catch {
    // Timeout, abort, DNS, TLS, malformed JSON — all the same to the caller.
    return null;
  }
}

/** Read and JSON-parse a key. Falls back to the memory mirror on any failure. */
export async function kvGetJson<T>(key: string): Promise<KvRead<T>> {
  const response = await command(["GET", key]);

  if (response !== null) {
    const raw = response.result;
    if (raw === null || raw === undefined) {
      // A real KV miss. Authoritative — do not shadow it with a stale mirror.
      return { value: null, backend: "kv" };
    }
    const parsed = parseJson<T>(raw);
    if (parsed !== null && typeof raw === "string") memory.set(key, raw);
    return { value: parsed, backend: "kv" };
  }

  const mirrored = memory.get(key);
  return { value: mirrored === undefined ? null : parseJson<T>(mirrored), backend: "memory" };
}

/** JSON-encode and write a key. Always mirrors to memory first. */
export async function kvSetJson<T>(key: string, value: T): Promise<KvBackend> {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return "memory";
  }

  memory.set(key, encoded);
  const response = await command(["SET", key, encoded]);
  return response === null ? "memory" : "kv";
}

/** Delete a key from both KV and the memory mirror. */
export async function kvDelete(key: string): Promise<KvBackend> {
  memory.delete(key);
  const response = await command(["DEL", key]);
  return response === null ? "memory" : "kv";
}

function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== "string") {
    // Upstash returns already-decoded values for some types; trust them.
    return (raw as T) ?? null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
