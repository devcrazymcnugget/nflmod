export interface Env {
  USER_NOTIFICATION: KVNamespace;
  NFL_WRITE_TOKEN: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "nflmod-sync" });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const stored = await env.USER_NOTIFICATION.get("nfl-loan-status");
      if (stored === null) return jsonResponse({ updatedAt: "", items: {} });
      return new Response(stored, {
        status: 200,
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }

    if (request.method === "PUT" && url.pathname === "/status") {
      const authorization = request.headers.get("Authorization") ?? "";
      if (!env.NFL_WRITE_TOKEN || authorization !== `Bearer ${env.NFL_WRITE_TOKEN}`) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }

      const body = await request.text();
      if (body.length > 262_144) return jsonResponse({ error: "payload_too_large" }, 413);

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }

      if (
        typeof parsed !== "object" || parsed === null || !("items" in parsed) ||
        typeof (parsed as { items?: unknown }).items !== "object"
      ) {
        return jsonResponse({ error: "invalid_status" }, 400);
      }

      await env.USER_NOTIFICATION.put("nfl-loan-status", body);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
