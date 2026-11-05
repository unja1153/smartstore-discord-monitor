// 2026-11-05: 카테고리별로 확인한다(사용자 방식).
// 네이버는 GitHub 서버에서 «전체상품» 페이지를 넘기면 로그인 화면이나 429(요청 너무 많음)로 막는다.
// 카테고리 첫 화면(한 번에 80개)은 열리므로, 대분류마다 그 화면을 열고
// 80개가 넘는 대분류는 중분류 화면들도 열어서 합친다. 페이지 넘기기는 하지 않는다.
import { chromium } from 'playwright';
import { finalizeProduct } from './extractors.js';
import { ensureDir, sleep, toNumber } from './utils.js';

const STATUS_TEXT = {
  SALE: '판매 가능',
  OUTOFSTOCK: '품절',
  SUSPENSION: '판매중지',
  CLOSE: '판매종료',
  PROHIBITION: '판매금지',
  WAIT: '판매대기'
};

function productFromSimple(raw, storeUrl) {
  if (!raw?.id) return null;
  const salePrice = toNumber(raw.salePrice);
  const discounted = toNumber(raw.benefitsView?.discountedSalePrice);
  const status = raw.productStatusType || null;
  return finalizeProduct({
    id: String(raw.id),
    url: `${storeUrl}/products/${raw.id}`,
    name: raw.dispName || raw.name,
    currentPrice: discounted ?? salePrice,
    originalPrice: salePrice,
    discountRate: toNumber(raw.benefitsView?.discountedRatio),
    stockQuantity: toNumber(raw.stockQuantity),
    soldOut: status ? status !== 'SALE' : null,
    stockStatus: STATUS_TEXT[status] || status || '확인 불가',
    imageUrl: raw.representativeImageUrl,
    source: 'category'
  }, storeUrl);
}

async function readCategory(page, config, categoryId) {
  const urls = [
    `${config.storeUrl}/category/${categoryId}?st=RECENT&dt=LIST&size=80&cp=1`,
    `${config.storeUrl}/category/${categoryId}?st=RECENT&cp=1`,
    `${config.storeUrl}/category/${categoryId}?cp=1`
  ];
  let lastProblem = '';
  for (let attempt = 0; attempt < urls.length; attempt += 1) {
    const url = urls[attempt];
    try {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000, referer: config.storeUrl });
      await page.waitForTimeout(config.pageWaitMs);
      if (res && res.status() >= 400) { lastProblem = `HTTP ${res.status()}`; await page.waitForTimeout(4000); continue; }
      if (/nid\.naver\.com|nidlogin/.test(page.url())) { lastProblem = '로그인 화면으로 넘어감'; await page.waitForTimeout(4000); continue; }
      const data = await page.evaluate(() => {
        const s = window.__PRELOADED_STATE__?.categoryProducts;
        return s ? { items: s.simpleProducts || [], totalCount: s.totalCount ?? null } : null;
      });
      if (!data) { lastProblem = '상품 자료를 찾지 못함'; await page.waitForTimeout(3000); continue; }
      return { ok: true, items: data.items, totalCount: data.totalCount, url };
    } catch (error) {
      lastProblem = error.message;
      await page.waitForTimeout(4000);
    }
  }
  return { ok: false, items: [], totalCount: null, problem: lastProblem };
}

export async function scrapeTargets(config, debugDir) {
  ensureDir(debugDir);
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: config.timezone,
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' }
  });
  const page = await context.newPage();
  const results = [];
  try {
    // 스토어 첫 화면을 한 번 열어 둔다(사람처럼 들어가기).
    await page.goto(config.storeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(config.pageWaitMs);

    for (const target of config.targets) {
      const byId = new Map();
      const parts = [];
      for (const categoryId of target.categoryIds) {
        const r = await readCategory(page, config, categoryId);
        let added = 0;
        for (const raw of r.items) {
          const p = productFromSimple(raw, config.storeUrl);
          if (p && !byId.has(p.id)) { byId.set(p.id, p); added += 1; }
        }
        // 그 화면에 다 들어왔는지: 받은 개수 >= 전체 개수
        const full = r.ok && (r.totalCount == null || r.items.length >= r.totalCount);
        parts.push({ categoryId, ok: r.ok, full, got: r.items.length, total: r.totalCount, problem: r.problem || null });
        console.log(`[${target.name}] ${categoryId.slice(0, 6)}… ${r.ok ? `${r.items.length}/${r.totalCount ?? '?'}개, 새로 ${added}개` : `실패: ${r.problem}`}`);
        await sleep(config.requestDelayMs);
      }
      const failed = parts.filter((p) => !p.ok);
      // 대분류 화면(첫 번째)이 80개를 넘으면 중분류로 채우므로, 실패한 화면이 없을 때만 «전부 읽음»으로 본다.
      const complete = !failed.length && parts.slice(1).every((p) => p.full) && (parts.length > 1 || parts[0].full);
      results.push({ target, products: [...byId.values()], parts, failed, complete });
      console.log(`[${target.name}] 합계 ${byId.size}개 (${complete ? '전부' : failed.length ? `실패 ${failed.length}곳` : '일부'})`);
    }
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return { results, collectedAt: new Date().toISOString() };
}
