import { randomUUID, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { ZodError, type ZodType } from "zod";
import { AppError } from "../app/errors.ts";

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  req: IncomingMessage;
  /** Parsed and validated JSON body (undefined when no schema). */
  body: any;
  raw: () => Promise<Buffer>;
}
export type Handler = (c: Ctx) => unknown | Promise<unknown>;
interface Route { method: string; re: RegExp; keys: string[]; handler: Handler; schema?: ZodType; rawBody?: boolean }

export class Router {
  private readonly routes: Route[] = [];
  route(method: string, path: string, handler: Handler, opts: { schema?: ZodType; raw?: boolean } = {}): void {
    const keys: string[] = [];
    const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k: string) => { keys.push(k); return "([^/]+)"; }) + "/?$");
    this.routes.push({ method, re, keys, handler, schema: opts.schema, rawBody: opts.raw });
  }
  match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | undefined {
    let pathHit = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathHit = true;
      if (r.method !== method) continue;
      return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)])) };
    }
    return pathHit ? "method" : undefined;
  }
}

const MAX_JSON = 1 << 20;
const MAX_UPLOAD = 200 << 20;

const send = (res: ServerResponse, status: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};
const fail = (res: ServerResponse, status: number, code: string, message: string) => send(res, status, { error: { code, message } });

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) throw new AppError(413, "payload_too_large", `body exceeds ${limit} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function serve(router: Router, opts: { token: string; publicPaths?: string[] }): Server {
  const token = opts.token.trim();
  if (!token) throw new Error("bearer token must not be empty");
  const want = Buffer.from(token);
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      if (!opts.publicPaths?.includes(path)) {
        const authorization = req.headers.authorization;
        const prefix = "Bearer ";
        if (!authorization?.startsWith(prefix)) return fail(res, 401, "unauthorized", "missing or invalid bearer token");
        const got = Buffer.from(authorization.slice(prefix.length));
        if (got.length !== want.length || !timingSafeEqual(got, want)) return fail(res, 401, "unauthorized", "missing or invalid bearer token");
      }
      const m = router.match(req.method ?? "GET", path);
      if (!m) return fail(res, 404, "not_found", `no route ${path}`);
      if (m === "method") return fail(res, 405, "method_not_allowed", `${req.method} not allowed on ${path}`);
      const { route, params } = m;
      let body: unknown;
      let rawCache: Promise<Buffer> | undefined;
      const raw = () => (rawCache ??= readBody(req, route.rawBody ? MAX_UPLOAD : MAX_JSON));
      if (route.schema) {
        const buf = await raw();
        let json: unknown = {};
        if (buf.length) { try { json = JSON.parse(buf.toString("utf8")); } catch { return fail(res, 400, "invalid_json", "body is not valid JSON"); } }
        body = route.schema.parse(json);
      }
      const out = await route.handler({ params, query: url.searchParams, req, body, raw });
      const status = (out as { __status?: number } | undefined)?.__status;
      if (status) { const { __status, ...rest } = out as Record<string, unknown>; return send(res, status, rest); }
      send(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof AppError) return fail(res, e.status, e.code, e.message);
      if (e instanceof ZodError) return fail(res, 400, "invalid_request", e.issues.map(i => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
      console.error(JSON.stringify({
        level: "error",
        event: "http_unexpected_error",
        requestId,
        method: req.method ?? "GET",
        path: (req.url ?? "/").split("?", 1)[0],
        error: { name: e instanceof Error ? e.name : "UnknownError", message: e instanceof Error ? e.message : String(e) },
      }));
      fail(res, 500, "internal_error", "unexpected error");
    }
  });
}
