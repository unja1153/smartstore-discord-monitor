// 2026-11-05: 카테고리(대분류)별 방 방식.
// config.json 의 targets 마다 스마트스토어 카테고리 화면을 읽고, 바뀐 것을 그 카테고리 디스코드 방으로 보낸다.
// 방 주소(웹후크)는 GitHub Secret DISCORD_WEBHOOKS(JSON: {"카테고리 이름": "웹후크 주소"}),
// 전체 안내·오류는 DISCORD_WEBHOOK_URL(#스마트스토어-모니터)로 보낸다.
import { loadConfig, paths } from './src/config.js';
import { buildErrorPayload, buildRecoveryPayload, sendProductEvents, sendWebhook } from './src/discord.js';
import { mergeTwoProducts } from './src/extractors.js';
import { scrapeTargets } from './src/category.js';
import { errorToString, formatKoreanTime, nowIso, readJson, writeJsonAtomic } from './src/utils.js';

const config = loadConfig();
const mainHook = config.webhookUrl;
let hooks = {};
try { hooks = JSON.parse(process.env.DISCORD_WEBHOOKS || '{}'); } catch { hooks = {}; }
const hookFor = (target) => hooks[target.key] || hooks[target.name] || mainHook;
const username = '스마트스토어 모니터';

const EMPTY = { version: 2, mode: 'categories', failureCount: 0, heartbeatMonth: null, targets: {} };
let state = readJson(paths.state, EMPTY);
if (state.version !== 2) state = structuredClone(EMPTY);
state.targets = state.targets || {};

if (!mainHook) throw new Error('GitHub 저장소 Secret에 DISCORD_WEBHOOK_URL을 등록해야 합니다.');

if (config.runMode === 'test-webhook') {
  const at = nowIso();
  for (const target of config.targets) {
    await sendWebhook(hookFor(target), { username, embeds: [{ title: `🧪 «${target.name}» 방 연결 확인`, color: 0x9b59b6, description: '이 방으로 이 카테고리의 변동 알림이 옵니다.', timestamp: at }] });
    await new Promise((r) => setTimeout(r, 700));
  }
  await sendWebhook(mainHook, { username, embeds: [{ title: '🧪 디스코드 연결 확인', color: 0x9b59b6, description: `카테고리 방 ${config.targets.length}곳에 확인 메시지를 보냈습니다.`, timestamp: at }] });
  console.log('모든 방에 확인 메시지를 보냈습니다.');
  process.exit(0);
}

if (config.runMode === 'reset-baseline') {
  state = structuredClone(EMPTY);
  console.log('기준값을 모두 지웠습니다. 새로 저장합니다.');
}

const prevFailures = state.failureCount || 0;
try {
  const { results, collectedAt } = await scrapeTargets(config, paths.debug);
  const at = collectedAt || nowIso();
  const summary = [];
  const history = [];
  let anyOk = false;
  const failedTargets = [];

  for (const r of results) {
    const t = r.target;
    const prev = state.targets[t.key] || { initialized: false, products: {} };
    const next = { ...prev, products: { ...(prev.products || {}) } };
    if (r.failed.length && !r.products.length) {
      failedTargets.push(`${t.name}: ${r.failed.map((f) => f.problem).join(', ')}`);
      next.lastError = r.failed.map((f) => f.problem).join(', ');
      next.lastErrorAt = at;
      state.targets[t.key] = next;
      continue;
    }
    anyOk = true;
    if (r.failed.length) failedTargets.push(`${t.name}: 일부 화면 실패(${r.failed.length}곳)`);
    delete next.lastError;
    delete next.lastErrorAt;
    next.name = t.name;
    next.lastCheckAt = at;
    next.count = r.products.length;
    next.complete = r.complete;

    if (!prev.initialized) {
      next.products = Object.fromEntries(r.products.map((p) => {
        const s = { ...p, firstSeenAt: at, lastChangedAt: at };
        delete s.source;
        return [p.id, s];
      }));
      next.initialized = true;
      state.targets[t.key] = next;
      summary.push(`${t.name} ${r.products.length}개${r.complete ? '' : ' (일부)'}`);
      if (config.notifyOnBaseline) {
        await sendWebhook(hookFor(t), { username, embeds: [{ title: `✅ «${t.name}» 모니터링 시작`, color: 0x5865f2, description: `상품 ${r.products.length}개를 기준으로 저장했습니다. 다음 확인부터 바뀐 것만 이 방에 알립니다.`, fields: [{ name: '확인 범위', value: r.complete ? '이 카테고리 전체' : '일부(화면 몇 곳을 못 읽음)', inline: true }, { name: '저장 시간', value: formatKoreanTime(at, config.timezone), inline: true }], timestamp: at }] }).catch((e) => console.error(`${t.name} 시작 알림 실패: ${errorToString(e)}`));
        await new Promise((res) => setTimeout(res, 700));
      }
      continue;
    }

    const events = [];
    const seen = new Set();
    for (const raw of r.products) {
      seen.add(raw.id);
      const before = prev.products[raw.id] || null;
      const current = mergeForComparison(before, raw);
      delete current.source;
      current.firstSeenAt = before?.firstSeenAt || at;
      if (!before) {
        current.lastChangedAt = at;
        events.push({ types: ['new'], product: current, changes: ['🆕 새 상품이 등록되었습니다.'], detectedAt: at });
      } else {
        const cmp = compareProduct(before, current);
        current.lastChangedAt = cmp.types.length ? at : (before.lastChangedAt || before.firstSeenAt || at);
        if (cmp.types.length) events.push({ ...cmp, product: current, detectedAt: at });
      }
      next.products[raw.id] = current;
    }
    if (r.complete) {
      for (const [id, before] of Object.entries(prev.products)) {
        if (seen.has(id)) continue;
        delete next.products[id];
        events.push({ types: ['removed'], product: { ...before, stockStatus: '목록에서 빠짐' }, changes: ['⚫ 이 카테고리 목록에서 빠졌습니다 (판매중지·삭제·숨김·카테고리 이동).'], detectedAt: at });
      }
    }
    state.targets[t.key] = next;
    summary.push(`${t.name} ${events.length}건`);
    if (events.length) {
      for (const e of events) history.push({ at, target: t.name, types: e.types, id: e.product.id, name: e.product.name, url: e.product.url, price: e.product.currentPrice ?? null, stock: e.product.stockStatus ?? null, changes: e.changes });
      console.log(`[${t.name}] 변경 ${events.length}건`);
      for (const e of events.slice(0, 30)) console.log(`  - ${e.product.name}: ${e.changes.join(' / ')}`);
      await sendProductEvents(hookFor(t), events, { ...config, storeName: `${config.storeName} · ${t.name}` }).catch((e) => console.error(`${t.name} 알림 실패: ${errorToString(e)}`));
    }
  }

  if (history.length) {
    const file = paths.state.replace(/state\.json$/, 'events.json');
    const h = readJson(file, { version: 1, events: [] });
    h.events = [...history, ...(h.events || [])].slice(0, 1000);
    writeJsonAtomic(file, h);
  }

  state.lastRun = { at, summary, failed: failedTargets };
  state.heartbeatMonth = at.slice(0, 7);
  if (!anyOk) throw new Error(`모든 카테고리 확인 실패 — ${failedTargets.join(' / ')}`);
  state.failureCount = failedTargets.length ? prevFailures + 1 : 0;
  writeJsonAtomic(paths.state, state);

  if (failedTargets.length) {
    await sendWebhook(mainHook, buildErrorPayload(config, state.failureCount, `일부 카테고리를 읽지 못했습니다: ${failedTargets.join(' / ')}`)).catch(() => {});
  } else if (prevFailures > 0 && config.notifyOnRecovery) {
    await sendWebhook(mainHook, buildRecoveryPayload(config)).catch(() => {});
  }
  if (config.runMode === 'reset-baseline' || summary.some((s) => /개/.test(s))) {
    await sendWebhook(mainHook, { username, embeds: [{ title: '✅ 카테고리별 모니터링 시작', color: 0x5865f2, description: summary.join('\n'), fields: [{ name: '저장 시간', value: formatKoreanTime(at, config.timezone) }], timestamp: at }] }).catch(() => {});
  }
  console.log(`완료: ${summary.join(', ')}`);
} catch (error) {
  const message = errorToString(error);
  state.failureCount = prevFailures + 1;
  state.lastError = message;
  state.lastErrorAt = nowIso();
  writeJsonAtomic(paths.state, state);
  if (state.failureCount >= config.errorAlertAfterFailures) {
    await sendWebhook(mainHook, buildErrorPayload(config, state.failureCount, message)).catch(() => {});
  }
  console.error(message);
  process.exitCode = 1;
}

