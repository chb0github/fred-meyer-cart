import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { execSync } from "child_process";
import { chromium } from "playwright";
import { PROJECT_ROOT, getNetrcCredentials, getConfig } from "./config.mjs";

export const BROWSER_PROFILE_DIR = path.join(PROJECT_ROOT, ".browser-profile", "chrome");
export const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, "screenshots");

function log(msg = "") {
  process.stderr.write(msg + "\n");
}

function ensureDirs() {
  if (!fs.existsSync(BROWSER_PROFILE_DIR)) fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    })
  );
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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
 * Automatically sync cookies into browser context
 */
export async function syncCookiesToContext(context) {
  const cookies = getPersonalFirefoxCookies();
  if (cookies.length > 0) {
    try {
      await context.addCookies(cookies);
      log(`✓ Auto-imported ${cookies.length} active session cookies from personal profile!`);
      return true;
    } catch (err) {
      log(`Warning: Could not import cookies: ${err.message}`);
    }
  }
  return false;
}

/**
 * Automatically dismisses privacy modals, terms updates, cookie banners, and overlays
 */
export async function dismissModalsAndBanners(page) {
  try {
    await page.evaluate(() => {
      // 1. Click all citrus dismissal buttons and modal close buttons
      const buttons = document.querySelectorAll(
        '.citrus-DismissalButton, button[aria-label*="Close modal dialog" i], button[aria-label*="close" i], button[data-testid*="close" i], #onetrust-accept-btn-handler, #accept-recommended-btn-handler'
      );
      buttons.forEach((b) => {
        try {
          b.click();
        } catch {}
      });

      // 2. Remove any stuck modal backdrops if buttons didn't catch it
      const modals = document.querySelectorAll('[aria-modal="true"], .kds-Modal, .citrus-Modal');
      modals.forEach((m) => {
        if (m.innerText && (m.innerText.includes("Privacy Policy") || m.innerText.includes("Experience"))) {
          m.remove();
        }
      });
      const backdrops = document.querySelectorAll('.kds-Modal-backdrop, .citrus-Modal-backdrop, .ReactModal__Overlay');
      backdrops.forEach((b) => b.remove());
    });
    await page.waitForTimeout(500);
  } catch {}
}

/**
 * Wait for any loading spinner to disappear
 */
async function waitForLoadingToFinish(page) {
  try {
    const loadingSpinner = await page.$('text="Loading..."');
    if (loadingSpinner && (await loadingSpinner.isVisible())) {
      log("⏳ Waiting for page loading spinner...");
      await page.waitForSelector('text="Loading..."', { state: "hidden", timeout: 10000 });
    }
  } catch {}
}

/**
 * Automatically handles the Fred Meyer Sign In form if presented
 */
async function handleAutoSignIn(page) {
  const signInField = await page.$("#signInName, input[type='email'], input[name='email']");
  if (signInField && (await signInField.isVisible())) {
    const creds = getNetrcCredentials();
    const config = getConfig();
    const email = config.email || process.env.FRED_MEYER_EMAIL || "christian.bongiorno@versantmedia.com";
    const password = creds ? creds.clientSecret : null;

    if (email && password) {
      log(`🔑 Auto-signing into Fred Meyer account (${email})...`);
      await signInField.fill(email);
      const passField = await page.$("#password, input[type='password']");
      if (passField) {
        await passField.fill(password);
      }
      const continueBtn = await page.$("#continue, button[type='submit'], button:has-text('Sign In')");
      if (continueBtn) {
        await continueBtn.click();
        log("Submitted sign in, waiting for account transition...");
        await page.waitForTimeout(5000);
        await dismissModalsAndBanners(page);
      }
    }
  }
}

/**
 * 1-time interactive login / session initializer
 */
export async function openBrowserLogin() {
  ensureDirs();
  log("\n🌐 Launching browser for Fred Meyer session setup...");

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  await syncCookiesToContext(context);

  const page = context.pages()[0] || (await context.newPage());
  log("Navigating to https://www.fredmeyer.com/cart...");
  await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await dismissModalsAndBanners(page);
  await handleAutoSignIn(page);

  log("\n✓ Session initialized! Profile saved to .browser-profile/chrome.\n");
  await context.close();
}

/**
 * Automated Checkout Engine
 */
