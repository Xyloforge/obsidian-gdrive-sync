export interface HttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
}

export interface HttpResponse {
  status: number;
  /** Header names lower-cased. */
  readonly headers: Record<string, string>;
  readonly text: string;
  readonly json: unknown;
  readonly arrayBuffer: ArrayBuffer;
}

/** Never throws on HTTP status; callers check `status`. */
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** Short, safe error text from a Google API error response. */
export function describeError(res: HttpResponse): string {
  try {
    const j = res.json as { error?: { message?: string } | string; error_description?: string };
    if (typeof j.error === "object" && j.error?.message) return j.error.message;
    if (j.error_description) return j.error_description;
    if (typeof j.error === "string") return j.error;
  } catch {
    // Body is not JSON; fall through.
  }
  return `HTTP ${res.status}`;
}
