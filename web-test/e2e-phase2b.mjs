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
const alerts = [];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.on('requestfailed', (req) => console.log('[requestfailed]', req.url(), req.failure()?.errorText));
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log('[navigated]', f.url()); });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('dialog', async (dialog) => { console.log('[dialog]', dialog.type(), dialog.message()); alerts.push(dialog.message()); await dialog.accept('10000'); });

  const phone = '+237691' + String(Math.floor(Math.random() * 900000) + 100000);
  const pin = '135791';

  await page.goto(BASE);
  await page.click('#authTabRegister');
  await page.fill('#regFirstName', 'Aïcha');
  await page.fill('#regLastName', 'Ngo');
  await page.fill('#regPhone', phone);
  await page.selectOption('#regProfileType', 'commercant');
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

  console.log('--- Budget ---');
  await page.click('[data-view="budget"]');
  await page.selectOption('#budgetCategory', 'Transport');
  await page.fill('#budgetLimit', '25000');
  await page.click('#budgetForm button[type="submit"]');
  await page.waitForTimeout(3000);
  const diag = await page.evaluate(() => ({
    budgetListHTML: document.getElementById('budgetList') ? document.getElementById('budgetList').innerHTML : 'NO_ELEMENT',
    stateBudgets: typeof state !== 'undefined' ? state.budgets : 'NO_STATE',
    authMsg: document.getElementById('authMsg') ? document.getElementById('authMsg').innerHTML : '',
    url: location.href,
  }));
  console.log('DIAG:', JSON.stringify(diag, null, 2));
  if (JSON.stringify(diag.budgetListHTML).includes('Transport')) {
    console.log('Budget created OK.');
  } else {
    throw new Error('Budget not reflected in DOM after 3s wait — see DIAG above.');
  }

  console.log('--- Épargne (savings goal + contribution) ---');
  await page.click('[data-view="epargne"]');
  await page.click('#openGoalForm');
  await page.fill('#goalName', 'Fonds e2e');
  await page.fill('#goalTarget', '300000');
  await page.fill('#goalCurrent', '50000');
  await page.fill('#goalDeadline', '2027-01-31');
  await page.click('#goalForm button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('goalsGrid').textContent.includes('Fonds e2e'), { timeout: 8000 });
  console.log('Savings goal created OK.');
  await page.click('[data-contribute]');
  await page.waitForTimeout(800);
  console.log('Contribution attempted (prompt auto-accepted with 10000).');

  console.log('--- Tontine (create, mark paid x2, close round) ---');
  await page.click('[data-view="tontine"]');
  await page.click('#openTontineForm');
  await page.fill('#tonName', 'Tontine e2e');
  await page.fill('#tonAmount', '10000');
  await page.selectOption('#tonFreq', 'Mensuelle');
  await page.fill('#tonMembers', 'Alpha, Beta');
  await page.click('#tontineForm button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('tontineList').textContent.includes('Tontine e2e'), { timeout: 8000 });
  console.log('Tontine created OK.');

  // Chaque clic déclenche un appel API puis un re-rendu complet de la liste
  // (innerHTML remplacé) : on doit donc re-cibler l'élément par index à
  // chaque itération plutôt que de réutiliser un ElementHandle devenu obsolète.
  const memberCount = await page.locator('.paid-check').count();
  for (let i = 0; i < memberCount; i++) {
    await page.locator('.paid-check').nth(i).click();
    await page.waitForTimeout(600);
  }
  console.log('Marked all members as paid.');

  await page.click('[data-close-round]');
  await page.waitForFunction(() => document.getElementById('tontineList').textContent.includes('Tour 1'), { timeout: 8000 });
  console.log('Round closed OK, history shows Tour 1.');

  console.log('--- Planner (create event, mark realise) ---');
  await page.click('[data-view="planner"]');
  await page.click('#openPlannerForm');
  await page.fill('#evTitle', 'Evenement e2e');
  const d = new Date(); d.setDate(d.getDate() + 2);
  await page.fill('#evDate', d.toISOString().slice(0, 10));
  await page.fill('#evTime', '10:00');
  await page.selectOption('#evDuration', '30');
  await page.selectOption('#evType', 'depense');
  await page.waitForTimeout(100);
  await page.selectOption('#evCategory', 'Autres');
  await page.fill('#evAmount', '5000');
  await page.click('#plannerForm button[type="submit"]');
  await page.waitForFunction(() => document.getElementById('plannerUpcoming').textContent.includes('Evenement e2e'), { timeout: 8000 });
  console.log('Planner event created OK.');

  await page.click('[data-realise]');
  await page.waitForFunction(() => document.getElementById('plannerHistory').textContent.includes('Evenement e2e'), { timeout: 8000 });
  console.log('Event marked realise OK, moved to history.');

  await page.click('[data-view="transactions"]');
  await page.waitForFunction(() => document.querySelector('#txTable tbody').textContent.includes('Evenement e2e'), { timeout: 8000 });
  console.log('Realise correctly created a matching transaction.');

  console.log('--- Alerts captured ---', alerts.length ? alerts : '(none)');
  console.log('--- Console errors ---', consoleErrors.length ? consoleErrors : '(none)');

  await page.screenshot({ path: '/tmp/claude-0/-home-claude/128211e0-ceff-505a-bec3-c9456f88ae2f/scratchpad/phase2b-final.png', fullPage: true });

  await browser.close();
  if (consoleErrors.length) process.exitCode = 1;
})().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
});
