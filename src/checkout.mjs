import fs from "fs";
import path from "path";
import readline from "readline";
import { chromium } from "playwright";
import { PROJECT_ROOT } from "./config.mjs";

export const BROWSER_PROFILE_DIR = path.join(PROJECT_ROOT, ".browser-profile");
export const SCREENSHOTS_DIR = path.join(PROJECT_ROOT, "screenshots");

function ensureDirs() {
  if (!fs.existsSync(BROWSER_PROFILE_DIR)) fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
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
 * 1-time interactive login to save persistent session cookies in .browser-profile
 */
export async function openBrowserLogin() {
  ensureDirs();
  console.log("\n🌐 Opening browser for Fred Meyer login...");
  console.log("Please log in to your Fred Meyer account and complete any verification if prompted.");

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto("https://www.fredmeyer.com/signin", { waitUntil: "domcontentloaded" });

  await askQuestion("\n👉 After you have successfully logged in on the browser, press [Enter] here to save session: ");

  // Quick check on account page or cart
  await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  await context.close();
  console.log("\n✓ Browser session & cookies successfully saved to .browser-profile!\n");
}

/**
 * Automated Checkout Engine via Playwright
 */
export async function performAutomatedCheckout({
  scheduleDate = null,
  modality = "PICKUP",
  slotPreference = "earliest",
  dryRun = false,
  headless = true
} = {}) {
  ensureDirs();

  if (!fs.existsSync(BROWSER_PROFILE_DIR) || fs.readdirSync(BROWSER_PROFILE_DIR).length === 0) {
    throw new Error("No saved browser session found. Please run 'fm auth-browser' first to log in.");
  }

  console.log(`\n🤖 Launching automated browser checkout (${modality}, ${scheduleDate || "next available"})...`);

  const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless,
    viewport: { width: 1280, height: 900 },
    userAgent: DEFAULT_USER_AGENT,
    args: ["--disable-blink-features=AutomationControlled"]
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    // 1. Navigate to Cart
    console.log("🛒 Navigating to https://www.fredmeyer.com/cart...");
    await page.goto("https://www.fredmeyer.com/cart", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);

    // 2. Check if logged in
    const signInBtn = await page.$('text="Sign In"');
    if (signInBtn && (await signInBtn.isVisible())) {
      const isCartEmpty = await page.$('text="Your cart is empty"');
      if (isCartEmpty) {
        throw new Error("Cart is empty or session expired. Please run 'fm auth-browser' to re-authenticate.");
      }
    }

    // 3. Locate Checkout / Claim Time Slot Button
    console.log("🔍 Looking for checkout button...");
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
      // Fallback direct navigation
      console.log("Navigating directly to checkout flow...");
      await page.goto("https://www.fredmeyer.com/checkout", { waitUntil: "domcontentloaded" });
    } else {
      console.log("Clicking checkout button...");
      await checkoutBtn.click();
    }

    await page.waitForTimeout(5000);

    // 4. Select fulfillment date & time slot
    console.log("📅 Selecting pickup/delivery time slot...");

    // Try finding date button if specific date requested
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

    // Extract order number
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
