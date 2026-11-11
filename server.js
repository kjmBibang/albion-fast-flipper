const express = require('express');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const STALE_ORDER_MS = 30 * 60 * 1000;
const SAMPLES_DIR = path.join(__dirname, 'samples');
const db = new DatabaseSync(path.join(__dirname, 'albion-flipper.sqlite'));
fs.mkdirSync(SAMPLES_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, item_type TEXT NOT NULL, location_id TEXT NOT NULL,
    quality INTEGER NOT NULL, enchantment INTEGER NOT NULL, unit_price INTEGER NOT NULL,
    amount INTEGER NOT NULL, auction_type TEXT NOT NULL, expires TEXT NOT NULL,
    first_seen TEXT NOT NULL, last_seen TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS flips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, buy_order_id TEXT NOT NULL,
    sell_order_id TEXT NOT NULL, tax_rate REAL NOT NULL, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL, UNIQUE(buy_order_id, sell_order_id)
  );
  CREATE TABLE IF NOT EXISTS scan_status (
    id INTEGER PRIMARY KEY CHECK (id=1), last_received_at TEXT,
    last_batch_count INTEGER NOT NULL DEFAULT 0, total_batches INTEGER NOT NULL DEFAULT 0,
    total_received INTEGER NOT NULL DEFAULT 0, last_ingest_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS orders_match_idx
    ON orders(location_id, auction_type, item_type, quality, enchantment);
  CREATE INDEX IF NOT EXISTS orders_last_seen_idx ON orders(last_seen);
`);
db.prepare('INSERT OR IGNORE INTO scan_status (id) VALUES (1)').run();
const scanColumns = new Set(db.prepare('PRAGMA table_info(scan_status)').all().map(column => column.name));
if (!scanColumns.has('last_ingest_ms')) db.exec('ALTER TABLE scan_status ADD COLUMN last_ingest_ms INTEGER NOT NULL DEFAULT 0');
const flipColumns = new Set(db.prepare('PRAGMA table_info(flips)').all().map(column => column.name));
for (const [name, type] of [['spend_silver', 'INTEGER'], ['profit_silver', 'INTEGER'],
  ['max_quantity', 'INTEGER'],
  ['quantity_completed', 'INTEGER'], ['outcome_at', 'TEXT'], ['archived', 'INTEGER NOT NULL DEFAULT 0'], ['material_plan', 'TEXT']]) {
  if (!flipColumns.has(name)) db.exec(`ALTER TABLE flips ADD COLUMN ${name} ${type}`);
}
function clearStaleOrders() {
  const cutoff = new Date(Date.now() - STALE_ORDER_MS).toISOString();
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM flips WHERE status='active' AND
      buy_order_id IN (SELECT id FROM orders WHERE last_seen < ?) AND
      sell_order_id IN (SELECT id FROM orders WHERE last_seen < ?)` ).run(cutoff, cutoff);
    const result = db.prepare(`DELETE FROM orders WHERE last_seen < ? AND id NOT IN (
      SELECT f.buy_order_id FROM flips f JOIN orders other ON other.id=f.sell_order_id
      WHERE f.status='active' AND other.last_seen >= ?
      UNION
      SELECT f.sell_order_id FROM flips f JOIN orders other ON other.id=f.buy_order_id
      WHERE f.status='active' AND other.last_seen >= ?
    )`).run(cutoff, cutoff, cutoff);
    db.exec('COMMIT');
    if (result.changes) console.log(`Cleared ${result.changes} market orders not seen in the last 30 minutes`);
  } catch (err) {
    db.exec('ROLLBACK');
    console.error('Could not clear stale market orders:', err.message);
  }
}
clearStaleOrders();
const staleCleanupTimer = setInterval(clearStaleOrders, 60 * 1000);
staleCleanupTimer.unref();
app.use(express.json({ limit: '20mb' }));
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

const upsertOrder = db.prepare(`INSERT INTO orders
  (id,item_type,location_id,quality,enchantment,unit_price,amount,auction_type,expires,first_seen,last_seen)
  VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
  item_type=excluded.item_type, location_id=excluded.location_id, quality=excluded.quality,
  enchantment=excluded.enchantment, unit_price=excluded.unit_price, amount=excluded.amount,
  auction_type=excluded.auction_type, expires=excluded.expires, last_seen=excluded.last_seen`);
