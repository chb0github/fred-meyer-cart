import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { webkit } from "playwright";
import { PROJECT_ROOT } from "./config.mjs";

export const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, "screenshots");

function log(msg = "") {
  process.stderr.write(msg + "\n");
}

function ensureDirs() {
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

/**
 * Natural random delay between min and max milliseconds
 */
export async function naturalDelay(minMs = 1200, maxMs = 2800) {
  const duration = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, duration));
}

/**
 * Simulates gentle human scrolling and mouse wandering
 */
export async function humanWander(page) {
  try {
    const scrollDelta = (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 120) + 80);
    await page.mouse.wheel(0, scrollDelta);
    await naturalDelay(300, 600);
    await page.mouse.wheel(0, -scrollDelta * 0.8);
    await naturalDelay(200, 500);
  } catch {}
}

/**
 * Simulates natural mouse movement and hover over an element before clicking
 */
export async function humanClick(page, selectorOrElement) {
  try {
    const el = typeof selectorOrElement === "string" ? await page.$(selectorOrElement) : selectorOrElement;
    if (!el) return false;

    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await naturalDelay(250, 550);

    const box = await el.boundingBox();
    if (box) {
      const targetX = box.x + box.width * (0.35 + Math.random() * 0.3);
      const targetY = box.y + box.height * (0.35 + Math.random() * 0.3);

      await page.mouse.move(targetX, targetY, { steps: Math.floor(Math.random() * 8) + 10 });
      await naturalDelay(150, 350);

      await page.mouse.down();
      await naturalDelay(60, 140);
      await page.mouse.up();
      await naturalDelay(300, 600);
      return true;
    } else {
      await el.click({ delay: Math.floor(Math.random() * 80) + 40 });
      return true;
    }
  } catch (err) {
    return false;
  }
}

/**
 * Extracts active session cookies directly from personal Firefox profile
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
      const query =
        "SELECT host, name, value, path, isSecure, isHttpOnly, expiry, sameSite FROM moz_cookies WHERE host LIKE \x27%kroger%\x27 OR host LIKE \x27%fredmeyer%\x27;";
      const output = execSync(`sqlite3 "${tmpDb}" "${query}"`, { encoding: "utf-8" });

      const cookies = [];
      const lines = output.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const parts = line.split("|");
        const [host, name, value, cookiePath, isSecure, isHttpOnly, expiry, sameSite] = parts;
        if (name && value && !name.startsWith("bm_") && !name.startsWith("ak_") && name !== "_abck") {
          const domain = host.startsWith(".") ? host : "." + host;
          cookies.push({
            name,
            value,
            domain,
            path: (cookiePath && cookiePath.startsWith("/")) ? cookiePath : "/",
            secure: isSecure === "1",
            httpOnly: isHttpOnly === "1",
            expires: expiry ? Math.floor(parseInt(expiry, 10) / 1000) : undefined,
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
 * Automatically dismisses privacy modals, terms updates, cookie banners, and overlays
 */
export async function dismissModalsAndBanners(page) {
  try {
    await page.evaluate(() => {
      const buttons = document.querySelectorAll(
        '.citrus-DismissalButton, button[aria-label*="Close modal dialog" i], button[aria-label*="close" i], button[data-testid*="close" i], #onetrust-accept-btn-handler, #accept-recommended-btn-handler'
      );
      buttons.forEach((b) => {
        try {
          b.click();
        } catch {}
      });

      const modals = document.querySelectorAll('[aria-modal="true"], .kds-Modal, .citrus-Modal');
      modals.forEach((m) => {
        if (m.innerText && (m.innerText.includes("Privacy Policy") || m.innerText.includes("Experience"))) {
          m.remove();
        }
      });
      const backdrops = document.querySelectorAll('.kds-Modal-backdrop, .citrus-Modal-backdrop, .ReactModal__Overlay');
      backdrops.forEach((b) => b.remove());
    });
    await naturalDelay(300, 600);
  } catch {}
}

