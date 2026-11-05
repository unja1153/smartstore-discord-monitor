import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  extractProductDetail,
  extractProductsFromJson,
  finalizeProduct,
  mergeProducts,
  mergeTwoProducts
} from './extractors.js';
import {
  cleanText,
  ensureDir,
  normalizeProductUrl,
  productIdFromUrl,
  sleep,
  toNumber
} from './utils.js';

export async function scrapeSmartStore(config, debugDir) {
  ensureDir(debugDir);
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox']
  });

  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: config.timezone,
    viewport: { width: 1440, height: 1100 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });

  try {
    const listing = await scrapeAllProductsList(context, config, debugDir).catch((error) => {
      console.warn(`[STORE] 전체상품 목록 수집 실패, 예전 방식으로 재시도: ${error.message}`);
      return null;
    });
    const storeProducts = listing?.products?.length
      ? listing.products
      : await scrapeStorePages(context, config, debugDir);
    const pinnedProducts = [];

    for (const url of config.pinnedProductUrls) {
      if (!productIdFromUrl(url)) continue;
      try {
        const detail = await scrapeProductPage(context, url, config, debugDir);
        if (detail) pinnedProducts.push(detail);
      } catch (error) {
        console.warn(`[PINNED] ${url} 확인 실패: ${error.message}`);
      }
      await sleep(config.requestDelayMs);
    }

    const products = mergeProducts([...storeProducts, ...pinnedProducts])
      .slice(0, config.maxProducts);

    if (!products.length) {
      throw new Error('스토어에서 상품을 한 개도 수집하지 못했습니다. 네이버 차단 또는 페이지 구조 변경 가능성이 있습니다.');
    }

    const totalCount = listing?.totalCount ?? null;
    const listComplete = Boolean(totalCount && listing.products.length >= totalCount);
    console.log(`[STORE] 전체 ${totalCount ?? '?'}개 중 ${storeProducts.length}개 수집 (${listComplete ? '전부' : '일부'})`);

    return {
      products,
      collectedAt: new Date().toISOString(),
      storeProductCount: storeProducts.length,
      pinnedProductCount: pinnedProducts.length,
      totalCount,
      listComplete
    };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// 2026-11-05: 스토어 «전체상품» 목록을 처음부터 끝까지 읽는다.
// 네이버는 주소의 page 값을 무시하고 1페이지로 돌려보내므로, 화면의 페이지 번호를 눌러 넘긴다.
// 1페이지는 화면에 미리 들어 있는 자료(__PRELOADED_STATE__), 2페이지부터는 누를 때 오는 목록 응답을 읽는다.
async function scrapeAllProductsList(context, config, debugDir) {
  const page = await context.newPage();
  const byId = new Map();
  let totalCount = null;

  const add = (items) => {
    let added = 0;
    for (const raw of items || []) {
      const product = productFromSimple(raw, config.storeUrl);
      if (product && !byId.has(product.id)) {
        byId.set(product.id, product);
        added += 1;
      }
    }
    return added;
  };

  try {
    // 2026-11-05: GitHub 서버에서는 «dt=LIST&size=80» 주소가 네이버 로그인 화면으로 넘어갔다.
    // 예전부터 열리던 «category/ALL?cp=1»을 먼저 열고, 로그인 화면이면 다음 주소를 시도한다.
    const candidates = [
      `${config.storeUrl}/category/ALL?cp=1`,
      `${config.storeUrl}/category/ALL?st=RECENT&cp=1`,
      `${config.storeUrl}/category/ALL?st=RECENT&dt=LIST&size=80`
    ];
    let opened = false;
    for (const listUrl of candidates) {
      const response = await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 60000, referer: config.storeUrl });
      await page.waitForTimeout(config.pageWaitMs);
      const landed = page.url();
      if (response && response.status() >= 400) { console.warn(`[STORE] ${listUrl} → HTTP ${response.status()}`); continue; }
      if (/nid\.naver\.com|nidlogin/.test(landed)) { console.warn(`[STORE] ${listUrl} → 로그인 화면으로 넘어감, 다음 주소 시도`); await page.waitForTimeout(2000); continue; }
      opened = true;
      break;
    }
    if (!opened) throw new Error('전체상품 화면이 모두 네이버 로그인 화면으로 넘어갔습니다.');
    await detectBlockedPage(page);
    await progressiveScroll(page, 3);

    const first = await page.evaluate(() => {
      const state = window.__PRELOADED_STATE__?.categoryProducts;
      return state ? { items: state.simpleProducts || [], totalCount: state.totalCount ?? null } : null;
    });
    const pagerCount = await page.evaluate(() => [...document.querySelectorAll('a')].filter((a) => /^\d{1,2}$/.test(a.innerText.trim()) && a.hasAttribute('aria-current')).length);
    console.log(`[STORE] 열린 주소: ${page.url()} / 미리 담긴 자료: ${first ? `${first.items.length}개` : '없음'} / 페이지 번호 ${pagerCount}개`);

    // 페이지 번호를 누르고 그때 오는 목록 응답을 읽는다. n번이 화면에 없으면 «다음»(다음 10페이지 묶음)을 누른다.
    const clickPage = async (pageNumber) => {
      const waitList = page.waitForResponse(
        (res) => /\/categories\/[^/]+\/products\?/.test(res.url()) && new RegExp(`[?&]page=${pageNumber}(&|$)`).test(res.url()),
        { timeout: 20000 }
      ).catch(() => null);
      const how = await page.evaluate((n) => {
        const anchors = [...document.querySelectorAll('a')];
        let target = anchors.find((a) => a.innerText.trim() === String(n) && a.getAttribute('aria-current') === 'false');
        if (target) { target.click(); return 'number'; }
        target = anchors.find((a) => a.innerText.trim() === '다음');
        if (target && target.getAttribute('aria-disabled') !== 'true') { target.click(); return 'next'; }
        return null;
      }, pageNumber);
      if (!how) return null;
      const res = await waitList;
      if (!res || !res.ok()) {
        console.warn(`[STORE] ${pageNumber}페이지 응답을 읽지 못했습니다 (${res ? res.status() : '응답 없음'}).`);
        return [];
      }
      const data = await res.json().catch(() => null);
      if (data?.totalCount) totalCount = data.totalCount;
      return data?.simpleProducts || [];
    };

    let startPage = 2;
    if (first && first.items.length) {
      totalCount = first.totalCount;
      console.log(`[STORE] 1페이지: ${first.items.length}개, 신규 ${add(first.items)}개 (전체 ${totalCount ?? '?'}개)`);
    } else {
      // 미리 담긴 자료가 없으면(GitHub 서버에서 열 때) 2페이지를 눌렀다가 1페이지로 돌아와 둘 다 응답으로 읽는다.
      const p2 = await clickPage(2);
      if (!p2) throw new Error('전체상품 화면에서 페이지 번호를 찾지 못했습니다.');
      console.log(`[STORE] 2페이지: ${p2.length}개, 신규 ${add(p2)}개 (전체 ${totalCount ?? '?'}개)`);
      await page.waitForTimeout(Math.max(config.requestDelayMs, 1500));
      const p1 = await clickPage(1);
      console.log(`[STORE] 1페이지: ${(p1 || []).length}개, 신규 ${add(p1)}개`);
      if (!byId.size) throw new Error('전체상품 목록 응답을 읽지 못했습니다.');
      startPage = 3;
      // 1페이지에서 다시 3페이지로 가야 하므로 잠깐 쉬어 준다.
      await page.waitForTimeout(Math.max(config.requestDelayMs, 1500));
    }

    for (let pageNumber = startPage; pageNumber <= config.maxStorePages; pageNumber += 1) {
      if (totalCount && byId.size >= totalCount) break;
      if (byId.size >= config.maxProducts) break;
      const items = await clickPage(pageNumber);
      if (!items) break;
      if (!items.length) break;
      const added = add(items);
      console.log(`[STORE] ${pageNumber}페이지: ${items.length}개, 신규 ${added}개`);
      if (!added) break;
      await page.waitForTimeout(Math.max(config.requestDelayMs, 1500));
    }

    return { products: [...byId.values()].slice(0, config.maxProducts), totalCount };
  } catch (error) {
    await saveDebug(page, debugDir, 'store-all-products');
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

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
  const soldOut = status ? status !== 'SALE' : null;
  return finalizeProduct({
    id: String(raw.id),
    url: `${storeUrl}/products/${raw.id}`,
    name: raw.dispName || raw.name,
    currentPrice: discounted ?? salePrice,
    originalPrice: salePrice,
    discountRate: toNumber(raw.benefitsView?.discountedRatio),
    stockQuantity: toNumber(raw.stockQuantity),
    soldOut,
    stockStatus: STATUS_TEXT[status] || status || '확인 불가',
    imageUrl: raw.representativeImageUrl,
    source: 'store-all'
  }, storeUrl);
}

