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
  containers?: TrackedContainer[];
};

type TrackedContainer = {
  dimension: string;
  x: number;
  y: number;
  z: number;
  label?: string;
  type?: string;
};

type PriceEntry = {
  name: string;
  material?: string;
  average: number;
  last: number;
  min: number;
  max: number;
  sales: number;
  lastSaleAt?: string;
};

async function syncBotLoanEvent(
  env: Env,
  itemName: string,
  minecraftName: string,
  delta: number,
  eventId: string,
): Promise<{ ok: boolean; reason?: string; status?: number; result?: unknown }> {
  if (!env.BOT_API_KEY) return { ok: false, reason: "bot_api_key_missing" };
  try {
    const response = await fetch(`${BOT_API_BASE}/api/minecraft/loan-event`, {
      method: "POST",
      headers: {
        "X-API-Key": env.BOT_API_KEY,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        item_name: itemName,
        minecraft_name: minecraftName,
        delta,
        event_id: eventId,
      }),
    });
    const result = await response.json().catch(() => null);
    return response.ok
      ? { ok: true, status: response.status, result }
      : { ok: false, status: response.status, reason: "bot_api_rejected_event", result };
  } catch {
    return { ok: false, reason: "bot_api_unreachable" };
  }
}

async function getPlayerLoans(env: Env, playerName: string): Promise<{ ok: boolean; loans: unknown[]; reason?: string }> {
  if (!env.BOT_API_KEY) return { ok: false, loans: [], reason: "bot_api_key_missing" };
  try {
    const headers = { "X-API-Key": env.BOT_API_KEY, "Accept": "application/json" };
    const [linksResponse, loansResponse] = await Promise.all([
      fetch(`${BOT_API_BASE}/api/minecraft/links`, { headers }),
      fetch(`${BOT_API_BASE}/api/loans`, { headers }),
    ]);
    if (!linksResponse.ok || !loansResponse.ok) {
      return { ok: false, loans: [], reason: `bot_api_http_${linksResponse.status}_${loansResponse.status}` };
    }
    const links = await linksResponse.json() as Array<{ minecraft_name?: string; user_id?: number }>;
    const loans = await loansResponse.json() as Array<{
      user_id?: number; item_name?: string; borrowed_at?: number; due_at?: number; returned_at?: number | null;
    }>;
    const link = Array.isArray(links) ? links.find(candidate =>
      typeof candidate.minecraft_name === "string" && normalizeItemName(candidate.minecraft_name) === normalizeItemName(playerName)) : undefined;
    if (!link || typeof link.user_id !== "number") return { ok: true, loans: [] };
    const active = Array.isArray(loans) ? loans
      .filter(loan => loan.user_id === link.user_id && (loan.returned_at === null || loan.returned_at === undefined))
      .map(loan => ({
        itemName: typeof loan.item_name === "string" ? loan.item_name : "Unbekanntes Item",
        borrowedAt: Number(loan.borrowed_at ?? 0),
        dueAt: Number(loan.due_at ?? 0),
      })) : [];
    return { ok: true, loans: active };
  } catch {
    return { ok: false, loans: [], reason: "bot_api_unreachable" };
  }
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

    if (request.method === "GET" && url.pathname === "/loans") {
      const playerName = (url.searchParams.get("playerName") ?? "").trim();
      if (!playerName || playerName.length > 64) return jsonResponse({ error: "invalid_player_name" }, 400);
      const result = await getPlayerLoans(env, playerName);
      return jsonResponse(result, result.ok ? 200 : 502);
    }

    if (request.method === "GET" && url.pathname === "/prices") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query || query.length > 128) return jsonResponse({ error: "invalid_query" }, 400);
      const stored = await env.USER_NOTIFICATION.get("opitems-price-index");
      if (stored === null) return jsonResponse({ ok: true, updatedAt: "", matches: [] });
      const index = JSON.parse(stored) as { updatedAt?: string; items?: PriceEntry[] };
      const wanted = normalizeItemName(query);
      const matches = (Array.isArray(index.items) ? index.items : [])
        .filter(item => normalizeItemName(item.name).includes(wanted))
        .sort((a, b) => {
          const aName = normalizeItemName(a.name);
          const bName = normalizeItemName(b.name);
          const aScore = aName === wanted ? 0 : aName.startsWith(wanted) ? 1 : 2;
          const bScore = bName === wanted ? 0 : bName.startsWith(wanted) ? 1 : 2;
          return aScore - bScore || b.sales - a.sales || aName.localeCompare(bName, "de");
        }).slice(0, 20);
      return jsonResponse({ ok: true, updatedAt: index.updatedAt ?? "", matches });
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
      const rawContainer = (requestBody as { container?: unknown })?.container;
      if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
        return jsonResponse({ error: "invalid_catalog" }, 400);
      }
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
        const targetName = canonicalName ?? name;
        if (!status.items[targetName]) {
          status.items[targetName] = { available: count > 0, count, iconId, updatedAt: now, lastChangedBy: "", borrowedBy: "" };
          added++;
        } else {
          if (iconId && iconId !== "minecraft:barrier") status.items[targetName].iconId = iconId;
          // Ein tatsächlich wieder in einer Admin-Kiste gefundenes Item ist eine
          // autoritative Rückgabe, selbst wenn ein Client-Ereignis verloren ging.
          if (count > 0 && status.items[targetName].available === false) {
            status.items[targetName].count = count;
            status.items[targetName].available = true;
            status.items[targetName].borrowedBy = "";
            status.items[targetName].updatedAt = now;
          }
        }
      }
      if (rawContainer !== undefined) {
        if (typeof rawContainer !== "object" || rawContainer === null) {
          return jsonResponse({ error: "invalid_container" }, 400);
        }
        const candidate = rawContainer as Partial<TrackedContainer>;
        if (typeof candidate.dimension !== "string" || candidate.dimension.length > 128 ||
            !Number.isSafeInteger(candidate.x) || !Number.isSafeInteger(candidate.y) || !Number.isSafeInteger(candidate.z)) {
          return jsonResponse({ error: "invalid_container" }, 400);
        }
        const tracked: TrackedContainer = {
          dimension: candidate.dimension,
          x: candidate.x as number,
          y: candidate.y as number,
          z: candidate.z as number,
          label: typeof candidate.label === "string" ? candidate.label.slice(0, 128) : "",
          type: typeof candidate.type === "string" ? candidate.type.slice(0, 32) : "",
        };
        if (!Array.isArray(status.containers)) status.containers = [];
        const existing = status.containers.findIndex((container: TrackedContainer) =>
          container.dimension === tracked.dimension && container.x === tracked.x &&
          container.y === tracked.y && container.z === tracked.z);
        if (existing >= 0) status.containers[existing] = tracked;
        else status.containers.push(tracked);
      }
      status.updatedAt = now;
      await env.USER_NOTIFICATION.put("nfl-loan-status", JSON.stringify(status));
      return jsonResponse({ ok: true, added });
    }

    if (request.method === "POST" && url.pathname === "/admin/containers") {
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
      const rawContainers = (requestBody as { containers?: unknown })?.containers;
      if (!Array.isArray(rawContainers) || rawContainers.length > 10_000) {
        return jsonResponse({ error: "invalid_containers" }, 400);
      }
      const containers: TrackedContainer[] = [];
      for (const raw of rawContainers) {
        if (typeof raw !== "object" || raw === null) return jsonResponse({ error: "invalid_container" }, 400);
        const candidate = raw as Partial<TrackedContainer>;
        if (typeof candidate.dimension !== "string" || candidate.dimension.length > 128 ||
            !Number.isSafeInteger(candidate.x) || !Number.isSafeInteger(candidate.y) || !Number.isSafeInteger(candidate.z)) {
          return jsonResponse({ error: "invalid_container" }, 400);
        }
        containers.push({
          dimension: candidate.dimension,
          x: candidate.x as number,
          y: candidate.y as number,
          z: candidate.z as number,
          label: typeof candidate.label === "string" ? candidate.label.slice(0, 128) : "",
          type: typeof candidate.type === "string" ? candidate.type.slice(0, 32) : "",
        });
      }
      const stored = await env.USER_NOTIFICATION.get("nfl-loan-status");
      const status: CloudStatus = stored === null ? { updatedAt: "", items: {} } : JSON.parse(stored);
      status.containers = containers;
      status.updatedAt = new Date().toISOString();
      await env.USER_NOTIFICATION.put("nfl-loan-status", JSON.stringify(status));
      return jsonResponse({ ok: true, containers: containers.length });
    }

    if (request.method === "PUT" && url.pathname === "/admin/prices") {
      const authorization = request.headers.get("Authorization") ?? "";
      if (!env.NFL_WRITE_TOKEN || authorization !== `Bearer ${env.NFL_WRITE_TOKEN}`) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      const body = await request.text();
      if (body.length > 8_000_000) return jsonResponse({ error: "payload_too_large" }, 413);
      let parsed: { updatedAt?: unknown; items?: unknown };
      try {
        parsed = JSON.parse(body);
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }
      if (!Array.isArray(parsed.items) || parsed.items.length > 50_000) {
        return jsonResponse({ error: "invalid_price_index" }, 400);
      }
      const items: PriceEntry[] = [];
      for (const raw of parsed.items) {
        if (typeof raw !== "object" || raw === null) continue;
        const item = raw as Partial<PriceEntry>;
        if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 256) continue;
        const numbers = [item.average, item.last, item.min, item.max, item.sales];
        if (numbers.some(value => typeof value !== "number" || !Number.isFinite(value) || value < 0)) continue;
        items.push({
          name: item.name.trim(), material: typeof item.material === "string" ? item.material.slice(0, 128) : "",
          average: Math.round(item.average as number), last: Math.round(item.last as number),
          min: Math.round(item.min as number), max: Math.round(item.max as number),
          sales: Math.floor(item.sales as number),
          lastSaleAt: typeof item.lastSaleAt === "string" ? item.lastSaleAt.slice(0, 64) : "",
        });
      }
      const payload = JSON.stringify({
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(), items,
      });
      await env.USER_NOTIFICATION.put("opitems-price-index", payload);
      return jsonResponse({ ok: true, items: items.length });
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

      const { itemName, delta, iconId, playerName, dimension, x, y, z } = event as {
        itemName?: unknown;
        delta?: unknown;
        iconId?: unknown;
        playerName?: unknown;
        dimension?: unknown;
        x?: unknown;
        y?: unknown;
        z?: unknown;
      };
      if (
        typeof itemName !== "string" || itemName.length < 1 || itemName.length > 256 ||
        typeof delta !== "number" || !Number.isSafeInteger(delta) || delta === 0 || Math.abs(delta) > 100_000 ||
        (iconId !== undefined && (typeof iconId !== "string" || iconId.length > 256)) ||
        typeof playerName !== "string" || playerName.length < 1 || playerName.length > 64 ||
        typeof dimension !== "string" || dimension.length < 1 || dimension.length > 128 ||
        typeof x !== "number" || !Number.isSafeInteger(x) ||
        typeof y !== "number" || !Number.isSafeInteger(y) ||
        typeof z !== "number" || !Number.isSafeInteger(z)
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

      const allowedContainer = ((status as CloudStatus).containers ?? []).some(container =>
        container.dimension === dimension && container.x === x && container.y === y && container.z === z);
      if (!allowedContainer) return jsonResponse({ error: "container_not_registered" }, 403);

      const canonicalName = Object.keys(status.items ?? {})
        .find(name => normalizeItemName(name) === normalizeItemName(itemName));
      const item = canonicalName ? status.items?.[canonicalName] : undefined;
      if (!item) return jsonResponse({ error: "unknown_item" }, 404);
      const matchedItemName = canonicalName as string;

      const oldCount = typeof item.count === "number" && Number.isFinite(item.count) ? item.count : 0;
      const newCount = Math.max(0, Math.floor(oldCount + delta));
      const now = new Date().toISOString();
      const previousBorrower = typeof item.borrowedBy === "string" ? item.borrowedBy : "";
      const borrowedByPlayer = Object.values(status.items ?? {}).filter(candidate =>
        candidate?.available === false &&
        typeof candidate.borrowedBy === "string" &&
        normalizeItemName(candidate.borrowedBy) === normalizeItemName(playerName)
      ).length;
      const isNewLoan = delta < 0 && item.available !== false;
      const limitWarning = isNewLoan && borrowedByPlayer >= 4;
      const limitMessage = limitWarning
        ? `NFLMod -> Du darfst nicht mehr als 4 Items ausleihen lege ${matchedItemName} zurück um eine Strafe zu umgehen!`
        : "";
      const eventId = crypto.randomUUID();
      item.count = newCount;
      item.available = newCount > 0;
      item.updatedAt = now;
      item.lastChangedBy = playerName;
      if (newCount === 0 && delta < 0) item.borrowedBy = playerName;
      if (newCount > 0) item.borrowedBy = "";
      if (typeof iconId === "string" && iconId.length > 0) item.iconId = iconId;
      status.updatedAt = now;

      await env.USER_NOTIFICATION.put("nfl-loan-status", JSON.stringify(status));

      const botSync = await syncBotLoanEvent(
        env,
        matchedItemName,
        delta < 0 ? playerName : (previousBorrower || playerName),
        delta,
        eventId,
      );

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
      return jsonResponse({
        ok: true,
        eventId,
        itemName: matchedItemName,
        count: newCount,
        available: item.available,
        playerName,
        webhookSent,
        botSync,
        limitWarning,
        limitMessage,
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
