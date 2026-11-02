import type { HttpFn, HttpRequest, HttpResponse } from "../src/http.ts";

interface FakeFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  trashed: boolean;
  modifiedTime: string;
  appProperties: Record<string, string>;
  data: Uint8Array;
}

const dec = new TextDecoder();

function respond(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  const isBuf = body instanceof Uint8Array;
  const text = isBuf ? dec.decode(body) : JSON.stringify(body);
  return {
    status,
    headers,
    text,
    get json() { return JSON.parse(text); },
    get arrayBuffer() {
      const bytes = isBuf ? body : new TextEncoder().encode(text);
      return bytes.slice().buffer as ArrayBuffer;
    },
  };
}

/** Parses our multipart/related body back into metadata + bytes. */
function parseMultipart(req: HttpRequest): { meta: Record<string, unknown>; data: Uint8Array } {
  const boundary = /boundary=(.+)$/.exec(req.contentType ?? "")![1];
  const bytes = new Uint8Array(req.body as ArrayBuffer);
  const text = dec.decode(bytes);
  const metaStart = text.indexOf("\r\n\r\n") + 4;
  const metaEnd = text.indexOf(`\r\n--${boundary}`, metaStart);
  const meta = JSON.parse(text.slice(metaStart, metaEnd));
  // Find the data section in bytes (data may be binary).
  const enc = new TextEncoder();
  const headerBytes = enc.encode(text.slice(0, text.indexOf("\r\n\r\n", metaEnd) + 4)).length;
  const tailBytes = enc.encode(`\r\n--${boundary}--`).length;
  return { meta, data: bytes.slice(headerBytes, bytes.length - tailBytes) };
}

/** A tiny in-memory stand-in for Google's OAuth + Drive v3 endpoints. */
export class FakeGoogle {
  files = new Map<string, FakeFile>();
  requests: string[] = [];
  validTokens = new Set<string>();
  /** Fail the next N Drive requests with this status. */
  failNext: { status: number; count: number } = { status: 0, count: 0 };
  revoked = false;
  pendingPolls = 1;
  private seq = 0;
  private sessions = new Map<string, { meta: Record<string, unknown>; id?: string }>();
  private tick = 0;

  readonly http: HttpFn = async (req) => this.handle(req);

  private now(): string { return new Date(Date.UTC(2026, 10, 2, 0, 0, this.tick++)).toISOString(); }

  private handle(req: HttpRequest): HttpResponse {
    const method = req.method ?? "GET";
    const url = new URL(req.url);
    this.requests.push(`${method} ${url.pathname}`);
    if (url.host === "oauth2.googleapis.com") return this.oauth(url.pathname, new URLSearchParams(req.body as string));

    const auth = req.headers?.Authorization?.replace("Bearer ", "") ?? "";
    if (!this.validTokens.has(auth)) return respond(401, { error: { message: "Invalid Credentials" } });
    if (this.failNext.count > 0) {
      this.failNext.count--;
      return respond(this.failNext.status, { error: { message: "fake failure" } });
    }
    return this.drive(method, url, req);
  }

  private oauth(path: string, p: URLSearchParams): HttpResponse {
    if (path === "/device/code") {
      return respond(200, { device_code: "DEV", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", interval: 5, expires_in: 1800 });
    }
    if (p.get("grant_type")?.endsWith("device_code")) {
      if (this.pendingPolls-- > 0) return respond(428, { error: "authorization_pending" });
      return respond(200, { access_token: "tok0", refresh_token: "REFRESH", expires_in: 3600 });
    }
    if (this.revoked) return respond(400, { error: "invalid_grant" });
    const tok = `tok${++this.seq}`;
    this.validTokens.add(tok);
    return respond(200, { access_token: tok, expires_in: 3600 });
  }

  private drive(method: string, url: URL, req: HttpRequest): HttpResponse {
    const idMatch = /\/files\/([^/]+)$/.exec(url.pathname);
    const id = idMatch?.[1];
    if (url.pathname.startsWith("/upload/") && url.searchParams.get("uploadType") === "resumable") {
      const session = `s${++this.seq}`;
      this.sessions.set(session, { meta: JSON.parse(req.body as string), id });
      return respond(200, {}, { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${session}` });
    }
    if (method === "PUT" && url.searchParams.get("upload_id")) {
      const sess = this.sessions.get(url.searchParams.get("upload_id")!)!;
      return this.store(sess.meta, new Uint8Array(req.body as ArrayBuffer), sess.id);
    }
    if (url.pathname.startsWith("/upload/")) {
      const { meta, data } = parseMultipart(req);
      return this.store(meta, data, method === "POST" ? undefined : id);
    }
    return this.metadata(method, url, req, id);
  }

  private store(meta: Record<string, unknown>, data: Uint8Array, id?: string): HttpResponse {
    {
      if (!id) {
        const f: FakeFile = {
          id: `f${++this.seq}`, name: String(meta.name), parents: meta.parents as string[],
          mimeType: "application/octet-stream", trashed: false, modifiedTime: (meta.modifiedTime as string | undefined) ?? this.now(),
          appProperties: (meta.appProperties ?? {}) as Record<string, string>, data,
        };
        this.files.set(f.id, f);
        return respond(200, { id: f.id });
      }
      const f = this.files.get(id)!;
      this.files.set(f.id, { ...f, data, modifiedTime: (meta.modifiedTime as string | undefined) ?? this.now(), appProperties: { ...f.appProperties, ...(meta.appProperties as object) } });
      return respond(200, { id: f.id });
    }
  }

  private metadata(method: string, url: URL, req: HttpRequest, id?: string): HttpResponse {
    if (method === "GET" && id) {
      return url.searchParams.get("alt") === "media" ? respond(200, this.files.get(id)!.data) : respond(200, this.files.get(id));
    }
    if (method === "GET") return respond(200, { files: this.query(url.searchParams.get("q") ?? "") });
    if (method === "POST") {
      const meta = JSON.parse(req.body as string);
      const f: FakeFile = { id: `d${++this.seq}`, name: meta.name, parents: meta.parents, mimeType: meta.mimeType, trashed: false, modifiedTime: this.now(), appProperties: {}, data: new Uint8Array() };
      this.files.set(f.id, f);
      return respond(200, { id: f.id });
    }
    if (method === "PATCH" && id) {
      const f = this.files.get(id)!;
      this.files.set(id, { ...f, ...JSON.parse(req.body as string) });
      return respond(200, { id });
    }
    return respond(404, { error: { message: "not found" } });
  }

  private query(q: string): object[] {
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    const name = /name='((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
    const folderOnly = q.includes("mimeType='application/vnd.google-apps.folder'");
    return [...this.files.values()]
      .filter((f) => !f.trashed && (!parent || f.parents.includes(parent)))
      .filter((f) => (name === undefined || f.name === name) && (!folderOnly || f.mimeType.endsWith("folder")))
      .map(({ id, name: n, modifiedTime, appProperties }) => ({ id, name: n, modifiedTime, appProperties }));
  }

  /** Visible (non-trashed) files in a folder, as path -> text. */
  contents(folderName: string): Record<string, string> {
    const folder = [...this.files.values()].find((f) => f.name === folderName && !f.trashed);
    if (!folder) return {};
    return Object.fromEntries(
      [...this.files.values()]
        .filter((f) => !f.trashed && f.parents.includes(folder.id))
        .map((f) => [f.name, dec.decode(f.data)]),
    );
  }
}
