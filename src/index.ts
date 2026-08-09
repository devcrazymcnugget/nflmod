export interface Env {
  USER_NOTIFICATION: KVNamespace;
  NFL_WRITE_TOKEN: string;
  DISCORD_WEBHOOK_URL?: string;
  BOT_API_KEY?: string;
}

const BOT_API_BASE = "http://crazys-stuff.de:49844";
const normalizeItemName = (name: string): string => name.trim().toLocaleLowerCase("de-DE");

type CloudStatus = {
  updatedAt: string;
  items: Record<string, any>;
};

type BotItem = {
  item_id: number;
  name: string;
  beschreibung?: string;
  wert?: number;
  anzahl?: number;
  verfuegbar_anzahl?: number;
  status?: string;
  kategorie?: string;
};

async function syncBotCatalog(env: Env): Promise<{ ok: boolean; synced: number; reason?: string }> {
  if (!env.BOT_API_KEY) return { ok: false, synced: 0, reason: "bot_api_key_missing" };
  let response: Response;
  try {
    response = await fetch(`${BOT_API_BASE}/api/items`, {
      headers: { "X-API-Key": env.BOT_API_KEY, "Accept": "application/json" },
    });
  } catch {
    return { ok: false, synced: 0, reason: "bot_api_unreachable" };
  }
  if (!response.ok) return { ok: false, synced: 0, reason: `bot_api_http_${response.status}` };
  const botItems = await response.json() as BotItem[];
  if (!Array.isArray(botItems)) return { ok: false, synced: 0, reason: "bot_api_invalid_response" };

  const stored = await env.USER_NOTIFICATION.get("nfl-loan-status");
  const status: CloudStatus = stored === null ? { updatedAt: "", items: {} } : JSON.parse(stored);
  if (!status.items || typeof status.items !== "object") status.items = {};
  const now = new Date().toISOString();
  let synced = 0;
  for (const botItem of botItems) {
    if (!botItem || typeof botItem.name !== "string" || !botItem.name.trim()) continue;
    const canonicalName = botItem.name.trim();
    const existingName = Object.keys(status.items)
      .find(name => normalizeItemName(name) === normalizeItemName(canonicalName));
    const key = existingName ?? canonicalName;
    const availableCount = Math.max(0, Number(botItem.verfuegbar_anzahl ?? botItem.anzahl ?? 0));
    if (!status.items[key]) {
      status.items[key] = {
        available: availableCount > 0,
        count: availableCount,
        iconId: "minecraft:barrier",
        updatedAt: now,
        lastChangedBy: "",
        borrowedBy: "",
      };
    }
    Object.assign(status.items[key], {
      botItemId: botItem.item_id,
      category: botItem.kategorie ?? "",
      description: botItem.beschreibung ?? "",
      value: botItem.wert ?? 0,
      totalCount: botItem.anzahl ?? 1,
      botStatus: botItem.status ?? "",
    });
    synced++;
  }
  status.updatedAt = now;
  await env.USER_NOTIFICATION.put("nfl-loan-status", JSON.stringify(status));
  await env.USER_NOTIFICATION.put("nfl-bot-sync-at", now);
  return { ok: true, synced };
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
      return jsonResponse({ ok: true, service: "nflmod-sync", botApi: BOT_API_BASE, botApiConfigured: Boolean(env.BOT_API_KEY) });
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

    if (request.method === "POST" && url.pathname === "/admin/catalog") {
      const authorization = request.headers.get("Authorization") ?? "";
      if (!env.NFL_WRITE_TOKEN || authorization !== `Bearer ${env.NFL_WRITE_TOKEN}`) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      let requestBody: unknown;
      try {
        requestBody = await request.json();
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }
      const catalog = (requestBody as { items?: unknown })?.items;
      if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
        return jsonResponse({ error: "invalid_catalog" }, 400);
      }
      if (env.BOT_API_KEY) await syncBotCatalog(env);
      const stored = await env.USER_NOTIFICATION.get("nfl-loan-status");
      const status = stored === null ? { updatedAt: "", items: {} as Record<string, any> } : JSON.parse(stored);
      if (!status.items || typeof status.items !== "object") status.items = {};
      const now = new Date().toISOString();
      let added = 0;
      for (const [name, raw] of Object.entries(catalog as Record<string, unknown>)) {
        if (!name || name.length > 256 || typeof raw !== "object" || raw === null) continue;
        const observed = raw as { count?: unknown; iconId?: unknown };
        const count = typeof observed.count === "number" && Number.isFinite(observed.count)
          ? Math.max(0, Math.floor(observed.count)) : 0;
        const iconId = typeof observed.iconId === "string" && observed.iconId.length <= 256
          ? observed.iconId : "minecraft:barrier";
        const canonicalName = Object.keys(status.items)
          .find(existing => normalizeItemName(existing) === normalizeItemName(name));
        if (env.BOT_API_KEY && !canonicalName) continue;
        const targetName = canonicalName ?? name;
        if (!status.items[targetName]) {
          status.items[targetName] = { available: count > 0, count, iconId, updatedAt: now, lastChangedBy: "", borrowedBy: "" };
          added++;
        } else if (iconId && iconId !== "minecraft:barrier") {
          status.items[targetName].iconId = iconId;
        }
      }
      status.updatedAt = now;
      await env.USER_NOTIFICATION.put("nfl-loan-status", JSON.stringify(status));
      return jsonResponse({ ok: true, added });
    }

    if (request.method === "POST" && url.pathname === "/admin/bot-sync") {
      const authorization = request.headers.get("Authorization") ?? "";
      if (!env.NFL_WRITE_TOKEN || authorization !== `Bearer ${env.NFL_WRITE_TOKEN}`) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const result = await syncBotCatalog(env);
      return jsonResponse(result, result.ok ? 200 : 502);
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

      const canonicalName = Object.keys(status.items ?? {})
        .find(name => normalizeItemName(name) === normalizeItemName(itemName));
      const item = canonicalName ? status.items?.[canonicalName] : undefined;
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
      return jsonResponse({ ok: true, itemName: canonicalName, count: newCount, available: item.available, playerName, webhookSent });
    }

    return jsonResponse({ error: "not_found" }, 404);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(syncBotCatalog(env));
  },
} satisfies ExportedHandler<Env>;
