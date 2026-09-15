import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const base = process.env.SMOKE_URL;
if (!base) process.exit(0);
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
try {
  const context = await browser.newContext({
    extraHTTPHeaders: process.env.VERCEL_AUTOMATION_BYPASS_SECRET
      ? {
          "x-vercel-protection-bypass":
            process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        }
      : {},
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.locator("#email").fill(process.env.ADMIN_EMAIL);
  await page.locator("#password").fill(process.env.ADMIN_PASSWORD);
  await page.locator("#loginForm button").click();
  await page.locator("#panel").waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#dashboardDate").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Calendario", exact: true }).click();
  await page.locator("#calendar").waitFor({ state: "visible" });
  const calendarReservation = page.locator("[data-calendar-reservation]").first();
  if (await calendarReservation.count()) {
    await calendarReservation.click();
    await page.locator("#calendarSidePanel").waitFor({ state: "visible" });
    assert.ok(await page.locator("#calendarSidePanel").evaluate((node) => node.classList.contains("selected")));
  }
  await page.getByRole("button", { name: "Habitaciones", exact: true }).click();
  await page.locator("#roomList .row").first().waitFor();
  assert.ok((await page.locator("#roomList .row").count()) >= 31);
  await page.getByRole("button", { name: "Reservas", exact: true }).click();
  await page.locator("#reservations").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Facturas", exact: true }).click();
  await page.locator("#invoices").waitFor({ state: "visible" });
  await page.locator("#invoiceSearch").fill("A-");
  await page.getByRole("button", { name: "Stock", exact: true }).click();
  await page.locator("#stock").waitFor({ state: "visible" });
  await page.reload();
  await page.locator("#panel").waitFor({ state: "visible", timeout: 30000 });
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "hotel_session");
  assert.ok(session.httpOnly);
  if (base.startsWith("https://")) assert.ok(session.secure);
  assert.equal(session.sameSite, "Lax");
  await page.screenshot({ path: ".private/dashboard.png", fullPage: true });
  await page.getByRole("button", { name: "Salir", exact: true }).click();
  await page.locator("#login").waitFor({ state: "visible" });
  assert.equal(
    (await context.cookies()).some((c) => c.name === "hotel_session"),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    "BROWSER PASS: login, rooms, reservations, stock, reload, secure cookie, logout",
  );
} finally {
  await browser.close();
}