async function scrapeStorePages(context, config, debugDir) {
  const allProducts = [];
  const seenIds = new Set();
  let emptyOrRepeatedPages = 0;

  for (let pageNumber = 1; pageNumber <= config.maxStorePages; pageNumber += 1) {
    const pageUrl = `${config.storeUrl}/category/ALL?st=RECENT&cp=${pageNumber}`;
    const result = await scrapeListingPage(context, pageUrl, config, debugDir, pageNumber);

    let newOnPage = 0;
    for (const product of result) {
      if (!seenIds.has(product.id)) {
        seenIds.add(product.id);
        allProducts.push(product);
        newOnPage += 1;
      }
    }

    console.log(`[STORE] ${pageNumber}페이지: ${result.length}개 감지, 신규 ${newOnPage}개`);
    if (!result.length || newOnPage === 0) emptyOrRepeatedPages += 1;
    else emptyOrRepeatedPages = 0;

    if (allProducts.length >= config.maxProducts || emptyOrRepeatedPages >= 2) break;
    await sleep(config.requestDelayMs);
  }

  if (!allProducts.length) {
    console.log('[STORE] 카테고리 페이지 결과가 없어 스토어 홈으로 재시도합니다.');
    const fallback = await scrapeListingPage(context, config.storeUrl, config, debugDir, 0);
    allProducts.push(...fallback);
  }

  return mergeProducts(allProducts).slice(0, config.maxProducts);
}