const recordScan = db.prepare(`UPDATE scan_status SET last_received_at=?, last_batch_count=?, last_ingest_ms=?,
  total_batches=total_batches+1, total_received=total_received+? WHERE id=1`);
let pendingSample = null;
let sampleWriteTimer = null;
function saveSampleLater(payload) {
  pendingSample = payload;
  if (sampleWriteTimer) return;
  sampleWriteTimer = setTimeout(() => {
    sampleWriteTimer = null;
    const snapshot = pendingSample;
    pendingSample = null;
    fs.promises.writeFile(path.join(SAMPLES_DIR, 'marketorders.json'), JSON.stringify(snapshot, null, 2))
      .catch(err => console.error('Could not save market order sample:', err.message));
  }, 5000);
  sampleWriteTimer.unref();
}

app.post('/marketorders.ingest', (req, res) => {
  const startedAt = Date.now();
  const incoming = Array.isArray(req.body?.Orders) ? req.body.Orders : [];
  const now = new Date().toISOString();
  let accepted = 0;
  db.exec('BEGIN');
  try {
    for (const o of incoming) {
      if (o.Id == null || !o.ItemTypeId || !o.LocationId) continue;
      upsertOrder.run(String(o.Id), o.ItemTypeId, String(o.LocationId), Number(o.QualityLevel || 1),
        Number(o.EnchantmentLevel || 0), Number(o.UnitPriceSilver || 0), Number(o.Amount || 0),
        o.AuctionType, o.Expires || '', now, now);
      accepted++;
    }
    recordScan.run(now, accepted, Date.now() - startedAt, accepted);
    db.exec('COMMIT');
  } catch (err) { db.exec('ROLLBACK'); return res.status(500).json({ error: err.message }); }
  saveSampleLater(req.body);
  res.json({ received: accepted, receivedAt: now });
});

app.get('/api/scan-status', (_req, res) => {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - STALE_ORDER_MS).toISOString();
  const status = db.prepare(`SELECT last_received_at, last_batch_count, total_batches, total_received, last_ingest_ms,
    (SELECT COUNT(*) FROM orders WHERE last_seen>=?) AS unique_order_count,
    (SELECT COUNT(*) FROM orders WHERE last_seen>=? AND (expires='' OR expires>?)) AS live_order_count
    FROM scan_status WHERE id=1`).get(cutoff, cutoff, now);
  res.json(status);
});

app.get('/api/orders', (_req, res) => {
  const cutoff = new Date(Date.now() - STALE_ORDER_MS).toISOString();
  const now = new Date().toISOString();
  res.json(db.prepare("SELECT * FROM orders WHERE last_seen>=? AND (expires='' OR expires>?)").all(cutoff, now));
});

app.get('/api/flips', (_req, res) => {
  const tax = reqTax(_req.query.premium);
  const orders = db.prepare('SELECT * FROM orders').all();
  const map = new Map(orders.map(o => [o.id, o]));
  const flips = db.prepare("SELECT * FROM flips WHERE archived=0 AND status IN ('active','done','failed')").all();
  res.json(flips.map(f => presentFlip(f, map, tax)));
});

app.get('/api/performance', (_req, res) => {
  const summary = db.prepare(`SELECT COUNT(*) AS flip_count,
    COALESCE(SUM(spend_silver),0) AS total_spend_silver,
    COALESCE(SUM(profit_silver),0) AS cumulative_profit_silver,
    SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS successful_flips,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed_flips
    FROM flips WHERE status IN ('done','failed') AND outcome_at IS NOT NULL`).get();
  const events = db.prepare(`SELECT f.id, f.status, f.outcome_at, f.spend_silver, f.profit_silver,
      f.quantity_completed, o.item_type, o.quality, o.enchantment
    FROM flips f LEFT JOIN orders o ON o.id=f.sell_order_id
    WHERE f.status IN ('done','failed') AND f.outcome_at IS NOT NULL
    ORDER BY f.outcome_at DESC`).all();
  res.json({ summary, events });
});

