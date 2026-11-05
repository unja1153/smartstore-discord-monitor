// ============================================================================
// 타사 가격추적 — 카페24 경쟁사 쇼핑몰 (2026-11-05)
// ----------------------------------------------------------------------------
// config.json 의 competitors[{key, name, url}] 마다
//   1) sitemap.xml(또는 sitemapN.xml.gz)에서 상품 주소를 모두 모으고
//   2) 상품 페이지를 하나씩 받아 가격(정가·판매가)·품절·재고·옵션(옵션별 가격·재고·판매 여부)을 읽어
//   3) 지난번 기준값과 비교해 바뀐 것을 data/events.json 에 쌓는다.
// 브라우저 없이 주소만 불러온다(Claude·사무실 PC 필요 없음). 알림은 업따 시스템 «타사 가격추적» 화면에서 본다.
// 기준값: data/state.json(version 2, targets[가게].products), 옵션: data/options.json(products["가게:상품번호"])
// ============================================================================
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { loadConfig, paths } from './src/config.js';
import { readJson, writeJsonAtomic, nowIso, errorToString } from './src/utils.js';

const config = loadConfig();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtN = (v) => Math.round(Number(v)).toLocaleString('ko-KR');
const DELAY = Number(config.cafe24DelayMs || 500);
const CONC = Number(config.cafe24Concurrency || 2);
const probe = config.runMode === 'probe';

async function get(url, asBuffer = false) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9' }, redirect: 'follow' });
      if (r.status === 429 || r.status >= 500) { await sleep(5000 * (i + 1)); continue; }
      const body = asBuffer ? Buffer.from(await r.arrayBuffer()) : await r.text();
      return { status: r.status, url: r.url, body };
    } catch (e) {
      if (i === 2) return { status: 0, url, body: asBuffer ? Buffer.alloc(0) : '', error: e.message };
      await sleep(3000);
    }
  }
  return { status: 429, url, body: asBuffer ? Buffer.alloc(0) : '' };
}

async function sitemapProducts(base) {
  const seen = new Set();
  const out = [];
  const queue = [`${base}/sitemap.xml`];
  const done = new Set();
  while (queue.length) {
    const u = queue.shift();
    if (done.has(u)) continue; done.add(u);
    const r = await get(u, true);
    if (r.status !== 200) continue;
    let text;
    try { text = /\.gz($|\?)/.test(u) ? zlib.gunzipSync(r.body).toString('utf8') : r.body.toString('utf8'); } catch { text = r.body.toString('utf8'); }
    for (const m of text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const loc = m[1].replace(/&amp;/g, '&');
      if (/sitemap[^/]*\.xml(\.gz)?$/i.test(loc)) { queue.push(loc); continue; }
      const no = (loc.match(/\/product\/[^/]*\/(\d+)/) || loc.match(/product_no=(\d+)/) || [])[1];
      if (no && !seen.has(no)) { seen.add(no); out.push({ no, url: loc }); }
    }
  }
  return out;
}

function unescapeJsString(s) {
  try { return JSON.parse('"' + s.replace(/\\'/g, "'").replace(/(^|[^\\])"/g, '$1\\"') + '"'); } catch { return null; }
}