async function scrapeListingPage(context, url, config, debugDir, pageNumber) {
  const page = await context.newPage();
  const jsonPayloads = [];
  attachJsonCollector(page, jsonPayloads);

  try {
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
      referer: config.storeUrl
    });

    if (response && response.status() >= 400) {
      throw new Error(`스토어 페이지 HTTP ${response.status()}`);
    }

    await page.waitForTimeout(config.pageWaitMs);
    await detectBlockedPage(page);
    await progressiveScroll(page);
    await page.waitForTimeout(900);

    const domProducts = await extractDomProducts(page, config.storeUrl);
    const jsonProducts = jsonPayloads.flatMap(({ data }) => extractProductsFromJson(data, config.storeUrl));

    return mergeProducts([
      ...domProducts.map((item) => ({ ...item, source: 'store-dom' })),
      ...jsonProducts.map((item) => ({ ...item, source: 'store-json' }))
    ]);
  } catch (error) {
    await saveDebug(page, debugDir, `store-page-${pageNumber || 'home'}`);
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeProductPage(context, productUrl, config, debugDir) {
  const page = await context.newPage();
  const jsonPayloads = [];
  attachJsonCollector(page, jsonPayloads, true);

  try {
    const response = await page.goto(productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
      referer: config.storeUrl
    });
    if (response && response.status() >= 400) throw new Error(`상품 페이지 HTTP ${response.status()}`);

    await page.waitForTimeout(config.pageWaitMs);
    await detectBlockedPage(page);
    await progressiveScroll(page, 3);
    await page.waitForTimeout(1200);

    const targetId = productIdFromUrl(productUrl);
    const preferredPayload = [...jsonPayloads]
      .reverse()
      .find(({ url }) => /\/i\/v2\/channels\/[^/]+\/products\/\d+/.test(url) && url.includes(targetId));

    let product = preferredPayload
      ? extractProductDetail(preferredPayload.data, productUrl, config.storeUrl)
      : null;

    for (const payload of jsonPayloads) {
      const extracted = extractProductsFromJson(payload.data, config.storeUrl)
        .find((item) => item.id === targetId);
      product = mergeTwoProducts(product, extracted);
    }

    const dom = await extractProductDom(page, productUrl, config.storeUrl);
    product = finalizeProduct(mergeTwoProducts(product, dom), config.storeUrl);

    if (!product) throw new Error('상품 상세 정보를 추출하지 못했습니다.');
    return { ...product, source: 'pinned-detail' };
  } catch (error) {
    await saveDebug(page, debugDir, `product-${productIdFromUrl(productUrl) || 'unknown'}`);
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

function attachJsonCollector(page, output, detailOnly = false) {
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('smartstore.naver.com')) return;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      const relevant = detailOnly
        ? /\/i\/v2\/channels\/[^/]+\/products\/\d+|benefits\/by-product|\/products\//.test(url)
        : /product|category|search|best|display|store|channel/i.test(url);
      if (!relevant) return;

      const length = Number(response.headers()['content-length'] || 0);
      if (length > 6_000_000) return;
      const data = await response.json().catch(() => null);
      if (data) output.push({ url, data });
    } catch {
      // Some responses cannot be read after navigation; DOM extraction remains as fallback.
    }
  });
}

