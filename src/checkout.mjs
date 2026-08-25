import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { execSync } from "child_process";
import { firefox } from "playwright";
import { PROJECT_ROOT, getNetrcCredentials } from "./config.mjs";

export const BROWSER_PROFILE_DIR = path.join(PROJECT_ROOT, ".browser-profile", "firefox");
export const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, "screenshots");

function ensureDirs() {
  if (!fs.existsSync(BROWSER_PROFILE_DIR)) fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0";

/**
 * Extracts active cookies for fredmeyer.com / kroger.com from personal Firefox profile
 */
export function getPersonalFirefoxCookies() {
  const baseDir = path.join(os.homedir(), "Library/Application Support/Firefox/Profiles");
  if (!fs.existsSync(baseDir)) return [];

  let bestCookies = [];

  for (const profileName of fs.readdirSync(baseDir)) {
    const cookiesDb = path.join(baseDir, profileName, "cookies.sqlite");
    if (!fs.existsSync(cookiesDb)) continue;

    const tmpDb = `/tmp/fm_cookies_${profileName}.sqlite`;
    try {
      fs.copyFileSync(cookiesDb, tmpDb);
      const query = `SELECT host, name, value, path, isSecure, isHttpOnly, expiry, sameSite FROM moz_cookies WHERE host LIKE '\''%kroger%'\'' OR host LIKE '\''%fredmeyer%'\'';`;
      const output = execSync(`sqlite3 "${tmpDb}" "${query}"`, { encoding: "utf-8" });

      const cookies = [];
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const parts = line.split("|");
        const [host, name, value, cookiePath, isSecure, isHttpOnly, expiry, sameSite] = parts;
        if (name && value) {
          const domain = host.startsWith(".") ? host : "." + host;
          cookies.push({
            name,
            value,
            domain: domain.replace(/^\.\./, "."),
            path: cookiePath || "/",
            secure: isSecure === "1",
            httpOnly: isHttpOnly === "1",
            expires: expiry ? parseInt(expiry, 10) : undefined,
            sameSite: sameSite === "1" ? "Lax" : sameSite === "2" ? "Strict" : "None"
          });
        }
      }

      if (cookies.length > bestCookies.length) {
        bestCookies = cookies;
      }
    } catch {}
  }

  return bestCookies;
}

/**
 * Automatically sync cookies from personal Firefox profile into browser context
 */
export async function syncCookiesToContext(context) {
  const cookies = getPersonalFirefoxCookies();
  if (cookies.length > 0) {
    try {
      await context.addCookies(cookies);
      console.log(`✓ Auto-imported ${cookies.length} active session cookies from your personal Firefox profile!`);
      return true;
    } catch (err) {
      console.warn(`Warning: Could not import cookies: ${err.message}`);
    }
  }
  return false;
}

/**
 * Automatically dismisses privacy modals, terms updates, cookie banners, and overlays
 */
export async function dismissModalsAndBanners(page) {
  const modalCloseSelectors = [
    // Modal Close (X) buttons
    '[aria-modal="true"] button[aria-label*="lose" i]',
    '[aria-modal="true"] button[aria-label*="dismiss" i]',
    '[aria-modal="true"] button[data-testid*="close" i]',
    'button[aria-label="Close dialog"]',
    'button[aria-label="Close Modal"]',
    'button[aria-label="Close"]',
    'button[aria-label="close"]',
    'button[data-testid="close-button"]',
    '.kds-Modal-closeButton',
    // OneTrust / Optanon / Cookie banner buttons
    '#onetrust-accept-btn-handler',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Confirm My Choices")',
    // Privacy policy / Terms update confirmation buttons
    'button:has-text("I Understand")',
    'button:has-text("I Agree")',
    'button:has-text("Got It")',
    'button:has-text("Agree & Continue")',
    'button:has-text("Accept & Continue")',
    'button:has-text("Accept")'
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    let closedAny = false;
    for (const sel of modalCloseSelectors) {
      try {
        const elements = await page.$$(sel);
        for (const el of elements) {
          if (await el.isVisible()) {
            console.log(`🛡️  Auto-dismissing privacy banner / modal (${sel})...`);
            await el.click({ timeout: 2000 });
            closedAny = true;
            await page.waitForTimeout(1000);
          }
        }
      } catch {}
    }
    if (!closedAny) break;
  }
}