function parseProduct(html, base, no) {
  const meta = (p) => { const m = html.match(new RegExp(`<meta property="${p}" content="([^"]*)"`)); return m ? m[1] : null; };
  const price = meta('product:price:amount');
  if (!price && !/product_name\s*=/.test(html)) return null; // 상품 페이지가 아님(삭제·숨김)
  const name = (meta('og:title') || (html.match(/var product_name = '([^']*)'/) || [])[1] || `상품 ${no}`).replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
  const sale = meta('product:sale_price:amount');
  let osd = null;
  const m = html.match(/option_stock_data\s*=\s*'([^']*)'/);
  if (m && m[1]) { const s = unescapeJsString(m[1]); if (s) { try { osd = JSON.parse(s); } catch { osd = null; } } }
  const combos = [];
  let single = null;
  if (osd && typeof osd === 'object') {
    if ('stock_number' in osd || 'use_stock' in osd) single = osd;
    else {
      for (const [code, o] of Object.entries(osd)) {
        if (!o || typeof o !== 'object') continue;
        const nm = Array.isArray(o.option_value_orginal) ? o.option_value_orginal.join(' / ') : String(o.option_value_orginal || o.option_value || o.option_name || code);
        const out = o.is_selling === 'F' || (o.use_stock && o.use_soldout === 'T' && Number(o.stock_number) <= 0);
        if (o.is_display === 'F') continue;
        combos.push([code, nm, o.option_price != null ? Number(o.option_price) : null, o.use_stock ? Number(o.stock_number) : null, out ? 0 : 1]);
      }
    }
  }
  const curPrice = sale != null ? Number(sale) : (price != null ? Number(price) : null);
  const orig = price != null ? Number(price) : null;
  let soldOut = false; let stock = null;
  if (single) { stock = single.use_stock ? Number(single.stock_number) : null; soldOut = !!(single.use_stock && single.use_soldout === 'T' && Number(single.stock_number) <= 0); }
  if (combos.length) { soldOut = combos.every((c) => !c[4]); const st = combos.map((c) => c[3]).filter((v) => v != null); stock = st.length ? st.reduce((a, b) => a + Math.max(0, b), 0) : null; }
  if (/class="[^"]*btnSoldout[^"]*"(?![^>]*displaynone)/.test(html) && !combos.length && !single) soldOut = true;
  const prices = combos.map((c) => c[2]).filter((v) => v != null);
  return {
    id: String(no), url: `${base}/product/detail.html?product_no=${no}`, name: name.slice(0, 200),
    currentPrice: curPrice, originalPrice: orig, discountRate: orig && curPrice != null && orig > curPrice ? Math.round((orig - curPrice) / orig * 100) : null,
    stockQuantity: stock, soldOut, stockStatus: soldOut ? '품절' : (stock != null ? `${fmtN(stock)}개` : '판매 가능'),
    optCount: combos.length || undefined, optMinPrice: prices.length ? Math.min(...prices) : undefined, optMaxPrice: prices.length ? Math.max(...prices) : undefined, optSoldOut: combos.length ? combos.filter((c) => !c[4]).length : undefined,
    _combos: combos
  };
}

function compare(prev, cur) {
  const types = []; const changes = [];
  if (prev.soldOut === true && cur.soldOut === false) { types.push('restock'); changes.push('🟢 상태: 품절 → 판매 가능'); }
  else if (prev.soldOut === false && cur.soldOut === true) { types.push('stock'); changes.push('🔴 상태: 판매 가능 → 품절'); }
  const ch = (a, b) => a != null && b != null && Number(a) !== Number(b);
  if (ch(prev.currentPrice, cur.currentPrice) || ch(prev.originalPrice, cur.originalPrice)) {
    types.push('discount');
    if (ch(prev.currentPrice, cur.currentPrice)) changes.push(`💰 판매가: ${fmtN(prev.currentPrice)}원 → ${fmtN(cur.currentPrice)}원`);
    if (ch(prev.originalPrice, cur.originalPrice)) changes.push(`🏷️ 정가: ${fmtN(prev.originalPrice)}원 → ${fmtN(cur.originalPrice)}원`);
  }
  if (config.notifyStockQuantity !== false && ch(prev.stockQuantity, cur.stockQuantity) && !types.includes('stock') && !types.includes('restock')) {
    types.push('stock'); changes.push(`📦 재고 수량: ${fmtN(prev.stockQuantity)}개 → ${fmtN(cur.stockQuantity)}개`);
  }
  return { types, changes };
}