async function progressiveScroll(page, rounds = 5) {
  for (let index = 0; index < rounds; index += 1) {
    await page.evaluate(() => {
      const distance = Math.max(650, Math.floor(document.body.scrollHeight / 4));
      window.scrollBy(0, distance);
    });
    await page.waitForTimeout(450);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(650);
}

async function detectBlockedPage(page) {
  const title = await page.title().catch(() => '');
  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const sample = `${title} ${body.slice(0, 2500)}`;
  if (/CAPTCHA|비정상적인 접근|자동입력 방지|접근이 제한|Too Many Requests|서비스 이용이 제한/i.test(sample)) {
    throw new Error(`네이버 접근 제한 페이지가 감지되었습니다: ${cleanText(title) || '제목 없음'}`);
  }
}

async function extractDomProducts(page, storeUrl) {
  const raw = await page.locator('a[href*="/products/"]').evaluateAll((anchors) => {
    const results = [];
    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute('href');
      if (!href) continue;

      let container = anchor;
      for (let i = 0; i < 6 && container.parentElement; i += 1) {
        const parent = container.parentElement;
        const textLength = (parent.innerText || '').trim().length;
        if (['LI', 'ARTICLE'].includes(parent.tagName) || (textLength >= 20 && textLength <= 1200)) {
          container = parent;
        }
        if (['LI', 'ARTICLE'].includes(parent.tagName)) break;
      }

      const text = (container.innerText || anchor.innerText || '').replace(/\s+/g, ' ').trim();
      const img = container.querySelector('img') || anchor.querySelector('img');
      const alt = img?.getAttribute('alt') || '';
      const title = anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '';
      const imageUrl = img?.currentSrc || img?.getAttribute('src') || img?.getAttribute('data-src') || null;

      const priceMatches = [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,})\s*원/g)]
        .map((match) => Number(match[1].replace(/,/g, '')))
        .filter((value) => Number.isFinite(value) && value > 0);
      const discountMatch = text.match(/(?:^|\s)(\d{1,2})\s*%/);
      const soldOut = /품절|일시품절|판매종료|판매 종료/.test(text);

      const lines = (container.innerText || anchor.innerText || '')
        .split(/\n+/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .filter((line) => !/^\d[\d,]*\s*원$/.test(line))
        .filter((line) => !/^\d{1,2}\s*%$/.test(line))
        .filter((line) => !/무료배송|배송비|리뷰|구매건수|찜|적립/.test(line));

      results.push({
        href,
        text,
        name: alt || title || lines[0] || null,
        imageUrl,
        prices: priceMatches,
        discountRate: discountMatch ? Number(discountMatch[1]) : null,
        soldOut
      });
    }
    return results;
  });

  return raw.map((item) => {
    const url = normalizeProductUrl(item.href, storeUrl);
    const id = productIdFromUrl(url);
    if (!id) return null;
    const prices = [...new Set(item.prices)].sort((a, b) => a - b);
    return finalizeProduct({
      id,
      url,
      name: item.name,
      currentPrice: prices[0] ?? null,
      originalPrice: prices.length > 1 ? prices.at(-1) : null,
      discountRate: item.discountRate,
      soldOut: item.soldOut,
      stockStatus: item.soldOut ? '품절' : '판매 가능',
      imageUrl: item.imageUrl,
      source: 'store-dom'
    }, storeUrl);
  }).filter(Boolean);
}

