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
      for (const line of added.split('\n').filter(Boolean)) {
        if (line.includes('otpDevOnly') && line.includes(phone)) {
          try { const obj = JSON.parse(line); if (obj.otpDevOnly) return resolve(obj.otpDevOnly); } catch {}
        }
      }
      if (Date.now() - start > timeoutMs) return reject(new Error('OTP not found in log within timeout'));
      setTimeout(tick, 200);
    };
    tick();
  });
}
function currentLogLen() { return readFileSync(LOG_PATH, 'utf8').length; }

const consoleErrors = [];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));

  const phone = '+237692' + String(Math.floor(Math.random() * 900000) + 100000);
  const pin = '246813';

  await page.goto(BASE);
  await page.click('#authTabRegister');
  await page.fill('#regFirstName', 'Test');
  await page.fill('#regLastName', 'Repeat');
  await page.fill('#regPhone', phone);
  await page.selectOption('#regProfileType', 'salarie');
  const logLenBefore = currentLogLen();
  await page.click('#regSendOtpBtn');
  await page.waitForSelector('#registerOtpForm:not([hidden])');
  const code = await waitForOtp(phone, logLenBefore);
  await page.fill('#regOtpCode', code);
  await page.click('#regVerifyOtpBtn');
  await page.waitForSelector('#registerPinForm:not([hidden])');
  await page.fill('#regPin', pin);
  await page.fill('#regPinConfirm', pin);
  await page.click('#regCreateAccountBtn');
  await page.waitForFunction(() => { const s = document.getElementById('appShell'); return s && !s.hidden; }, { timeout: 10000 });
  console.log('Registered + logged in.');

  console.log('--- Create original transaction (revenu, Commerce, 12345, Especes, note) ---');
  await page.click('[data-view="transactions"]');
  await page.selectOption('#txType', 'revenu');
  await page.waitForTimeout(150);
  await page.selectOption('#txCategory', 'Commerce');
  await page.fill('#txAmount', '12345');
  await page.selectOption('#txMethod', 'Espèces');
  await page.fill('#txNote', 'Vente originale');
  await page.click('#txForm button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('#txTable tbody').textContent.includes('Vente originale'), { timeout: 8000 });
  console.log('Original transaction created.');

  console.log('--- Click "Repeter" on that row ---');
  const repeatBtn = page.locator('[data-repeat]').first();
  await repeatBtn.click();
  await page.waitForTimeout(400);

  const formState = await page.evaluate(() => ({
    type: document.getElementById('txType').value,
    category: document.getElementById('txCategory').value,
    amount: document.getElementById('txAmount').value,
    method: document.getElementById('txMethod').value,
    date: document.getElementById('txDate').value,
    note: document.getElementById('txNote').value,
    focused: document.activeElement && document.activeElement.id,
  }));
  console.log('Form pre-filled state:', JSON.stringify(formState, null, 2));

  const today = new Date().toISOString().slice(0, 10);
  const checks = [
    ['type', formState.type === 'revenu'],
    ['category', formState.category === 'Commerce'],
    ['amount', formState.amount === '12345'],
    ['method', formState.method === 'Espèces'],
    ['date is today', formState.date === today],
    ['note copied', formState.note === 'Vente originale'],
    ['amount field focused', formState.focused === 'txAmount'],
  ];
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + label);
    if (!ok) allOk = false;
  }

  console.log('--- Tweak amount and submit the repeated transaction ---');
  await page.fill('#txAmount', '20000');
  await page.click('#txForm button[type="submit"]');
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#txTable tbody tr')].filter(r => r.textContent.includes('Vente originale'));
    return rows.length === 2;
  }, { timeout: 8000 });
  console.log('Two rows with the same note now exist (original + repeated).');

  const amounts = await page.evaluate(() => [...document.querySelectorAll('#txTable tbody tr')]
    .filter(r => r.textContent.includes('Vente originale'))
    .map(r => r.textContent.trim()));
  console.log('Rows:', JSON.stringify(amounts, null, 2));

  console.log('--- Console errors ---', consoleErrors.length ? consoleErrors : '(none)');

  await browser.close();
  if (!allOk || consoleErrors.length) process.exitCode = 1;
})().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
});
