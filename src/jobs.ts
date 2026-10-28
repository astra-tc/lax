/**
 * LAX jobs client: list jobs, read one job and submit work.
 * fetch only, no runtime dependency, no console output.
 */

export type JobTrack = 'lax-agents' | 'coding-agents' | 'godman-protocols' | 'templates' | 'genesis-tools' | 'seat';

/** A LAX job as https://lax.kognai.ai/openapi.json and the live registry describe it. */
export interface Job {
  id: string;
  title: string;
  track: JobTrack | string;
  summary?: string;
  spec_md?: string;
  spec_url?: string | null;
  tests_url?: string | null;
  skills?: string[];
  bounty_usdc: number;
  currency?: string;
  chain?: string;
  deadline?: string;
  status: string;
  seat?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string | null;
  bid_closes?: string | null;
  selection?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface JobList {
  jobs: Job[];
  count: number;
}

export interface ListJobsParams {
  track?: JobTrack | string;
  limit?: number;
  offset?: number;
}

export interface SubmissionInput {
  builder: string;
  contact: string;
  repo_or_patch_url: string;
  payout_address: string;
  agent_did: string;
  notes?: string;
}

export interface Submission {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export type LaxJobsErrorCode =
  | 'invalid_input'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'invalid_response';

export class LaxJobsError extends Error {
  readonly status: number;
  readonly code: LaxJobsErrorCode;
  constructor(status: number, code: LaxJobsErrorCode, message: string) {
    super(message);
    this.name = 'LaxJobsError';
    this.status = status;
    this.code = code;
  }
}

export type JobsFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface JobsClientOptions {
  /** default https://lax.kognai.ai/registry */
  baseUrl?: string;
  /** default globalThis.fetch */
  fetch?: JobsFetch;
  /** extra attempts after the first one, default 2 */
  retries?: number;
  /** default a timer */
  sleep?: (ms: number) => Promise<void>;
  /** per attempt, default 15000 */
  timeoutMs?: number;
}

export interface JobsClient {
  listJobs(params?: ListJobsParams): Promise<JobList>;
  getJob(id: string): Promise<Job>;
  submit(jobId: string, input: SubmissionInput): Promise<Submission>;
}

export const DEFAULT_JOBS_BASE_URL = 'https://lax.kognai.ai/registry';
const MAX_RETRY_AFTER_MS = 30_000;
const BACKOFF_START_MS = 500;
const DID_RE = /^did:[a-z0-9]+:.+/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Maps an HTTP status to the error code. */
export function codeForStatus(status: number): LaxJobsErrorCode {
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'bad_request';
}

/** Retry-After in seconds (or an HTTP date) to milliseconds, capped at 30 s; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === '') return undefined;
  const v = header.trim();
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - now);
  }
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function registryMessage(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === 'object') {
      const e = (j as Record<string, unknown>).error ?? (j as Record<string, unknown>).message;
      if (typeof e === 'string' && e) return e;
      if (e !== undefined) return JSON.stringify(e);
    }
  } catch {
    /* not JSON */
  }
  return text.trim() || `HTTP ${status}`;
}