async function extractProductDom(page, productUrl, storeUrl) {
  const data = await page.evaluate(() => {
    const meta = (selector) => document.querySelector(selector)?.getAttribute('content') || null;
    const bodyText = document.body?.innerText || '';
    const title = meta('meta[property="og:title"]') || document.querySelector('h1')?.textContent || document.title;
    const image = meta('meta[property="og:image"]');
    const metaPrice = meta('meta[property="product:price:amount"]');

    const priceTexts = [...document.querySelectorAll('strong, em, span')]
      .map((element) => element.textContent?.trim() || '')
      .filter((text) => /\d[\d,]*\s*원/.test(text))
      .slice(0, 30);

    const buyButton = [...document.querySelectorAll('button, a')]
      .find((element) => /구매하기|장바구니/.test(element.textContent || ''));
    const soldOutElement = [...document.querySelectorAll('button, strong, em, span, div')]
      .find((element) => /^(품절|일시품절|판매종료|판매 종료)$/.test((element.textContent || '').trim()));

    return {
      title,
      image,
      metaPrice,
      priceTexts,
      hasBuyButton: Boolean(buyButton),
      hasSoldOutElement: Boolean(soldOutElement),
      bodySample: bodyText.slice(0, 5000)
    };
  });

  const prices = data.priceTexts
    .flatMap((text) => [...text.matchAll(/(\d{1,3}(?:,\d{3})+|\d{3,})\s*원/g)])
    .map((match) => toNumber(match[1]))
    .filter((value) => value !== null && value > 0)
    .sort((a, b) => a - b);

  const metaPrice = toNumber(data.metaPrice);
  const soldOut = data.hasSoldOutElement ? true : (data.hasBuyButton ? false : null);
  const id = productIdFromUrl(productUrl);

  return finalizeProduct({
    id,
    url: productUrl,
    name: cleanText(data.title?.replace(/\s*:\s*네이버 스마트스토어.*$/i, '')),
    currentPrice: metaPrice ?? prices[0] ?? null,
    originalPrice: prices.length > 1 ? prices.at(-1) : null,
    soldOut,
    stockStatus: soldOut === true ? '품절' : (soldOut === false ? '판매 가능' : '확인 불가'),
    imageUrl: data.image,
    source: 'product-dom'
  }, storeUrl);
}

async function saveDebug(page, debugDir, name) {
  try {
    ensureDir(debugDir);
    await page.screenshot({ path: path.join(debugDir, `${name}.png`), fullPage: true });
    fs.writeFileSync(path.join(debugDir, `${name}.html`), await page.content(), 'utf8');
  } catch {
    // Debug capture is best effort only.
  }
}