function compareOptions(before, now) {
  const types = new Set(); const lines = []; const added = []; const removed = []; let qty = 0;
  const pm = new Map((before || []).map((c) => [c[0], c]));
  const nm = new Map((now || []).map((c) => [c[0], c]));
  const list = (a) => (a.length > 5 ? `${a.slice(0, 5).join(', ')} 외 ${a.length - 5}개` : a.join(', '));
  for (const [code, c] of nm) {
    const o = pm.get(code);
    if (!o) { added.push(c[1]); continue; }
    if (o[2] != null && c[2] != null && Number(o[2]) !== Number(c[2])) { types.add('discount'); lines.push(`💰 옵션 «${c[1]}» ${fmtN(o[2])}원 → ${fmtN(c[2])}원`); }
    if (o[4] && !c[4]) { types.add('stock'); lines.push(`🔴 옵션 품절: ${c[1]}`); }
    else if (!o[4] && c[4]) { types.add('restock'); lines.push(`🟢 옵션 재입고: ${c[1]}`); }
    else if (o[3] != null && c[3] != null && Number(o[3]) !== Number(c[3])) qty += 1;
  }
  for (const [code, o] of pm) if (!nm.has(code)) removed.push(o[1]);
  if (added.length) { types.add('stock'); lines.push(`➕ 옵션 추가: ${list(added)}`); }
  if (removed.length) { types.add('stock'); lines.push(`➖ 옵션 삭제: ${list(removed)}`); }
  if (qty && config.notifyStockQuantity !== false) { types.add('stock'); lines.push(`📦 옵션 재고 수량 변동 ${qty}개`); }
  return { types: [...types], lines };
}

