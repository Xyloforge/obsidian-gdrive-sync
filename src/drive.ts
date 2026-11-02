import type { RemoteStore } from "./engine.ts";
import { describeError, HttpError, type HttpFn, type HttpRequest, type HttpResponse } from "./http.ts";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const LIST_FIELDS = "nextPageToken,files(id,name,modifiedTime,appProperties)";
const MAX_ATTEMPTS = 4;
/** Drive's limit for single-request (multipart) uploads. */
const MULTIPART_LIMIT = 5 * 1024 * 1024;

export interface TokenSource {
  get(forceRefresh?: boolean): Promise<string>;
}

interface DriveFile {
  id: string;
  name: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
}

export interface DriveOptions {
  sleep?: (ms: number) => Promise<void>;
}

const escapeQuery = (s: string): string => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export function multipartBody(meta: object, data: ArrayBuffer): { body: ArrayBuffer; contentType: string } {
  const boundary = `gds_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const out = new Uint8Array(head.length + data.byteLength + tail.length);
  out.set(head, 0);
  out.set(new Uint8Array(data), head.length);
  out.set(tail, head.length + data.byteLength);
  return { body: out.buffer, contentType: `multipart/related; boundary=${boundary}` };
}

/**
 * Drive folder as a flat store: each vault file is one Drive file whose name is
 * the vault-relative path. The content hash is kept in appProperties.sha256.
 */
export class GoogleDriveStore implements RemoteStore {
  private readonly http: HttpFn;
  private readonly tokens: TokenSource;
  private readonly folderName: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private folderId = "";
  private ids = new Map<string, string>();
  private times = new Map<string, number>();

  constructor(http: HttpFn, tokens: TokenSource, folderName: string, opts: DriveOptions = {}) {
    this.http = http;
    this.tokens = tokens;
    this.folderName = folderName;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Authorized request with token refresh on 401 and backoff on 429/5xx. */
  private async call(req: HttpRequest, what: string): Promise<HttpResponse> {
    let forceRefresh = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.tokens.get(forceRefresh);
      const res = await this.http({ ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } });
      if (res.status >= 200 && res.status < 300) return res;
      const retryable = res.status === 401 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        throw new HttpError(res.status, `${what}: ${describeError(res)}`);
      }
      forceRefresh = res.status === 401;
      if (!forceRefresh) await this.sleep(500 * 2 ** attempt);
    }
  }

  /** Names of sync folders in My Drive. With drive.file, only folders this app created are visible. */
  async listSyncFolders(): Promise<string[]> {
    const q = `mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
    const res = await this.call({ url: `${API}?q=${encodeURIComponent(q)}&fields=files(name)` }, "List sync folders");
    return [...new Set((res.json as { files: { name: string }[] }).files.map((f) => f.name))];
  }

  private async ensureFolder(): Promise<string> {
    if (this.folderId) return this.folderId;
    const q = `name='${escapeQuery(this.folderName)}' and mimeType='${FOLDER_MIME}' and 'root' in parents and trashed=false`;
    const found = await this.call({ url: `${API}?q=${encodeURIComponent(q)}&fields=files(id)` }, "Find sync folder");
    const files = (found.json as { files: { id: string }[] }).files;
    if (files.length > 0) {
      this.folderId = files[0].id;
      return this.folderId;
    }
    const created = await this.call({
      url: `${API}?fields=id`, method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: this.folderName, mimeType: FOLDER_MIME, parents: ["root"] }),
    }, "Create sync folder");
    this.folderId = (created.json as { id: string }).id;
    return this.folderId;
  }

  private async listAll(folderId: string): Promise<DriveFile[]> {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
    const out: DriveFile[] = [];
    let pageToken = "";
    do {
      const page = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const res = await this.call({ url: `${API}?q=${q}&pageSize=1000&fields=${encodeURIComponent(LIST_FIELDS)}${page}` }, "List Drive files");
      const j = res.json as { files: DriveFile[]; nextPageToken?: string };
      out.push(...j.files);
      pageToken = j.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }

  async list(): Promise<Map<string, string>> {
    const files = await this.listAll(await this.ensureFolder());
    // If two devices created the same path at once, use the newest copy.
    const sorted = [...files].sort((a, b) => (a.modifiedTime ?? "").localeCompare(b.modifiedTime ?? ""));
    const ids = new Map<string, string>();
    const hashes = new Map<string, string>();
    const times = new Map<string, number>();
    for (const f of sorted) {
      ids.set(f.name, f.id);
      const t = f.modifiedTime ? Date.parse(f.modifiedTime) : NaN;
      if (!Number.isNaN(t)) times.set(f.name, t);
      hashes.set(f.name, f.appProperties?.sha256 ?? `unknown:${f.id}:${f.modifiedTime}`);
    }
    this.ids = ids;
    this.times = times;
    return hashes;
  }

  modifiedTime(path: string): number | undefined {
    return this.times.get(path);
  }

  private idOf(path: string): string {
    const id = this.ids.get(path);
    if (!id) throw new Error(`Not in Drive: ${path}`);
    return id;
  }

  async read(path: string): Promise<ArrayBuffer> {
    const res = await this.call({ url: `${API}/${this.idOf(path)}?alt=media` }, `Download ${path}`);
    return res.arrayBuffer;
  }

  async write(path: string, data: ArrayBuffer, hash: string, modified?: number): Promise<void> {
    const existing = this.ids.get(path);
    // Drive keeps the note's real edit time, so other devices can restore it.
    const time = modified === undefined ? {} : { modifiedTime: new Date(modified).toISOString() };
    const meta = existing
      ? { appProperties: { sha256: hash }, ...time }
      : { name: path, parents: [await this.ensureFolder()], appProperties: { sha256: hash }, ...time };
    const id = data.byteLength > MULTIPART_LIMIT
      ? await this.resumableUpload(path, meta, data, existing)
      : await this.multipartUpload(path, meta, data, existing);
    this.ids = new Map(this.ids).set(path, id);
  }

  private async multipartUpload(path: string, meta: object, data: ArrayBuffer, existing?: string): Promise<string> {
    const { body, contentType } = multipartBody(meta, data);
    const url = existing
      ? `${UPLOAD}/${existing}?uploadType=multipart&fields=id`
      : `${UPLOAD}?uploadType=multipart&fields=id`;
    const res = await this.call({ url, method: existing ? "PATCH" : "POST", body, contentType }, `Upload ${path}`);
    return (res.json as { id: string }).id;
  }

  /** Two steps: start a session (metadata), then send the bytes to the session URL. */
  private async resumableUpload(path: string, meta: object, data: ArrayBuffer, existing?: string): Promise<string> {
    const url = existing
      ? `${UPLOAD}/${existing}?uploadType=resumable&fields=id`
      : `${UPLOAD}?uploadType=resumable&fields=id`;
    const start = await this.call({
      url, method: existing ? "PATCH" : "POST", contentType: "application/json; charset=UTF-8",
      headers: { "X-Upload-Content-Type": "application/octet-stream", "X-Upload-Content-Length": String(data.byteLength) },
      body: JSON.stringify(meta),
    }, `Start upload ${path}`);
    const session = start.headers.location;
    if (!session) throw new Error(`Upload ${path}: Drive did not return an upload address`);
    const res = await this.call({ url: session, method: "PUT", contentType: "application/octet-stream", body: data }, `Upload ${path}`);
    return (res.json as { id: string }).id;
  }

  /** Moves to Drive trash (recoverable for 30 days). */
  async remove(path: string): Promise<void> {
    await this.call({
      url: `${API}/${this.idOf(path)}?fields=id`, method: "PATCH", contentType: "application/json",
      body: JSON.stringify({ trashed: true }),
    }, `Delete ${path}`);
    const next = new Map(this.ids);
    next.delete(path);
    this.ids = next;
  }
}