function checkSubmission(jobId: string, input: SubmissionInput): void {
  const bad = (m: string) => new LaxJobsError(0, 'invalid_input', m);
  if (typeof jobId !== 'string' || jobId.trim() === '') throw bad('jobId is required');
  if (!input || typeof input !== 'object') throw bad('submission input is required');
  if (typeof input.agent_did !== 'string' || !DID_RE.test(input.agent_did))
    throw bad('agent_did must be a DID such as did:web:example.com');
  if (typeof input.payout_address !== 'string' || !ADDRESS_RE.test(input.payout_address))
    throw bad('payout_address must be 0x followed by 40 hex characters');
  let url: URL | undefined;
  try {
    url = new URL(String(input.repo_or_patch_url));
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:') throw bad('repo_or_patch_url must be an https link');
  if (typeof input.builder !== 'string' || input.builder.trim().length < 2) throw bad('builder is required (2 to 80 characters)');
  if (typeof input.contact !== 'string' || input.contact.trim() === '') throw bad('contact is required');
}

export function createJobsClient(options: JobsClientOptions = {}): JobsClient {
  const base = (options.baseUrl ?? DEFAULT_JOBS_BASE_URL).replace(/\/+$/, '');
  const doFetch: JobsFetch = options.fetch ?? ((u, i) => globalThis.fetch(u, i));
  const retries = Math.max(0, Math.floor(options.retries ?? 2));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function once(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request<T>(url: string, init: RequestInit, kind: 'read' | 'submit', pick: string): Promise<T> {
    let backoff = BACKOFF_START_MS;
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= retries;
      let res: Response;
      try {
        res = await once(url, init);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (kind === 'read' && !last) {
          await sleep(backoff);
          backoff *= 2;
          continue;
        }
        throw new LaxJobsError(0, 'network', msg || 'network error');
      }
      if (res.ok) {
        let body: unknown;
        try {
          body = JSON.parse(await res.text());
        } catch {
          throw new LaxJobsError(res.status, 'invalid_response', 'the registry answer is not JSON');
        }
        if (pick === '') {
          const b = body as Partial<JobList> | null;
          if (!b || !Array.isArray(b.jobs)) throw new LaxJobsError(res.status, 'invalid_response', 'the answer has no jobs list');
          return { jobs: b.jobs, count: typeof b.count === 'number' ? b.count : b.jobs.length } as T;
        }
        const inner = body && typeof body === 'object' ? (body as Record<string, unknown>)[pick] : undefined;
        if (!inner || typeof inner !== 'object') throw new LaxJobsError(res.status, 'invalid_response', `the answer has no ${pick}`);
        return inner as T;
      }
      let text = '';
      try {
        text = await res.text();
      } catch {
        text = '';
      }
      const code = codeForStatus(res.status);
      const retryable = res.status === 429 || (kind === 'read' && res.status >= 500);
      if (retryable && !last) {
        const wait = res.status === 429 ? retryAfterMs(res.headers.get('retry-after')) : undefined;
        await sleep(wait ?? backoff);
        backoff *= 2;
        continue;
      }
      throw new LaxJobsError(res.status, code, registryMessage(text, res.status));
    }
  }

  return {
    async listJobs(params: ListJobsParams = {}) {
      const q = new URLSearchParams();
      if (params.track !== undefined) q.set('track', String(params.track));
      if (params.limit !== undefined) {
        if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)
          throw new LaxJobsError(0, 'invalid_input', 'limit must be an integer from 1 to 100');
        q.set('limit', String(params.limit));
      }
      if (params.offset !== undefined) {
        if (!Number.isInteger(params.offset) || params.offset < 0)
          throw new LaxJobsError(0, 'invalid_input', 'offset must be a non negative integer');
        q.set('offset', String(params.offset));
      }
      const qs = q.toString();
      return request<JobList>(`${base}/jobs${qs ? `?${qs}` : ''}`, { method: 'GET', headers: { accept: 'application/json' } }, 'read', '');
    },
    async getJob(id: string) {
      if (typeof id !== 'string' || id.trim() === '') throw new LaxJobsError(0, 'invalid_input', 'id is required');
      return request<Job>(`${base}/jobs/${encodeURIComponent(id)}`, { method: 'GET', headers: { accept: 'application/json' } }, 'read', 'job');
    },
    async submit(jobId: string, input: SubmissionInput) {
      checkSubmission(jobId, input);
      const body: SubmissionInput = {
        builder: input.builder,
        contact: input.contact,
        repo_or_patch_url: input.repo_or_patch_url,
        payout_address: input.payout_address,
        agent_did: input.agent_did,
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      };
      return request<Submission>(
        `${base}/jobs/${encodeURIComponent(jobId)}/submissions`,
        { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) },
        'submit',
        'submission',
      );
    },
  };
}