function mergeForComparison(previous, currentRaw) {
  const merged = mergeTwoProducts(previous, currentRaw) || currentRaw;
  for (const field of ['stockQuantity', 'discountRate', 'originalPrice', 'currentPrice', 'imageUrl']) {
    if (currentRaw[field] === null || currentRaw[field] === undefined) merged[field] = previous?.[field] ?? null;
  }
  if (currentRaw.soldOut === null || currentRaw.soldOut === undefined) {
    merged.soldOut = previous?.soldOut ?? null;
    merged.stockStatus = previous?.stockStatus || currentRaw.stockStatus || '확인 불가';
  } else {
    merged.stockStatus = currentRaw.stockStatus;
  }
  return merged;
}

function compareProduct(previous, current) {
  const types = [];
  const changes = [];
  const word = (p) => (p.soldOut ? (/개$/.test(p.stockStatus || '') ? '품절' : (p.stockStatus || '품절')) : '판매 가능');
  if (previous.soldOut === true && current.soldOut === false) { types.push('restock'); changes.push(`🟢 상태: ${word(previous)} → 판매 가능`); }
  else if (previous.soldOut === false && current.soldOut === true) { types.push('stock'); changes.push(`🔴 상태: 판매 가능 → ${word(current)}`); }
  if (config.notifyStockQuantity !== false && previous.stockQuantity != null && current.stockQuantity != null && Number(previous.stockQuantity) !== Number(current.stockQuantity)) {
    if (!types.includes('stock') && !types.includes('restock')) types.push('stock');
    changes.push(`📦 재고 수량: ${fmtN(previous.stockQuantity)}개 → ${fmtN(current.stockQuantity)}개`);
  }
  const changed = (a, b) => a != null && b != null && Number(a) !== Number(b);
  if (changed(previous.discountRate, current.discountRate) || changed(previous.currentPrice, current.currentPrice) || changed(previous.originalPrice, current.originalPrice)) {
    types.push('discount');
    if (changed(previous.discountRate, current.discountRate)) changes.push(`🏷️ 할인율: ${Math.round(previous.discountRate)}% → ${Math.round(current.discountRate)}%`);
    if (changed(previous.currentPrice, current.currentPrice)) changes.push(`💰 판매가: ${fmtN(previous.currentPrice)}원 → ${fmtN(current.currentPrice)}원`);
    else if (changed(previous.originalPrice, current.originalPrice)) changes.push(`💰 정가: ${fmtN(previous.originalPrice)}원 → ${fmtN(current.originalPrice)}원`);
  }
  return { types: [...new Set(types)], changes };
}

function fmtN(v) { return Math.round(Number(v)).toLocaleString('ko-KR'); }
