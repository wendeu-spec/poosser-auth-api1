import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:5173/poosser_prototype.html';
const LOG_PATH = '/tmp/backend.log';

function waitForOtp(phone, sinceLen, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const content = readFileSync(LOG_PATH, 'utf8');
      const added = content.slice(sinceLen);
      const lines = added.split('\n').filter(Boolean);
      for (const line of lines) {
        if (line.includes('otpDevOnly') && line.includes(phone)) {
          try {
            const obj = JSON.parse(line);
            if (obj.otpDevOnly) return resolve(obj.otpDevOnly);
          } catch {}
        }
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('OTP not found in log within timeout'));
      setTimeout(tick, 200);
    };
    tick();
  });
}

function currentLogLen() {
  return readFileSync(LOG_PATH, 'utf8').length;
}

const consoleErrors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const phone = '+237690' + String(Math.floor(Math.random() * 900000) + 100000);
  const pin = '482913';

  console.log('--- 1. Load page, should show auth screen ---');
  await page.goto(BASE);
  await page.waitForSelector('#authScreen:not([hidden])');
  const appHiddenInitially = await page.getAttribute('#appShell', 'hidden');
  console.log('appShell hidden initially:', appHiddenInitially !== null);

  console.log('--- 2. Switch to Inscription tab, fill identity ---');
  await page.click('#authTabRegister');
  await page.fill('#regFirstName', 'Yannis');
  await page.fill('#regLastName', 'Test');
  await page.fill('#regPhone', phone);
  await page.selectOption('#regProfileType', 'salarie');

  const logLenBefore = currentLogLen();
  await page.click('#regSendOtpBtn');
  await page.waitForSelector('#registerOtpForm:not([hidden])', { timeout: 8000 });
  console.log('OTP step shown, waiting for code in server log for', phone);

  const code = await waitForOtp(phone, logLenBefore);
  console.log('Captured OTP:', code);

  console.log('--- 3. Verify OTP ---');
  await page.fill('#regOtpCode', code);
  await page.click('#regVerifyOtpBtn');
  await page.waitForSelector('#registerPinForm:not([hidden])', { timeout: 8000 });

  console.log('--- 4. Set PIN, create account ---');
  await page.fill('#regPin', pin);
  await page.fill('#regPinConfirm', pin);
  await page.click('#regCreateAccountBtn');

  await page.waitForFunction(() => {
    const shell = document.getElementById('appShell');
    return shell && !shell.hidden;
  }, { timeout: 10000 });
  console.log('App shell visible after registration.');

  const userName = await page.textContent('#sidebarUserName');
  console.log('Sidebar user name:', userName);

  await page.waitForTimeout(500);
  const dashboardEmptyState = await page.textContent('#recentTxTable');
  console.log('Recent tx table (should be empty state):', dashboardEmptyState.trim().slice(0, 80));

  console.log('--- 5. Add a transaction via the real form ---');
  await page.click('[data-view="transactions"]');
  await page.selectOption('#txType', 'depense');
  await page.waitForTimeout(100);
  await page.selectOption('#txCategory', 'Alimentation');
  await page.fill('#txAmount', '15000');
  await page.selectOption('#txMethod', 'Mobile Money');
  await page.fill('#txNote', 'Test e2e Phase 2');
  await page.click('#txForm button[type="submit"]');

  await page.waitForFunction(() => {
    const tbody = document.querySelector('#txTable tbody');
    return tbody && tbody.textContent.includes('Test e2e Phase 2');
  }, { timeout: 8000 });
  console.log('Transaction appears in table after real API call.');

  console.log('--- 6. Reload page: should require login again (no persistence) ---');
  await page.reload();
  await page.waitForSelector('#authScreen:not([hidden])');
  const appHiddenAfterReload = await page.getAttribute('#appShell', 'hidden');
  console.log('appShell hidden after reload:', appHiddenAfterReload !== null);

  console.log('--- 7. Log back in, verify the transaction persisted server-side ---');
  await page.fill('#loginPhone', phone);
  await page.fill('#loginPin', pin);
  await page.click('#loginSubmitBtn');

  await page.waitForFunction(() => {
    const shell = document.getElementById('appShell');
    return shell && !shell.hidden;
  }, { timeout: 10000 });

  await page.click('[data-view="transactions"]');
  await page.waitForFunction(() => {
    const tbody = document.querySelector('#txTable tbody');
    return tbody && tbody.textContent.includes('Test e2e Phase 2');
  }, { timeout: 8000 });
  console.log('Transaction re-appears after fresh login: real persistence confirmed.');

  console.log('--- 8. Logout returns to auth screen ---');
  await page.click('#logoutBtn');
  await page.waitForSelector('#authScreen:not([hidden])', { timeout: 8000 });
  console.log('Back on auth screen after logout.');

  await page.screenshot({ path: '/tmp/claude-0/-home-claude/128211e0-ceff-505a-bec3-c9456f88ae2f/scratchpad/phase2-final.png' });

  console.log('--- Console errors captured during run ---');
  console.log(consoleErrors.length ? consoleErrors : '(none)');

  await browser.close();
  if (consoleErrors.length) process.exitCode = 1;
})().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
});
