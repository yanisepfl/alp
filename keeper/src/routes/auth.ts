// Bearer-token middleware factory for /scan and /force. Constant-time
// compare so length-leak-from-string-equality isn't a thing.

import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";

import { env } from "../env";

export async function requireBearer(c: Context, next: Next): Promise<Response | void> {
  const authz = c.req.header("authorization");
  if (typeof authz !== "string") {
    return c.json({ error: "unauthorized" }, 401);
  }
  const m = /^Bearer\s+(.+)$/i.exec(authz);
  if (!m) return c.json({ error: "unauthorized" }, 401);
  const presented = m[1]!;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(env.KEEPER_INBOUND_BEARER, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
}