function reqTax(premium) { return premium === 'true' ? 0.04 : 0.08; }
function itemKey(o) { return `${o.item_type}\u0000${Number(o.quality)}\u0000${Number(o.enchantment)}`; }
function isLive(o) {
  if (!o) return false;
  const seenAt = Date.parse(o.last_seen);
  return Number.isFinite(seenAt) && Date.now() - seenAt <= STALE_ORDER_MS &&
    (!o.expires || Date.parse(o.expires) > Date.now());
}
function sameItem(a, b) {
  return a.item_type === b.item_type && Number(a.quality) === Number(b.quality) &&
    Number(a.enchantment) === Number(b.enchantment);
}
function baseItemType(itemType) { return String(itemType).replace(/@[0-9]+$/, ''); }
function stonesPerEnchant(itemType) {
  itemType=baseItemType(itemType);
  if (/^T\d+_2H_/.test(itemType)) return 384;
  if (/^T\d+_MAIN_/.test(itemType)) return 288;
  if (/^T\d+_(ARMOR_|BAG(?:_|$))/.test(itemType)) return 192;
  if (/^T\d+_(HEAD_|SHOES_|CAPE|OFF_)/.test(itemType)) return 96;
  return 0;
}
const STONE_BY_STEP = ['RUNE', 'SOUL', 'RELIC'];
function indexMaterialOffers(orders) {
  const index=new Map();
  for(const order of orders){
    if(order.auction_type!=='offer'||!isLive(order)||!/(?:^|_)T?\d+_(?:RUNE|SOUL|RELIC)$/.test(order.item_type))continue;
    const key=`${order.location_id}\u0000${order.item_type}`;
    if(!index.has(key))index.set(key,[]);
    index.get(key).push(order);
  }
  for(const rows of index.values())rows.sort((a,b)=>Number(a.unit_price)-Number(b.unit_price));
  return index;
}
function materialPlanFor(source, targetEnchant, quantity, materialOffers) {
  const tier = Number(String(source.item_type).match(/^T(\d+)_/)?.[1]);
  const perItem = stonesPerEnchant(source.item_type);
  if (!tier || !perItem) return null;
  const plan = [];
  let totalCost = 0;
  for (let step=Number(source.enchantment); step<targetEnchant; step++) {
    const itemType = `T${tier}_${STONE_BY_STEP[step]}`;
    let needed = perItem * quantity;
    const stock = materialOffers.get(`${source.location_id}\u0000${itemType}`)||[];
    const totalAvailable = stock.reduce((sum,o)=>sum+Number(o.amount),0);
    if (totalAvailable < needed) return null;
    for (const order of stock) {
      if (!needed) break;
      const taken = Math.min(needed, Number(order.amount));
      plan.push({ itemType, amount:taken, unitPrice:Number(order.unit_price) });
      totalCost += taken * Number(order.unit_price);
      needed -= taken;
    }
  }
  return { plan, totalCost };
}
function buildCandidate(buy, source, materialOffers, tax) {
  const targetEnchant=Number(buy.enchantment), sourceEnchant=Number(source.enchantment);
  if (!isLive(buy)||!isLive(source)||buy.location_id!=='3003'||buy.auction_type!=='request'||
      source.location_id==='3003'||source.auction_type!=='offer'||baseItemType(buy.item_type)!==baseItemType(source.item_type)||
      Number(buy.quality)!==Number(source.quality)||targetEnchant<sourceEnchant||
      (targetEnchant>3&&targetEnchant!==sourceEnchant)) return null;
  const upgrade=targetEnchant>sourceEnchant;
  if (upgrade && !stonesPerEnchant(source.item_type)) return null;
  let maxQuantity=Math.min(Number(buy.amount),Number(source.amount));
  const tier=String(source.item_type).match(/^T(\d+)_/)?.[1]||'?';
  const perItem=stonesPerEnchant(source.item_type), quantities=new Set();
  if(upgrade){
    const boundaries=[];
    for(let step=sourceEnchant;step<targetEnchant;step++){
      const itemType=`T${tier}_${STONE_BY_STEP[step]}`;
      const stock=materialOffers.get(`${source.location_id}\u0000${itemType}`)||[];
      let available=0;for(const order of stock)available+=Number(order.amount);
      maxQuantity=Math.min(maxQuantity,Math.floor(available/perItem));
      let cumulative=0;for(const order of stock){cumulative+=Number(order.amount);for(const q of [Math.floor(cumulative/perItem),Math.floor(cumulative/perItem)+1])if(q>0&&q<=maxQuantity)boundaries.push(q)}
    }
    if(maxQuantity>0){quantities.add(1);quantities.add(maxQuantity);for(const q of boundaries)quantities.add(q)}
  }else quantities.add(maxQuantity);
  if(maxQuantity<1)return null;
  let quantity=0,material=null,profit=0;
  for(const q of quantities){const cost=upgrade?materialPlanFor(source,targetEnchant,q,materialOffers):{plan:[],totalCost:0};if(!cost)continue;const net=Math.floor(q*Number(buy.unit_price)*(1-tax))-q*Number(source.unit_price)-cost.totalCost;if(net>profit){quantity=q;material=cost;profit=net}}
  if(quantity<1||!material)return null;
  return {buyOrder:buy,sourceOrder:source,quantity:Number(buy.amount),matchedQuantity:quantity,
    taxRate:tax,estimatedProfitSilver:profit,unitProfitSilver:Math.floor(profit/quantity),
    materialCostSilver:material.totalCost,materialPlan:material.plan,
    routeLabel:upgrade?`${tier}.${sourceEnchant} → ${tier}.${targetEnchant}`:`Direct buy (${tier}.${targetEnchant})`,
    buyAgeMs:Date.now()-Date.parse(buy.last_seen),sourceAgeMs:Date.now()-Date.parse(source.last_seen),
    oldestAgeMs:Math.max(Date.now()-Date.parse(buy.last_seen),Date.now()-Date.parse(source.last_seen))};
}
function plannedMaterialCost(source, targetEnchant, plan, quantity) {
  if (!plan?.length || Number(targetEnchant)<=Number(source.enchantment)) return 0;
  const tier=Number(String(source.item_type).match(/^T(\d+)_/)?.[1]), perItem=stonesPerEnchant(source.item_type);
  if(!tier||!perItem)return 0;
  let cost=0;
  for(let step=Number(source.enchantment);step<Number(targetEnchant);step++){
    let needed=perItem*quantity, lastPrice=0;
    for(const row of plan.filter(x=>x.itemType===`T${tier}_${STONE_BY_STEP[step]}`)){
      lastPrice=Number(row.unitPrice);
      const used=Math.min(needed,Number(row.amount));cost+=used*lastPrice;needed-=used;if(!needed)break;
    }
    if(needed&&lastPrice)cost+=needed*lastPrice;
  }
  return cost;
}
function presentFlip(f, orderMap, taxRate = f.tax_rate) {
  const buy = orderMap.get(f.buy_order_id);
  const source = orderMap.get(f.sell_order_id);
  const live = isLive(buy) && isLive(source);
  const savedLimit=Number(f.max_quantity)||Infinity;
  const matchedQuantity = f.quantity_completed ?? (live ? Math.min(savedLimit,Number(buy.amount),Number(source.amount)) : 0);
  const quantity = f.quantity_completed ?? (buy ? Number(buy.amount) : 0);
  let materialPlan=[];try{materialPlan=JSON.parse(f.material_plan||'[]')}catch{}
  const appliedQuantity=f.quantity_completed ?? matchedQuantity;
  const materialCost=source?plannedMaterialCost(source,buy?.enchantment||0,materialPlan,appliedQuantity):0;
  const cost = source ? appliedQuantity * Number(source.unit_price)+materialCost : 0;
  const proceeds = buy ? appliedQuantity * Number(buy.unit_price) : 0;
  const profit = f.profit_silver ?? (Math.floor(proceeds * (1 - taxRate)) - cost);
  const ages = buy && source ? [Date.now() - Date.parse(buy.last_seen), Date.now() - Date.parse(source.last_seen)] : [];
  return { id:f.id, status:f.status, buyOrder:buy || null, sourceOrder:source || null, quantity, matchedQuantity,
    taxRate, estimatedProfitSilver:profit, spendSilver:f.spend_silver ?? cost, materialCostSilver:materialCost,
    routeLabel:source&&buy?(Number(source.enchantment)<Number(buy.enchantment)?`${String(source.item_type).match(/^T(\d+)_/)?.[1]}.${source.enchantment} → ${String(source.item_type).match(/^T(\d+)_/)?.[1]}.${buy.enchantment}`:`Direct buy (${String(source.item_type).match(/^T(\d+)_/)?.[1]}.${buy.enchantment})`):'Unavailable', outcomeAt:f.outcome_at,
    unitProfitSilver: quantity && buy && source ? Math.floor(Number(buy.unit_price)*(1-taxRate))-Number(source.unit_price) : 0,
    buyAgeMs:ages[0] || 0, sourceAgeMs:ages[1] || 0, oldestAgeMs:Math.max(...ages, 0), live };
}