/**
 * Wait for any loading spinner to disappear
 */
async function waitForLoadingToFinish(page) {
  try {
    const loadingSpinner = await page.$('text="Loading..."');
    if (loadingSpinner && (await loadingSpinner.isVisible())) {
      console.log("⏳ Waiting for page loading spinner...");
      await page.waitForSelector('text="Loading..."', { state: "hidden", timeout: 15000 });
    }
  } catch {}
}

/**
 * Interactive login or cookie sync helper
 */
export async function openBrowserLogin() {
  ensureDirs();
  console.log("\n🦊 Launching Firefox for Fred Meyer session sync...");

  const context = await firefox.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT
  });

  await syncCookiesToContext(context);

  const page = context.pages()[0] || (await context.newPage());
  console.log("Navigating to https://www.fredmeyer.com/cart...");
  await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await dismissModalsAndBanners(page);

  console.log("\n✓ Session initialized! Cookies synced to .browser-profile/firefox.\n");
  await context.close();
}

/**
 * Automated Checkout Engine via Playwright Firefox
 */
export async function performAutomatedCheckout({
  scheduleDate = null,
  modality = "PICKUP",
  slotPreference = "earliest",
  dryRun = false,
  headless = true
} = {}) {
  ensureDirs();

  console.log(`\n🤖 Launching automated Firefox checkout (${modality}, ${scheduleDate || "next available"})...`);

  const context = await firefox.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT
  });

  // Always sync fresh cookies from personal Firefox profile
  await syncCookiesToContext(context);

  const page = context.pages()[0] || (await context.newPage());

  try {
    // 1. Navigate to Cart
    console.log("🛒 Navigating to https://www.fredmeyer.com/cart...");
    await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await dismissModalsAndBanners(page);
    await waitForLoadingToFinish(page);

    // 2. Check if login is needed and auto-fill if form is present
    const emailInput = await page.$('input[type="email"], input[name="email"], #email');
    if (emailInput && (await emailInput.isVisible())) {
      const creds = getNetrcCredentials();
      if (creds && creds.clientId && creds.clientSecret) {
        console.log("🔑 Auto-filling login credentials from .netrc...");
        await emailInput.fill(creds.clientId);
        const passInput = await page.$('input[type="password"], input[name="password"], #password');
        if (passInput) {
          await passInput.fill(creds.clientSecret);
          const submitBtn = await page.$('button[type="submit"], button:has-text("Sign In")');
          if (submitBtn) await submitBtn.click();
          await page.waitForTimeout(5000);
          await dismissModalsAndBanners(page);
          await waitForLoadingToFinish(page);
        }
      }
    }

    // 3. Locate Checkout Button
    console.log("🔍 Locating checkout button...");
    await dismissModalsAndBanners(page);

    const checkoutSelectors = [
      'button:has-text("Proceed to Checkout")',
      'button:has-text("Check Out")',
      'button:has-text("Claim a Time Slot")',
      'button:has-text("Select a time")',
      '[data-testid="cart-checkout-button"]'
    ];

    let checkoutBtn = null;
    for (const sel of checkoutSelectors) {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) {
        checkoutBtn = btn;
        break;
      }
    }

    if (!checkoutBtn) {
      console.log("Navigating directly to checkout flow...");
      await page.goto("https://www.fredmeyer.com/checkout", { waitUntil: "domcontentloaded" });
    } else {
      console.log("Clicking checkout button...");
      await checkoutBtn.click();
    }

    await page.waitForTimeout(4000);
    await dismissModalsAndBanners(page);
    await waitForLoadingToFinish(page);

    // 4. Select fulfillment date & time slot
    console.log("📅 Selecting fulfillment time slot...");
    await dismissModalsAndBanners(page);

    if (scheduleDate) {
      const dateParts = scheduleDate.split(/[\s,]+/);
      for (const part of dateParts) {
        if (part.length > 2) {
          const dateTab = await page.$(`button:has-text("${part}"), div[role="tab"]:has-text("${part}")`);
          if (dateTab && (await dateTab.isVisible())) {
            console.log(`Selecting date tab: ${part}`);
            await dateTab.click();
            await page.waitForTimeout(2000);
            break;
          }
        }
      }
    }

    // Pick first available 1-hour time slot
    const slotSelectors = [
      'button[data-testid*="slot-"]:not([disabled])',
      'div[role="radio"]:not([aria-disabled="true"])',
      'button:has-text("AM"):not([disabled])',
      'button:has-text("PM"):not([disabled])',
      '[aria-label*="Available"]'
    ];

    let slotSelected = false;
    for (const sel of slotSelectors) {
      const slots = await page.$$(sel);
      for (const s of slots) {
        if (await s.isVisible()) {
          const slotText = (await s.innerText()).trim().replace(/\n+/g, " ");
          console.log(`✓ Selecting available slot: "${slotText}"`);
          await s.click();
          slotSelected = true;
          await page.waitForTimeout(2000);
          break;
        }
      }
      if (slotSelected) break;
    }

    // Continue to payment / review
    await dismissModalsAndBanners(page);

    const continueSelectors = [
      'button:has-text("Continue to Payment")',
      'button:has-text("Continue to Review")',
      'button:has-text("Save & Continue")',
      'button:has-text("Continue")'
    ];

    for (const sel of continueSelectors) {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) {
        await btn.click();
        await page.waitForTimeout(4000);
        break;
      }
    }

    await dismissModalsAndBanners(page);
    await waitForLoadingToFinish(page);

    // 5. Take screenshot of final review
    const reviewScreenshot = path.join(SCREENSHOTS_DIR, `checkout-review-${Date.now()}.png`);
    await page.screenshot({ path: reviewScreenshot, fullPage: true });
    console.log(`\n📸 Saved review screenshot: ${reviewScreenshot}`);

    // 6. Handle Dry Run vs Final Submission
    if (dryRun) {
      console.log("\n🔍 [DRY RUN] Reached final review screen. Order was NOT submitted.");
      await context.close();
      return { success: true, dryRun: true, screenshot: reviewScreenshot };
    }

    // Real Submission
    console.log("\n💳 Locating 'Submit Order' button...");
    const submitSelectors = [
      'button:has-text("Submit Order")',
      'button:has-text("Place Order")',
      '[data-testid="submit-order-button"]'
    ];

    let submitBtn = null;
    for (const sel of submitSelectors) {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) {
        submitBtn = btn;
        break;
      }
    }

    if (!submitBtn) {
      throw new Error("Could not find 'Submit Order' button on final screen. Please inspect screenshot.");
    }

    console.log("🚀 Submitting order to Fred Meyer...");
    await submitBtn.click();
    await page.waitForTimeout(8000);

    const confirmScreenshot = path.join(SCREENSHOTS_DIR, `order-confirmation-${Date.now()}.png`);
    await page.screenshot({ path: confirmScreenshot, fullPage: true });

    let orderNumber = "UNKNOWN";
    const bodyText = await page.innerText("body");
    const orderMatch = bodyText.match(/Order\s*#?\s*([A-Z0-9\-]{6,20})/i);
    if (orderMatch) {
      orderNumber = orderMatch[1];
    }

    console.log(`\n🎉 Order Successfully Placed! Order ID: ${orderNumber}`);
    console.log(`📸 Confirmation Screenshot: ${confirmScreenshot}\n`);

    await context.close();
    return { success: true, orderNumber, screenshot: confirmScreenshot };
  } catch (err) {
    const errScreenshot = path.join(SCREENSHOTS_DIR, `checkout-error-${Date.now()}.png`);
    try {
      await page.screenshot({ path: errScreenshot, fullPage: true });
      console.log(`📸 Saved error state screenshot: ${errScreenshot}`);
    } catch {}
    await context.close();
    throw err;
  }
}