/**
 * Ensures the target store (Issaquah 98029) is selected as active modality in the browser
 */
export async function ensureStoreSelected(page, zip = "98029") {
  try {
    const modBtn = await page.$('[data-testid="CurrentModality-button"], button:has-text("Pickup at")');
    if (modBtn) {
      const aria = await modBtn.getAttribute("aria-label");
      if (!aria || !aria.toLowerCase().includes("issaquah")) {
        log(`🏬 Setting store location to Issaquah (${zip})...`);
        await humanClick(page, modBtn);
        await naturalDelay(1200, 2000);

        const searchInput = await page.$('input[placeholder*="ZIP" i], input[aria-label*="Search" i], [data-testid="postal-code-input"]');
        if (searchInput) {
          await searchInput.fill(zip);
          await page.keyboard.press("Enter");
          await naturalDelay(2000, 3000);

          const setStoreBtn = await page.$('button:has-text("Shop pickup"), button:has-text("Select Store"), button:has-text("Set as Preferred")');
          if (setStoreBtn) {
            await humanClick(page, setStoreBtn);
            await naturalDelay(2500, 3500);
          }
        }
      }
    }
  } catch {}
}

/**
 * Standalone command to empty all items from the Fred Meyer cart
 */
export async function emptyCartStandalone({ headless = true } = {}) {
  ensureDirs();
  log("\n🛒 Opening cart to remove all items...");

  const cookies = getPersonalFirefoxCookies();
  if (cookies.length === 0) {
    throw new Error(
      "No active Fred Meyer session cookies found in Firefox. Please open Firefox and sign in to fredmeyer.com."
    );
  }

  const browser = await webkit.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded", timeout: 45000 });
    await naturalDelay(2000, 3500);
    await dismissModalsAndBanners(page);
    await ensureStoreSelected(page, "98029");
    await humanWander(page);

    const tryAgain = await page.$('button:has-text("Try Again")');
    if (tryAgain && await tryAgain.isVisible()) {
      await humanClick(page, tryAgain);
      await naturalDelay(2500, 4000);
    }

    let removedCount = 0;
    for (let i = 0; i < 20; i++) {
      await dismissModalsAndBanners(page);
      const removeButtons = await page.$$('button[aria-label*="Remove" i], button[data-testid*="remove" i], button:has-text("Remove"), [data-testid="cart-item-delete-button"]');
      if (removeButtons.length === 0) break;
      for (const btn of removeButtons) {
        try {
          if (await btn.isVisible()) {
            await humanClick(page, btn);
            removedCount++;
            await naturalDelay(400, 800);
          }
        } catch {}
      }
    }

    log(`✓ Cleared ${removedCount} items from Fred Meyer cart.\n`);
    await browser.close();
    return { success: true, count: removedCount };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

/**
 * Open Firefox for 1-time login check
 */
export async function openBrowserLogin() {
  log("\n🦊 Opening Firefox to Fred Meyer sign-in...");
  log("Please verify you are signed into your Fred Meyer account in Firefox.\n");
  try {
    execSync('open -a Firefox "https://www.fredmeyer.com/signin?redirectUrl=/cart"');
    log("✓ Opened Firefox to https://www.fredmeyer.com/signin?redirectUrl=/cart");
    log("Your active session cookies are automatically picked up from Firefox by the CLI!\n");
  } catch (err) {
    log(`Error opening Firefox: ${err.message}`);
  }
}

/**
 * Automated Checkout Engine via WebKit with Firefox Cookie Injection
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

  const cookies = getPersonalFirefoxCookies();
  if (cookies.length === 0) {
    throw new Error(
      "No active Fred Meyer session cookies found in Firefox. Please open Firefox and sign in to fredmeyer.com."
    );
  }

  log(`✓ Injected ${cookies.length} active session cookies from personal Firefox profile.`);

  const browser = await webkit.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15"
  });

  await context.addCookies(cookies);
  const page = await context.newPage();

  try {
    // 1. Navigate to Cart
    log("🛒 Navigating to https://www.fredmeyer.com/cart...");
    await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded", timeout: 45000 });
    await naturalDelay(2000, 3500);
    await dismissModalsAndBanners(page);

    // Ensure store is set to Issaquah
    await ensureStoreSelected(page, "98029");
    await humanWander(page);
    await dismissModalsAndBanners(page);

    // 2. Check for "Claim a Time Slot" or "Check Out" on Cart Page
    log("🔍 Locating checkout button...");
    const checkoutSelectors = [
      'button:has-text("Proceed to Checkout")',
      'button:has-text("Check Out")',
      'button:has-text("Claim a Time Slot")',
      'button:has-text("Select a time")',
      'button:has-text("Reserve a Time")',
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
      const btnText = (await checkoutBtn.innerText()).trim().replace(/\n+/g, " ");
      log(`Clicking checkout button: "${btnText}"...`);
      await humanClick(page, checkoutBtn);
    } else {
      log("Navigating directly to checkout flow...");
      await page.goto("https://www.fredmeyer.com/checkout", { waitUntil: "domcontentloaded" });
    }

    await naturalDelay(3000, 4500);
    await dismissModalsAndBanners(page);
    await humanWander(page);

    // 3. Select fulfillment date & time slot
    log("📅 Selecting fulfillment time slot...");
    if (scheduleDate) {
      const dateParts = scheduleDate.split(/[\s,]+/);
      for (const part of dateParts) {
        if (part.length > 2) {
          const dateTab = await page.$(`button:has-text("${part}"), div[role="tab"]:has-text("${part}")`);
          if (dateTab && (await dateTab.isVisible())) {
            log(`Selecting date tab: ${part}`);
            await humanClick(page, dateTab);
            await naturalDelay(1500, 2500);
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
          await humanClick(page, s);
          slotSelected = true;
          await naturalDelay(1500, 2500);
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
        await humanClick(page, btn);
        await naturalDelay(3000, 4500);
        break;
      }
    }

    await dismissModalsAndBanners(page);

    // 4. Take screenshot of final review
    const reviewScreenshot = path.resolve(path.join(SCREENSHOTS_DIR, `checkout-review-${Date.now()}.png`));
    await page.screenshot({ path: reviewScreenshot, animations: "disabled", timeout: 8000 });
    log(`\n📸 Saved review screenshot: ${reviewScreenshot}`);

    // 5. Handle Dry Run vs Final Submission
    if (dryRun) {
      log("\n🔍 [DRY RUN] Reached final review screen. Order was NOT submitted.");
      await browser.close();
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
    await humanClick(page, submitBtn);
    await naturalDelay(6000, 9000);

    const confirmScreenshot = path.resolve(path.join(SCREENSHOTS_DIR, `order-confirmation-${Date.now()}.png`));
    await page.screenshot({ path: confirmScreenshot, animations: "disabled", timeout: 8000 });

    let orderNumber = "UNKNOWN";
    const bodyText = await page.innerText("body");
    const orderMatch = bodyText.match(/Order\s*#?\s*([A-Z0-9\-]{6,20})/i);
    if (orderMatch) {
      orderNumber = orderMatch[1];
    }

    log(`\n🎉 Order Successfully Placed! Order ID: ${orderNumber}`);
    log(`📸 Confirmation Screenshot: ${confirmScreenshot}\n`);

    await browser.close();
    return { success: true, orderNumber, screenshot: confirmScreenshot };
  } catch (err) {
    const errScreenshot = path.resolve(path.join(SCREENSHOTS_DIR, `checkout-error-${Date.now()}.png`));
    try {
      await page.screenshot({ path: errScreenshot, animations: "disabled", timeout: 8000 });
      log(`📸 Saved error state screenshot: ${errScreenshot}`);
    } catch {}
    await browser.close();
    throw err;
  }
}
