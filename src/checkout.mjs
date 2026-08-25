import fs from "fs";
import path from "path";
import readline from "readline";
import { chromium } from "playwright";
import { PROJECT_ROOT } from "./config.mjs";

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
 * 1-time interactive login to save persistent session profile in .browser-profile/chrome
 */
export async function openBrowserLogin() {
  ensureDirs();
  log("\n🌐 Opening Chrome for Fred Meyer login...");
  log("Please sign in to your Fred Meyer account in the opened window.\n");

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = context.pages()[0] || (await context.newPage());
  log("Navigating to https://www.fredmeyer.com/signin?redirectUrl=/cart...");
  await page.goto("https://www.fredmeyer.com/signin?redirectUrl=/cart", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await dismissModalsAndBanners(page);

  await askQuestion("👉 Once you have signed in and see your cart / account, press [Enter] here to save session: ");

  await dismissModalsAndBanners(page);
  await page.waitForTimeout(2000);

  await context.close();
  log("\n✓ Login session successfully saved to .browser-profile/chrome!\n");
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

  const page = context.pages()[0] || (await context.newPage());

  try {
    // 1. Navigate to Cart
    log("🛒 Navigating to https://www.fredmeyer.com/cart...");
    await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);
    await dismissModalsAndBanners(page);
    await waitForLoadingToFinish(page);

    // Check if signin is needed
    if (page.url().includes("signin")) {
      log("⚠️  Session not authenticated. Please run 'fm auth-browser' once to save login session.");
    }

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
