import { expect, test } from '@playwright/test';
import { clickAndReadPdfDownload, fixture, openFeature } from './test-helpers.js';

const allowedExternalHosts = new Set([
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'region1.google-analytics.com',
]);

test('ファイル選択・プレビュー時に許可外通信やfixture情報の送信がない', async ({ page }) => {
  const externalRequests = [];
  const cspViolations = [];
  const sensitiveMarkers = [
    'simple-3pages.pdf',
    'sample.png',
    'sample.heic',
    'PDF_MANAGER_PRIVATE_FIXTURE_SENTINEL',
  ];

  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (!['http:', 'https:'].includes(requestUrl.protocol)) return;
    if (requestUrl.origin === 'http://127.0.0.1:4173') return;
    externalRequests.push({
      host: requestUrl.hostname,
      url: request.url(),
      method: request.method(),
      postData: request.postData() || '',
    });
  });
  page.on('console', (message) => {
    if (/content security policy/i.test(message.text())) cspViolations.push(message.text());
  });
  await page.route('https://**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname === 'www.googletagmanager.com') {
      await route.fulfill({
        contentType: 'application/javascript',
        body: `
          window.__gaTestScriptLoaded = true;
          fetch('https://www.google-analytics.com/g/collect?tid=G-X61GPE088Q', {
            method: 'POST',
            body: 'event=page_view'
          }).then(() => { window.__gaTestPageviewSent = true; });
        `,
      });
      return;
    }
    if (requestUrl.hostname === 'www.google-analytics.com' || requestUrl.hostname === 'region1.google-analytics.com') {
      await route.fulfill({ status: 204, body: '' });
      return;
    }
    await route.abort();
  });
  page.on('dialog', async (dialog) => {
    if (dialog.type() === 'prompt') await dialog.accept('network-test-output');
    else await dialog.dismiss();
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => Boolean(window.__gaTestScriptLoaded))).toBe(true);
  await expect.poll(() => page.evaluate(() => Boolean(window.__gaTestPageviewSent))).toBe(true);

  const extractPanel = await openFeature(page, 'extract');
  await page.locator('#extract-file').setInputFiles(fixture('simple-3pages.pdf'));
  await expect(page.locator('#extract-preview .single-page-item')).toHaveCount(3);
  await page.locator('#extract-start').fill('1');
  await page.locator('#extract-end').fill('2');
  await clickAndReadPdfDownload(page, extractPanel.getByRole('button', { name: '抽出して保存' }));

  await page.locator('.feature-back-btn').first().click();
  const imagePanel = await openFeature(page, 'image2pdf');
  await page.locator('#image2pdf-files').setInputFiles([
    fixture('sample.png'),
    fixture('sample.heic'),
  ]);
  await expect(page.locator('#image2pdf-list .merge-item')).toHaveCount(2);
  await clickAndReadPdfDownload(page, imagePanel.getByRole('button', { name: 'PDF化して保存' }));

  for (const request of externalRequests) {
    expect(allowedExternalHosts.has(request.host), `許可外ホスト: ${request.url}`).toBe(true);
    if (request.host === 'www.googletagmanager.com') {
      expect(['GET', 'HEAD'].includes(request.method), `GTM通信メソッド: ${request.method}`).toBe(true);
    } else {
      expect(['GET', 'HEAD', 'POST'].includes(request.method), `GA通信メソッド: ${request.method}`).toBe(true);
    }
    for (const marker of sensitiveMarkers) {
      expect(`${request.url}\n${request.postData}`).not.toContain(marker);
    }
  }
  expect(externalRequests.some((request) => request.host === 'www.googletagmanager.com')).toBe(true);
  expect(externalRequests.some((request) =>
    request.host === 'www.google-analytics.com' && request.method === 'POST',
  )).toBe(true);
  expect(cspViolations).toEqual([]);
});

test('自己ホストした必須ライブラリの読込失敗を表示し、CDNへフォールバックしない', async ({ page }) => {
  const externalHosts = [];
  page.on('request', (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.origin !== 'http://127.0.0.1:4173' && ['http:', 'https:'].includes(requestUrl.protocol)) {
      externalHosts.push(requestUrl.hostname);
    }
  });
  await page.route('**/vendor/pdf-lib/pdf-lib.min.js', (route) => route.fulfill({ status: 404, body: '' }));
  await page.route('https://**/*', (route) => route.abort());

  await page.goto('./', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#action-status')).toContainText('PDF処理ライブラリを読み込めませんでした（PDF-Lib）');
  expect(externalHosts.every((host) => allowedExternalHosts.has(host))).toBe(true);
});
