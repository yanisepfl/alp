// Bearer-token middleware for /scan and /force. Accepts the token via
// either Authorization: Bearer <tok> header OR ?token=<tok> query param.
// The query-param fallback exists for orchestrators (KeeperHub) whose
// REST API stores headers under a runtime-unreadable schema — putting
// the token in the URL works around that without weakening auth (still
// requires constant-time compare against KEEPER_INBOUND_BEARER).
//
// Constant-time compare so length-leak-from-string-equality isn't a thing.

import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";

import { env } from "../env";

function constantTimeMatch(presented: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(env.KEEPER_INBOUND_BEARER, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function requireBearer(c: Context, next: Next): Promise<Response | void> {
  const authz = c.req.header("authorization");
  if (typeof authz === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(authz);
    if (m && constantTimeMatch(m[1]!)) {
      await next();
      return;
    }
  }
  const queryTok = c.req.query("token");
  if (typeof queryTok === "string" && constantTimeMatch(queryTok)) {
    await next();
    return;
  }
  return c.json({ error: "unauthorized" }, 401);
}