export async function performAutomatedCheckout({
  scheduleDate = null,
  modality = "PICKUP",
  slotPreference = "earliest",
  dryRun = false,
  headless = true
} = {}) {
  ensureDirs();

  log(`\n🤖 Launching automated checkout (${modality}, ${scheduleDate || "next available"})...`);

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  await syncCookiesToContext(context);

  const page = context.pages()[0] || (await context.newPage());

  try {
    // 1. Navigate to Cart
    log("🛒 Navigating to https://www.fredmeyer.com/cart...");
    await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await dismissModalsAndBanners(page);
    await waitForLoadingToFinish(page);
    await handleAutoSignIn(page);
    await dismissModalsAndBanners(page);

    // 2. Locate Checkout Button on Cart Page
    log("🔍 Locating checkout button...");
    await dismissModalsAndBanners(page);

    const checkoutSelectors = [
      'button:has-text("Proceed to Checkout")',
      'button:has-text("Check Out")',
      'button:has-text("Claim a Time Slot")',
      'button:has-text("Select a time")',
      '[data-testid="cart-checkout-button"]',
      'a[href*="/checkout"]'
    ];

    let checkoutBtn = null;
    for (const sel of checkoutSelectors) {
      const btn = await page.$(sel);
      if (btn && (await btn.isVisible())) {
        checkoutBtn = btn;
        break;
      }
    }

    if (checkoutBtn) {
      log("Clicking checkout button...");
      await checkoutBtn.click();
    } else {
      log("Navigating directly to checkout flow...");
      await page.goto("https://www.fredmeyer.com/checkout", { waitUntil: "domcontentloaded" });
    }

    await page.waitForTimeout(4000);
    await dismissModalsAndBanners(page);
    await waitForLoadingToFinish(page);
    await handleAutoSignIn(page);
    await dismissModalsAndBanners(page);

    // 3. Select fulfillment date & time slot
    log("📅 Selecting fulfillment time slot...");
    await dismissModalsAndBanners(page);

    if (scheduleDate) {
      const dateParts = scheduleDate.split(/[\s,]+/);
      for (const part of dateParts) {
        if (part.length > 2) {
          const dateTab = await page.$(`button:has-text("${part}"), div[role="tab"]:has-text("${part}")`);
          if (dateTab && (await dateTab.isVisible())) {
            log(`Selecting date tab: ${part}`);
            await dateTab.click();
            await page.waitForTimeout(2000);
            break;
          }
        }
      }
    }

    // Pick first available time slot
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
          log(`✓ Selecting available slot: "${slotText}"`);
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

    // 4. Take screenshot of final review
    const reviewScreenshot = path.resolve(path.join(SCREENSHOTS_DIR, `checkout-review-${Date.now()}.png`));
    await page.screenshot({ path: reviewScreenshot, fullPage: true });
    log(`\n📸 Saved review screenshot: ${reviewScreenshot}`);

    // 5. Handle Dry Run vs Final Submission
    if (dryRun) {
      log("\n🔍 [DRY RUN] Reached final review screen. Order was NOT submitted.");
      await context.close();
      return { success: true, dryRun: true, screenshot: reviewScreenshot };
    }

    // Real Submission
    log("\n💳 Locating 'Submit Order' button...");
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

    log("🚀 Submitting order to Fred Meyer...");
    await submitBtn.click();
    await page.waitForTimeout(8000);

    const confirmScreenshot = path.resolve(path.join(SCREENSHOTS_DIR, `order-confirmation-${Date.now()}.png`));
    await page.screenshot({ path: confirmScreenshot, fullPage: true });

    let orderNumber = "UNKNOWN";
    const bodyText = await page.innerText("body");
    const orderMatch = bodyText.match(/Order\s*#?\s*([A-Z0-9\-]{6,20})/i);
    if (orderMatch) {
      orderNumber = orderMatch[1];
    }

    log(`\n🎉 Order Successfully Placed! Order ID: ${orderNumber}`);
    log(`📸 Confirmation Screenshot: ${confirmScreenshot}\n`);

    await context.close();
    return { success: true, orderNumber, screenshot: confirmScreenshot };
  } catch (err) {
    const errScreenshot = path.resolve(path.join(SCREENSHOTS_DIR, `checkout-error-${Date.now()}.png`));
    try {
      await page.screenshot({ path: errScreenshot, fullPage: true });
      log(`📸 Saved error state screenshot: ${errScreenshot}`);
    } catch {}
    await context.close();
    throw err;
  }
}