const itemNameCache = new Map();
const itemNameRequests = new Map();
async function fetchItemName(id) {
  if (itemNameCache.has(id)) return itemNameCache.get(id);
  if (itemNameRequests.has(id)) return itemNameRequests.get(id);
  const request = (async () => {
    try {
      const url = `https://gameinfo.albiononline.com/api/gameinfo/items/${encodeURIComponent(id)}`;
      let response = await fetch(url, { signal:AbortSignal.timeout(5000) });
      if (!response.ok) response = await fetch(`${url}/data`, { signal:AbortSignal.timeout(5000) });
      if (!response.ok) return null;
      const item = await response.json();
      const names = item.LocalizedNames || {};
      const name = names['EN-US'] || names['en-US'] || item.Name || null;
      if (name) itemNameCache.set(id, name);
      return name;
    } catch { return null; }
    finally { itemNameRequests.delete(id); }
  })();
  itemNameRequests.set(id, request);
  return request;
}
app.get('/api/item-names', async (req, res) => {
  const ids = [...new Set(String(req.query.ids || '').split(',')
    .filter(id => /^[A-Z0-9_@]+$/.test(id)))].slice(0, 80);
  const names = {};
  for (let start=0; start<ids.length; start+=8) {
    const batch = ids.slice(start, start+8);
    const results = await Promise.all(batch.map(id => fetchItemName(id)));
    batch.forEach((id, index) => { if (results[index]) names[id] = results[index]; });
  }
  res.json(names);
});

