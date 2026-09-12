import { test, expect } from '@playwright/test';
import { treatment, pdfFixture } from '../fixtures.mjs';
import filmline from '../../../filmline.cc/video-worker/index.js';
// Playwright's loader wraps this sibling repository's ESM default under CJS.
const renderer = filmline.default || filmline;

for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }]) {
  test(`upload and editorial review at ${viewport.width}px (controlled API)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let job = null; const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (path === '/api/auth/login') body = { token: 'test-browser-token-0001' };
      else if (path === '/api/book2film/jobs') body = { jobs: job ? [job] : [] };
      else if (path === '/api/book2film/adapt') {
        expect(route.request().headers()['x-rights-confirmed']).toBe('true');
        job = { id: 'fixture-job', name: 'The Last Light.pdf', stage: 'extract', extracted_pages: 0, document_pages: 1, summarized_pages: 0, blank_pages: [] }; body = { job };
      } else if (path.endsWith('/advance')) {
        const script = treatment(); const rendered = await (await renderer.fetch(new Request('https://internal/api/render', { method: 'POST', body: JSON.stringify(script) }), {})).json();
        job = { ...job, stage: 'complete', extracted_pages: 1, summarized_pages: 1, result: { ...script, video: rendered.video } }; body = { job };
      } else if (path.includes('/pages/')) body = { page: 1, text: 'Mara repairs the lighthouse.' };
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/'); await expect(page.getByRole('heading', { name: /Every great film/ })).toBeVisible();
    await page.screenshot({ path: `test-results/studio-${viewport.width}-landing.png`, fullPage: true });
    await page.getByLabel('Email', { exact: true }).fill('operator@example.test');
    await page.getByLabel('Password', { exact: true }).fill('fixture-password');
    await page.getByRole('button', { name: 'Sign in to the pilot' }).click();
    await page.getByLabel('Choose manuscript PDF').setInputFiles({ name: 'The Last Light.pdf', mimeType: 'application/pdf', buffer: pdfFixture() });
    await expect(page.getByRole('button', { name: 'Save manuscript' })).toBeDisabled();
    await page.getByLabel('I own this work').check(); await page.getByRole('button', { name: 'Save manuscript' }).click();
    await page.getByRole('button', { name: 'Continue adaptation' }).click();
    await expect(page.getByText('Ready for your editorial review')).toBeVisible();
    await expect(page.locator('.beats li')).toHaveCount(12);
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', '');
    await page.getByRole('button', { name: 'p. 1', exact: true }).first().click();
    await expect(page.getByText('Mara repairs the lighthouse.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download treatment' })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/studio-${viewport.width}-review.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
