const HISTORY_URL = "https://raw.githubusercontent.com/moppel30/opsuchtshards/main/auction-history.json";
const WORKER_URL = process.env.NFL_WORKER_URL ?? "https://nflmod.lucakupisch.workers.dev";
const token = process.env.NFL_WRITE_TOKEN;

if (!token) {
  throw new Error("NFL_WRITE_TOKEN fehlt.");
}

const response = await fetch(HISTORY_URL, { headers: { Accept: "application/json" } });
if (!response.ok) throw new Error(`Auktionsverlauf konnte nicht geladen werden: HTTP ${response.status}`);
const history = await response.json();

const cleanName = value => String(value ?? "")
  .replace(/§[0-9a-fk-or]/gi, "")
  .replace(/&[0-9a-fk-or]/gi, "")
  .trim();

const items = [];
for (const [rawName, rawSales] of Object.entries(history)) {
  if (!Array.isArray(rawSales)) continue;
  const sales = rawSales.map(sale => {
    const price = Number(sale?.finalPrice ?? sale?.currentBid ?? sale?.startBid ?? 0);
    const amount = Math.max(1, Number(sale?.item?.amount ?? sale?.amount ?? 1));
    return {
      value: price > 0 ? price / amount : 0,
      material: String(sale?.item?.material ?? ""),
      at: String(sale?.endTime ?? sale?.startTime ?? ""),
    };
  }).filter(sale => Number.isFinite(sale.value) && sale.value > 0);
  if (sales.length === 0) continue;

  sales.sort((a, b) => a.at.localeCompare(b.at));
  const values = sales.map(sale => sale.value);
  const name = cleanName(rawName) || cleanName(rawSales[0]?.item?.displayName);
  if (!name) continue;
  items.push({
    name,
    material: sales.at(-1)?.material ?? "",
    average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    last: Math.round(sales.at(-1)?.value ?? 0),
    min: Math.round(Math.min(...values)),
    max: Math.round(Math.max(...values)),
    sales: values.length,
    lastSaleAt: sales.at(-1)?.at ?? "",
  });
}

const upload = await fetch(`${WORKER_URL}/admin/prices`, {
  method: "PUT",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ updatedAt: new Date().toISOString(), items }),
});
const result = await upload.text();
if (!upload.ok) throw new Error(`Preisindex konnte nicht hochgeladen werden: HTTP ${upload.status} ${result}`);
console.log(`OPItems-Preisindex aktualisiert: ${items.length} Items. ${result}`);