app.get('/api/candidates', (req, res) => {
  const tax = reqTax(req.query.premium);
  const orders = db.prepare('SELECT * FROM orders').all().filter(isLive);
  const materialOffers=indexMaterialOffers(orders);
  const bmBuys = orders.filter(o => o.location_id === '3003' && o.auction_type === 'request');
  const sourcesByItem = new Map();
  for (const source of orders) {
    if (source.location_id === '3003' || source.auction_type !== 'offer') continue;
    const item = `${baseItemType(source.item_type)}\u0000${Number(source.quality)}`;
    if (!sourcesByItem.has(item)) sourcesByItem.set(item, []);
    sourcesByItem.get(item).push(source);
  }
  const ignored = new Set(db.prepare("SELECT buy_order_id, sell_order_id FROM flips WHERE status IN ('active','done','failed')").all()
    .map(x => `${x.buy_order_id}:${x.sell_order_id}`));
  const matches = [];
  for (const buy of bmBuys) for (const source of (sourcesByItem.get(`${baseItemType(buy.item_type)}\u0000${Number(buy.quality)}`) || [])) {
    const key = `${buy.id}:${source.id}`;
    if (ignored.has(key)) continue;
    const candidate=buildCandidate(buy,source,materialOffers,tax);
    if(candidate)matches.push(candidate);
  }
  res.json(matches.sort((a,b)=>b.estimatedProfitSilver-a.estimatedProfitSilver));
});

