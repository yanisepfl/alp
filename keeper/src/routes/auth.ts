import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";

import { env } from "../env";

function constantTimeMatch(presented: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(env.KEEPER_INBOUND_BEARER, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Accepts the token via Authorization: Bearer <tok> or ?token=<tok>.
 *  Constant-time compare on both paths. */
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
