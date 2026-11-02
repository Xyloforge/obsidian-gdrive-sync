import { describeError, formBody, HttpError, type HttpFn } from "./http.ts";

const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Access only to files this plugin creates — not the rest of your Drive. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FORM = "application/x-www-form-urlencoded";
const EXPIRY_MARGIN_MS = 60_000;

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalSec: number;
  expiresInSec: number;
}

/** The saved sign-in is no longer valid; user must connect again. */
export class AuthExpiredError extends Error {
  constructor() {
    super("Google sign-in expired or was revoked. Open plugin settings and connect again.");
    this.name = "AuthExpiredError";
  }
}

export async function startDeviceFlow(http: HttpFn, c: ClientCredentials): Promise<DeviceCode> {
  const res = await http({
    url: DEVICE_URL, method: "POST", contentType: FORM,
    body: formBody({ client_id: c.clientId, scope: DRIVE_SCOPE }),
  });
  if (res.status !== 200) throw new HttpError(res.status, `Could not start Google sign-in: ${describeError(res)}`);
  const j = res.json as Record<string, unknown>;
  return {
    deviceCode: String(j.device_code),
    userCode: String(j.user_code),
    verificationUrl: String(j.verification_url ?? j.verification_uri),
    intervalSec: Number(j.interval ?? 5),
    expiresInSec: Number(j.expires_in ?? 1800),
  };
}

export interface PollOptions {
  sleep: (ms: number) => Promise<void>;
  isCancelled: () => boolean;
}

/** Waits until the user approves on google.com/device; returns the refresh token. */
export async function pollForRefreshToken(
  http: HttpFn, c: ClientCredentials, dc: DeviceCode, opts: PollOptions,
): Promise<string> {
  let interval = dc.intervalSec;
  const tries = Math.ceil(dc.expiresInSec / interval);
  for (let i = 0; i < tries && !opts.isCancelled(); i++) {
    await opts.sleep(interval * 1000);
    if (opts.isCancelled()) break;
    let res;
    try {
      res = await http({
        url: TOKEN_URL, method: "POST", contentType: FORM,
        body: formBody({ client_id: c.clientId, client_secret: c.clientSecret, device_code: dc.deviceCode, grant_type: DEVICE_GRANT }),
      });
    } catch {
      // No network. On Android this is normal while the user approves in the
      // browser: the phone cuts network for apps in the background. Keep
      // waiting; the next check works once they return to Obsidian.
      continue;
    }
    if (res.status >= 500) continue; // Google hiccup: try again next interval
    const j = res.json as Record<string, unknown>;
    if (res.status === 200 && typeof j.refresh_token === "string") return j.refresh_token;
    if (j.error === "authorization_pending") continue;
    if (j.error === "slow_down") { interval += 5; continue; }
    throw new HttpError(res.status, `Google sign-in failed: ${describeError(res)}`);
  }
  throw new Error(opts.isCancelled() ? "Sign-in cancelled." : "Sign-in code expired. Try again.");
}

/** Hands out a valid access token, refreshing it when needed. */
export class TokenProvider {
  private accessToken = "";
  private expiresAt = 0;
  private readonly http: HttpFn;
  private readonly creds: ClientCredentials;
  private readonly refreshToken: string;
  private readonly clock: () => number;

  constructor(http: HttpFn, creds: ClientCredentials, refreshToken: string, clock: () => number = Date.now) {
    this.http = http;
    this.creds = creds;
    this.refreshToken = refreshToken;
    this.clock = clock;
  }

  async get(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && this.clock() < this.expiresAt - EXPIRY_MARGIN_MS) {
      return this.accessToken;
    }
    const res = await this.http({
      url: TOKEN_URL, method: "POST", contentType: FORM,
      body: formBody({
        client_id: this.creds.clientId, client_secret: this.creds.clientSecret,
        refresh_token: this.refreshToken, grant_type: "refresh_token",
      }),
    });
    const j = res.json as Record<string, unknown>;
    if (res.status === 400 && j.error === "invalid_grant") throw new AuthExpiredError();
    if (res.status !== 200 || typeof j.access_token !== "string") {
      throw new HttpError(res.status, `Could not refresh Google token: ${describeError(res)}`);
    }
    this.accessToken = j.access_token;
    this.expiresAt = this.clock() + Number(j.expires_in ?? 3600) * 1000;
    return this.accessToken;
  }
}
