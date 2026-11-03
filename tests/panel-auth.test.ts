import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { constantTimeEqual, isLoopbackHost, PanelAuth, parseCookies, SESSION_COOKIE } from "../src/panelAuth.js";

const TOKEN = "test-panel-token";

describe("panel auth helpers", () => {
  it("compares tokens without depending on length", () => {
    expect(constantTimeEqual(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEqual(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(constantTimeEqual("", TOKEN)).toBe(false);
  });

  it("parses cookie headers", () => {
    expect(parseCookies("a=1; orca_panel_session=abc%3D; b")).toEqual({ a: "1", orca_panel_session: "abc=" });
    expect(parseCookies(undefined)).toEqual({});
  });

  it("recognises loopback bind addresses", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.com"]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });

  it("refuses an empty token", () => {
    expect(() => new PanelAuth("")).toThrow();
  });
});

describe("PanelAuth request gate", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const auth = new PanelAuth(TOKEN);
    server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await auth.handle(request, response, url)) {
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`ok ${url.pathname}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects /api calls without credentials", async () => {
    const response = await fetch(`${baseUrl}/api/status`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects a wrong token", async () => {
    const response = await fetch(`${baseUrl}/api/status`, { headers: { authorization: "Bearer nope" } });
    expect(response.status).toBe(401);
  });

  it("accepts the token as a bearer or x-ui-token header", async () => {
    const bearer = await fetch(`${baseUrl}/api/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bearer.status).toBe(200);
    const custom = await fetch(`${baseUrl}/api/status`, { headers: { "x-ui-token": TOKEN } });
    expect(custom.status).toBe(200);
  });

  it("redirects the page to the login form and leaves the stylesheet public", async () => {
    const page = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login");

    const script = await fetch(`${baseUrl}/app.js`, { redirect: "manual" });
    expect(script.status).toBe(302);

    const styles = await fetch(`${baseUrl}/styles.css`);
    expect(styles.status).toBe(200);

    const login = await fetch(`${baseUrl}/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain('name="token"');
  });

  it("issues an HttpOnly session cookie on login that then authorises /api calls", async () => {
    const failed = await fetch(`${baseUrl}/login`, {
      method: "POST",
      body: new URLSearchParams({ token: "wrong" }),
      redirect: "manual"
    });
    expect(failed.status).toBe(401);
    expect(failed.headers.get("set-cookie")).toBeNull();

    const login = await fetch(`${baseUrl}/login`, {
      method: "POST",
      body: new URLSearchParams({ token: TOKEN }),
      redirect: "manual"
    });
    expect(login.status).toBe(303);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain(TOKEN);

    const cookie = setCookie.split(";")[0];
    const api = await fetch(`${baseUrl}/api/status`, { headers: { cookie } });
    expect(api.status).toBe(200);
    expect(await api.text()).toBe("ok /api/status");

    const forged = await fetch(`${baseUrl}/api/status`, { headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect(forged.status).toBe(401);
  });

  it("clears the cookie on logout", async () => {
    const response = await fetch(`${baseUrl}/logout`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
