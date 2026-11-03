import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Optional shared-token authentication for the control panel.
 *
 * When UI_TOKEN is set, the page, its script and every /api call require the token, either as
 * `Authorization: Bearer <token>` / `x-ui-token: <token>` (for scripts and curl) or as the session
 * cookie set by the /login form (for the browser). The cookie holds an HMAC of the token rather than
 * the token itself, and is HttpOnly + SameSite=Strict so other sites can't ride on it.
 */

export const SESSION_COOKIE = "orca_panel_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const MAX_LOGIN_BODY_BYTES = 4_096;

/** Paths reachable without a session: the login form itself and the stylesheet it uses. */
const PUBLIC_PATHS = new Set(["/login", "/logout", "/styles.css"]);

/** Constant-time string comparison. Both sides are hashed first so their lengths never leak. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }

  return cookies;
}

/** True for addresses that are only reachable from this machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    /^127(\.\d{1,3}){3}$/.test(normalized)
  );
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function loginPage(error: string | null) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Sign in · Orca LP Dashboard</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="shell login-shell">
      <section class="panel login-card">
        <h1>Orca LP Dashboard</h1>
        <p class="muted">Enter the panel token (<code>UI_TOKEN</code>) to continue.</p>
        ${error ? `<p class="warning-note">${escapeHtml(error)}</p>` : ""}
        <form method="post" action="/login" class="login-form">
          <label>
            <span>Token</span>
            <input name="token" type="password" autocomplete="current-password" required autofocus />
          </label>
          <button class="play" type="submit">Sign in</button>
        </form>
      </section>
    </main>
  </body>
</html>`;
}

async function readFormBody(request: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_LOGIN_BODY_BYTES) {
      throw new Error("Login request body too large");
    }
    chunks.push(buffer);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export class PanelAuth {
  private readonly sessionValue: string;

  constructor(private readonly token: string) {
    if (!token) {
      throw new Error("PanelAuth requires a non-empty token");
    }
    this.sessionValue = createHmac("sha256", token).update("orca-panel-session-v1").digest("hex");
  }

  /** Accepts the bearer / x-ui-token header or a valid session cookie. */
  isAuthorized(request: IncomingMessage): boolean {
    const authorization = request.headers.authorization;
    if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
      return constantTimeEqual(authorization.slice(7).trim(), this.token);
    }

    const headerToken = request.headers["x-ui-token"];
    if (typeof headerToken === "string") {
      return constantTimeEqual(headerToken, this.token);
    }

    const cookie = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return typeof cookie === "string" && constantTimeEqual(cookie, this.sessionValue);
  }

  /**
   * Handles /login and /logout and blocks unauthenticated requests.
   * Returns true when it has already written the response; false means "authorized, carry on".
   */
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    const method = request.method ?? "GET";

    if (url.pathname === "/login") {
      if (method === "POST") {
        const form = await readFormBody(request);
        const submitted = form.get("token") ?? "";
        if (!constantTimeEqual(submitted, this.token)) {
          this.sendLoginPage(response, 401, "Invalid token.");
          return true;
        }

        response.writeHead(303, {
          location: "/",
          "set-cookie": this.cookie(this.sessionValue, SESSION_MAX_AGE_SECONDS),
          "cache-control": "no-store"
        });
        response.end();
        return true;
      }

      this.sendLoginPage(response, 200, null);
      return true;
    }

    if (url.pathname === "/logout") {
      response.writeHead(303, {
        location: "/login",
        "set-cookie": this.cookie("", 0),
        "cache-control": "no-store"
      });
      response.end();
      return true;
    }

    if (PUBLIC_PATHS.has(url.pathname) || this.isAuthorized(request)) {
      return false;
    }

    if (url.pathname.startsWith("/api/")) {
      response.writeHead(401, {
        "content-type": "application/json; charset=utf-8",
        "www-authenticate": 'Bearer realm="orca-panel"'
      });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return true;
    }

    response.writeHead(302, { location: "/login", "cache-control": "no-store" });
    response.end();
    return true;
  }

  private cookie(value: string, maxAgeSeconds: number) {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  }

  private sendLoginPage(response: ServerResponse, statusCode: number, error: string | null) {
    response.writeHead(statusCode, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    response.end(loginPage(error));
  }
}
