export interface Env {
  USER_NOTIFICATION: KVNamespace;
  NFL_WRITE_TOKEN: string;
  DISCORD_WEBHOOK_URL?: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
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

    if (request.method === "POST" && url.pathname === "/event") {
      let event: unknown;
      try {
        event = await request.json();
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }

      if (typeof event !== "object" || event === null) {
        return jsonResponse({ error: "invalid_event" }, 400);
      }

      const { itemName, delta, iconId, playerName } = event as {
        itemName?: unknown;
        delta?: unknown;
        iconId?: unknown;
        playerName?: unknown;
      };
      if (
        typeof itemName !== "string" || itemName.length < 1 || itemName.length > 256 ||
        typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000 ||
        (iconId !== undefined && (typeof iconId !== "string" || iconId.length > 256)) ||
        typeof playerName !== "string" || playerName.length < 1 || playerName.length > 64
      ) {
        return jsonResponse({ error: "invalid_event" }, 400);
      }

      const stored = await env.USER_NOTIFICATION.get("nfl-loan-status");
      if (stored === null) return jsonResponse({ error: "status_not_initialized" }, 409);

      let status: {
        updatedAt?: string;
        items?: Record<string, {
          available?: boolean;
          count?: number;
          iconId?: string;
          updatedAt?: string;
          lastChangedBy?: string;
          borrowedBy?: string;
        }>;
      };
      try {
        status = JSON.parse(stored);
      } catch {
        return jsonResponse({ error: "stored_status_invalid" }, 500);
      }

      const item = status.items?.[itemName];
      if (!item) return jsonResponse({ error: "unknown_item" }, 404);

      const oldCount = typeof item.count === "number" && Number.isFinite(item.count) ? item.count : 0;
      const newCount = Math.max(0, Math.floor(oldCount + delta));
      const now = new Date().toISOString();
      item.count = newCount;
      item.available = newCount > 0;
      item.updatedAt = now;
      item.lastChangedBy = playerName;
      if (newCount === 0 && delta < 0) item.borrowedBy = playerName;
      if (newCount > 0) item.borrowedBy = "";
      if (typeof iconId === "string" && iconId.length > 0) item.iconId = iconId;
      status.updatedAt = now;

      await env.USER_NOTIFICATION.put("nfl-loan-status", JSON.stringify(status));

      let webhookSent = false;
      if (delta < 0 && env.DISCORD_WEBHOOK_URL) {
        try {
          const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({
              username: "NFL Kistenwächter",
              allowed_mentions: { parse: [] },
              embeds: [{
                title: "📦 Item ausgeliehen",
                description: "Ein Nutzer der NFL Public Mod hat ein eingetragenes Item entnommen.",
                color: 0xff9900,
                timestamp: now,
                fields: [
                  { name: "Spieler", value: playerName, inline: true },
                  { name: "Item", value: itemName, inline: true },
                  { name: "Anzahl", value: String(Math.abs(delta)), inline: true },
                  { name: "Verbleibend", value: String(newCount), inline: true },
                ],
                footer: { text: "NFLMOD Cloud • Minecraft 1.21.11" },
              }],
            }),
          });
          webhookSent = discordResponse.ok;
        } catch {
          webhookSent = false;
        }
      }
      return jsonResponse({ ok: true, itemName, count: newCount, available: item.available, playerName, webhookSent });
    }

    return jsonResponse({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