app.post('/api/flips', (req, res) => {
  const { buyOrderId, sourceOrderId, premium = false } = req.body || {};
  const buy = db.prepare('SELECT * FROM orders WHERE id=?').get(String(buyOrderId));
  const source = db.prepare('SELECT * FROM orders WHERE id=?').get(String(sourceOrderId));
  const tax = premium ? 0.04 : 0.08;
  const orders=db.prepare('SELECT * FROM orders').all().filter(isLive);
  const candidate=buy&&source?buildCandidate(buy,source,indexMaterialOffers(orders),tax):null;
  if (!candidate) return res.status(400).json({ error: 'Orders are no longer a profitable direct or enchantment match in that city.' });
  const result = db.prepare("INSERT OR IGNORE INTO flips (buy_order_id,sell_order_id,tax_rate,status,created_at,max_quantity,material_plan) VALUES (?,?,?,'active',?,?,?)")
    .run(String(buyOrderId), String(sourceOrderId), tax, new Date().toISOString(), candidate.matchedQuantity, JSON.stringify(candidate.materialPlan));
  res.status(result.changes ? 201 : 200).json({ id:Number(result.lastInsertRowid), saved:!!result.changes });
});

app.patch('/api/flips/:id', (req, res) => {
  const status = req.body?.status;
  if (status !== 'done' && status !== 'failed') return res.status(400).json({ error:'Status must be done or failed.' });
  const flip = db.prepare("SELECT * FROM flips WHERE id=? AND status='active'").get(Number(req.params.id));
  if (!flip) return res.status(404).json({ error:'Active flip not found.' });
  const buy = db.prepare('SELECT * FROM orders WHERE id=?').get(flip.buy_order_id);
  const source = db.prepare('SELECT * FROM orders WHERE id=?').get(flip.sell_order_id);
  if (!buy || !source) return res.status(409).json({ error:'Order details are unavailable; outcome was not recorded.' });
  const maxQuantity = Number(flip.max_quantity) || Math.min(Number(buy.amount), Number(source.amount));
  // The saved opportunity is only a market snapshot. A completed trade can
  // include more items than either order showed at scan time.
  const quantity = req.body?.quantity == null ? maxQuantity : Number(req.body.quantity);
  if (!Number.isSafeInteger(quantity) || quantity < 1)
    return res.status(400).json({ error:'Enter a whole quantity greater than zero.' });
  let materialPlan=[];try{materialPlan=JSON.parse(flip.material_plan||'[]')}catch{}
  const spend = quantity * Number(source.unit_price)+plannedMaterialCost(source,buy.enchantment,materialPlan,quantity);
  const targetSaleValue = quantity * Number(buy.unit_price);
  const saleTax = status === 'failed' ? 0.025 : flip.tax_rate;
  const saleValue = status === 'failed' ? Math.floor(targetSaleValue * 0.5) : targetSaleValue;
  const profit = Math.floor(saleValue * (1 - saleTax)) - spend;
  const now = new Date().toISOString();
  db.prepare(`UPDATE flips SET status=?, spend_silver=?, profit_silver=?, quantity_completed=?, outcome_at=?
    WHERE id=? AND status='active'`).run(status, spend, profit, quantity, now, flip.id);
  res.json({ id:flip.id, status, quantity, spendSilver:spend, profitSilver:profit, outcomeAt:now,
    assumedSaleSilver:Math.floor(saleValue * (1-saleTax)), saleTaxRate:saleTax });
});
app.delete('/api/flips/:id', (req, res) => {
  db.prepare("DELETE FROM flips WHERE id=? AND status='active'").run(Number(req.params.id));
  res.sendStatus(204);
});
app.post('/api/flips/archive-recorded', (_req, res) => {
  const result = db.prepare("UPDATE flips SET archived=1 WHERE archived=0 AND status IN ('done','failed')").run();
  res.json({ archived:result.changes });
});

const server = app.listen(PORT, HOST, () => console.log(`Listening on http://${HOST}:${PORT}`));
server.on('error', err => {
  console.error(`Could not start server at http://${HOST}:${PORT}: ${err.message}`);
  process.exitCode = 1;
});
