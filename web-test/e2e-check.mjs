import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function otpForPhone(phone) {
  const log = readFileSync("/tmp/poosser-api.log", "utf8");
  const re = new RegExp(`"phoneE164":"${phone.replace("+", "\\+")}"[^}]*"otpDevOnly":"(\\d{6})"`, "g");
  const matches = [...log.matchAll(re)];
  return matches.at(-1)?.[1];
}

async function waitForOtp(phone, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const code = otpForPhone(phone);
    if (code) return code;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for OTP for ${phone}`);
}

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console error]", msg.text()); });

await page.goto("http://localhost:5173/index.html");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/shot-1-loaded.png" });

const phone = "+237" + String(Math.floor(600000000 + Math.random() * 90000000)).padStart(9, "0").slice(0, 9);
console.log("test phone:", phone);

// --- 1. Inscription ---------------------------------------------------
await page.fill("#reg-phone", phone);
await page.click("#reg-requestOtp");

const otp = await waitForOtp(phone);
console.log("captured OTP from server log:", otp);

await page.fill("#reg-code", otp);
await page.click("#reg-verify");
await page.waitForFunction(() => window.__regTicket, { timeout: 8000 });

await page.click("#reg-register");
await page.waitForFunction(() => document.getElementById("sessPill").textContent.includes("Connecté"), { timeout: 8000 });
await page.screenshot({ path: "/tmp/shot-2-registered.png" });

const sessPill = await page.textContent("#sessPill");
console.log("session pill after register:", sessPill);
if (!sessPill.includes("Connecté")) throw new Error("Registration did not establish a session");

// --- 3. Appareils -------------------------------------------------------
await page.click('nav button[data-panel="p-devices"]');
await page.click("#dev-list");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/shot-3-devices.png" });
const rowCount = await page.locator("#dev-table tbody tr").count();
console.log("devices listed:", rowCount);
if (rowCount < 1) throw new Error("No devices listed");

// --- 7. Journal de sécurité ------------------------------------------
await page.click('nav button[data-panel="p-events"]');
await page.click("#ev-list");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/shot-4-events.png" });
const evCount = await page.locator("#ev-table tbody tr").count();
console.log("security events listed:", evCount);
if (evCount < 1) throw new Error("No security events listed");

// --- 6. Session : refresh puis reuse detection --------------------------
await page.click('nav button[data-panel="p-session"]');
await page.click("#sess-refresh");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/shot-5-refresh.png" });

const logText = await page.textContent("#log");
console.log("has 200 on /auth/refresh:", logText.includes("POST /auth/refresh → 200"));

await browser.close();
console.log("E2E CHECK OK");