async function scanStore(store) {
  const base = store.url.replace(/\/$/, '');
  const list = await sitemapProducts(base);
  const limit = probe ? Number(process.env.PROBE_LIMIT || 15) : list.length;
  const todo = list.slice(0, limit);
  const products = {}; const fails = []; const gone = [];
  let i = 0; let blocked = 0;
  async function worker() {
    while (i < todo.length) {
      const it = todo[i++];
      const r = await get(it.url.startsWith('http') ? it.url : base + it.url);
      if (r.status === 403 || r.status === 429) { blocked++; fails.push(`${it.no}:${r.status}`); }
      else if (r.status !== 200) gone.push(it.no);
      else {
        const p = parseProduct(r.body, base, it.no);
        if (p) p.name = p.name.replace(new RegExp(`\\s*-\\s*${store.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '').trim();
        if (p) products[p.id] = p; else gone.push(it.no);
      }
      await sleep(DELAY);
      if (blocked >= 10) break;
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  return { store, base, total: list.length, read: Object.keys(products).length, products, fails, gone, blocked: blocked >= 10 };
}

const at = nowIso();
let state = readJson(paths.state, { version: 2, targets: {} });
if (state.version !== 2 || state.mode !== 'competitors') state = { version: 2, mode: 'competitors', targets: {} };
const optFile = paths.state.replace(/state\.json$/, 'options.json');
let opts = readJson(optFile, { version: 1, products: {} });
if (state.mode === 'competitors' && opts.mode !== 'competitors') opts = { version: 1, mode: 'competitors', products: {} };
if (config.runMode === 'reset-baseline') { state = { version: 2, mode: 'competitors', targets: {} }; opts = { version: 1, mode: 'competitors', products: {} }; }

const summary = []; const problems = []; const history = [];
for (const store of config.competitors) {
  const t0 = Date.now();
  let r;
  try { r = await scanStore(store); } catch (e) { problems.push(`${store.name}: ${errorToString(e)}`); continue; }
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log(`[${store.name}] 사이트맵 ${r.total}개 중 ${r.read}개 읽음, 없음 ${r.gone.length}, 실패 ${r.fails.length}${r.blocked ? ' (막힘으로 중단)' : ''} — ${secs}초`);
  if (probe) {
    for (const p of Object.values(r.products).slice(0, 6)) console.log(`  · ${p.name} | ${p.originalPrice}→${p.currentPrice} | ${p.stockStatus} | 옵션 ${p.optCount || 0}${p.optCount ? ` (${p.optMinPrice}~${p.optMaxPrice}, 품절 ${p.optSoldOut})` : ''}`);
    continue;
  }
  if (r.blocked) problems.push(`${store.name}: 쇼핑몰이 접속을 막음(403/429)`);
  if (!r.read) { problems.push(`${store.name}: 상품을 하나도 못 읽음`); continue; }
  const prev = state.targets[store.key] || { initialized: false, products: {} };
  const next = { name: store.name, url: store.url, initialized: true, lastCheckAt: at, count: r.read, sitemapCount: r.total, complete: !r.blocked && !r.fails.length, products: {} };
  const events = [];
  for (const cur of Object.values(r.products)) {
    const combos = cur._combos; delete cur._combos;
    const okey = `${store.key}:${cur.id}`;
    const before = prev.products && prev.products[cur.id];
    const beforeOpts = opts.products[okey];
    if (!prev.initialized) { next.products[cur.id] = { ...cur, firstSeenAt: at, lastChangedAt: at }; opts.products[okey] = combos; continue; }
    if (!before) {
      const s = { ...cur, firstSeenAt: at, lastChangedAt: at };
      next.products[cur.id] = s; opts.products[okey] = combos;
      events.push({ types: ['new'], product: s, changes: ['🆕 새 상품이 보입니다.'] });
      continue;
    }
    const c = compare(before, cur);
    if (beforeOpts) { const oc = compareOptions(beforeOpts, combos); for (const ty of oc.types) if (!c.types.includes(ty)) c.types.push(ty); c.changes.push(...oc.lines); }
    const s = { ...cur, firstSeenAt: before.firstSeenAt || at, lastChangedAt: c.types.length ? at : (before.lastChangedAt || at) };
    next.products[cur.id] = s; opts.products[okey] = combos;
    if (c.types.length) events.push({ ...c, product: s });
  }
  if (prev.initialized) {
    for (const [id, before] of Object.entries(prev.products || {})) {
      if (next.products[id]) continue;
      if (r.gone.includes(id)) { events.push({ types: ['removed'], product: { ...before, stockStatus: '판매 중단' }, changes: ['⚫ 상품 페이지가 없어졌습니다 (삭제·숨김·판매 중단).'] }); delete opts.products[`${store.key}:${id}`]; }
      else next.products[id] = before; // 이번에 못 읽은 상품은 기준값 유지
    }
  }
  state.targets[store.key] = next;
  summary.push(prev.initialized ? `${store.name} ${r.read}개 · 변경 ${events.length}건` : `${store.name} 기준 ${r.read}개`);
  for (const e of events) history.push({ at, target: store.name, types: e.types, id: e.product.id, name: e.product.name, url: e.product.url, price: e.product.currentPrice ?? null, stock: e.product.stockStatus ?? null, changes: e.changes });
  console.log(`[${store.name}] 변경 ${events.length}건`);
  for (const e of events.slice(0, 20)) console.log(`  - ${e.product.name}: ${e.changes.join(' / ')}`);
  // 2026-11-05: 가게 하나를 끝낼 때마다 바로 저장·올리기(업따 시스템 화면에 읽은 가게부터 보이도록)
  saveAll(false);
  pushNow(`타사 가격추적: ${store.name} 확인`);
}

function saveAll(final) {
  if (probe) return;
  state.lastRun = { at, summary: [...summary], failed: [...problems], source: 'github', running: !final };
  state.heartbeatMonth = at.slice(0, 7);
  writeJsonAtomic(paths.state, state);
  opts.mode = 'competitors'; opts.updatedAt = at;
  writeJsonAtomic(optFile, opts);
  if (history.length) {
    const file = paths.state.replace(/state\.json$/, 'events.json');
    const h = readJson(file, { version: 1, events: [] });
    const keep = (h.events || []).filter((e) => e.at !== at);
    h.events = [...history, ...keep].slice(0, 2000);
    writeJsonAtomic(file, h);
  }
}
function pushNow(msg) {
  if (probe || !process.env.GITHUB_ACTIONS) return;
  try {
    execSync('git config user.name "smartstore-monitor[bot]" && git config user.email "smartstore-monitor[bot]@users.noreply.github.com"', { stdio: 'ignore' });
    execSync('git add data/', { stdio: 'ignore' });
    try { execSync('git diff --cached --quiet', { stdio: 'ignore' }); return; } catch { /* 변경 있음 */ }
    execSync(`git commit -m "${msg.replace(/"/g, '')} [skip ci]"`, { stdio: 'ignore' });
    execSync('git pull --rebase origin main && git push', { stdio: 'ignore' });
  } catch (e) { console.log(`중간 저장 실패(끝에 한 번에 저장): ${e.message}`); }
}

if (!probe) {
  state.failureCount = problems.length ? (state.failureCount || 0) + 1 : 0;
  saveAll(true);
}
console.log(`완료: ${summary.join(', ')}${problems.length ? ` / 문제: ${problems.join(' / ')}` : ''}`);
if (problems.length && !summary.length) process.exitCode = 1;
