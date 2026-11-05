// 2026-11-05: 시험용(RUN_MODE=probe). 카테고리 화면에서 «2» 페이지 버튼을 눌렀을 때
// GitHub 서버에서도 2페이지 목록이 오는지 확인한다. 기준값·디스코드는 건드리지 않는다.
import { chromium } from 'playwright';

const store = 'https://smartstore.naver.com/updda';
const ids = (process.env.PROBE_IDS || 'f864688900f54adfbde85e563c7d290a').split(',');
const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const context = await browser.newContext({
  locale: 'ko-KR', timezoneId: 'Asia/Seoul', viewport: { width: 1440, height: 1100 },
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' }
});
const page = await context.newPage();
page.on('response', (r) => { if (/\/categories\/[^/]+\/products\?/.test(r.url())) console.log(`  응답 ${r.status()} ${r.url().slice(0, 160)}`); });
try {
  await page.goto(store, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  for (const id of ids) {
    await page.goto(`${store}/category/${id}?st=RECENT&cp=1`, { waitUntil: 'domcontentloaded', timeout: 60000, referer: store });
    await page.waitForTimeout(4000);
    const first = await page.evaluate(() => { const s = window.__PRELOADED_STATE__?.categoryProducts; return s ? { n: s.simpleProducts.length, total: s.totalCount } : null; });
    console.log(`[${id.slice(0, 6)}] 주소 ${page.url().slice(0, 120)} / 1페이지 ${JSON.stringify(first)}`);
    // 사람처럼 천천히 내려 본 뒤 «2»를 누른다
    for (let i = 0; i < 6; i += 1) { await page.mouse.wheel(0, 700); await page.waitForTimeout(700); }
    await page.waitForTimeout(8000);
    const btn = page.locator('a[aria-current="false"]', { hasText: /^2$/ }).first();
    const has = await btn.count();
    console.log(`  2페이지 버튼 ${has ? '있음' : '없음'}`);
    if (has) {
      const wait = page.waitForResponse((r) => /\/categories\/[^/]+\/products\?/.test(r.url()), { timeout: 20000 }).catch(() => null);
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click().catch((e) => console.log('  클릭 실패', e.message));
      const res = await wait;
      if (res) {
        const body = await res.json().catch(() => null);
        console.log(`  결과 ${res.status()} 상품 ${body?.simpleProducts?.length ?? '-'}개 / 요청 헤더 ${JSON.stringify(Object.keys(res.request().headers()))}`);
      } else console.log('  2페이지 응답 없음');
      await page.waitForTimeout(3000);
      const dom = await page.evaluate(() => document.querySelectorAll('a[href*="/products/"]').length);
      console.log(`  화면의 상품 링크 ${dom}개, 주소 ${page.url().slice(-60)}`);
    }
    await page.waitForTimeout(5000);
  }
} finally {
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}
