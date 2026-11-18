// Books a table on the ServiceNow portal, DAYS_AHEAD days from today.
// All settings come from environment variables (GitHub Secrets / Variables).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const env = (k, d = '') => (process.env[k] ?? '').trim() || d;
const truthy = (v) => /^(1|true|yes|on)$/i.test(v || '');

const cfg = {
  portalUrl: env('PORTAL_URL', 'https://tmx.service-now.com/sp'),
  reservationUrl: env('RESERVATION_URL'), // optional: direct link to the "Make a reservation" page
  username: env('OKTA_USERNAME'),
  password: env('OKTA_PASSWORD'),
  timeZone: env('TIME_ZONE', 'America/Toronto'),
  daysAhead: Number(env('DAYS_AHEAD', '14')),
  bookDays: env('BOOK_DAYS', 'Tue,Thu').split(',').map((s) => s.trim().slice(0, 3).toLowerCase()),
  bookAt: env('BOOK_AT'), // "HH:MM" local time the booking window opens; empty = book immediately
  targetDate: env('TARGET_DATE'), // YYYY-MM-DD, overrides the calculated date
  dateFormat: env('DATE_FORMAT', 'YYYY-MM-DD'),
  formFields: JSON.parse(env('FORM_FIELDS', '[]')), // [{"label":"Building","value":"..."}, ...]
  preferredSpaces: env('PREFERRED_SPACES').split(',').map((s) => s.trim()).filter(Boolean),
  // Only book a desk from PREFERRED_SPACES. Set ONLY_PREFERRED=false to fall back to any free desk.
  onlyPreferred: truthy(env('ONLY_PREFERRED', 'true')),
  successText: new RegExp(env('SUCCESS_TEXT', 'confirmed|success|reserved|submitted|has been booked'), 'i'),
  dryRun: truthy(env('DRY_RUN')),
  force: truthy(env('FORCE')),
  mfaTimeoutSec: Number(env('MFA_TIMEOUT_SEC', '180')),
  stateFile: env('STATE_FILE', '.auth/state.json'),
  outDir: env('OUT_DIR', 'output'),
};

const DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- time helpers ----------
function localNow(tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return { y: +p.year, m: +p.month, d: +p.day, secOfDay: +p.hour * 3600 + +p.minute * 60 + +p.second };
}

function computeTarget() {
  let date;
  if (cfg.targetDate) {
    const [y, m, d] = cfg.targetDate.split('-').map(Number);
    date = new Date(Date.UTC(y, m - 1, d));
  } else {
    const n = localNow(cfg.timeZone);
    date = new Date(Date.UTC(n.y, n.m - 1, n.d + cfg.daysAhead));
  }
  const pad = (x) => String(x).padStart(2, '0');
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
  const formatted = cfg.dateFormat
    .replace('YYYY', y).replace('MMM', MON[m - 1]).replace('MM', pad(m)).replace('DD', pad(d));
  return { iso: `${y}-${pad(m)}-${pad(d)}`, weekday: DAY[date.getUTCDay()], formatted };
}

// Seconds until BOOK_AT today (negative = already past). null when BOOK_AT is not set.
function secondsUntilBookAt() {
  if (!cfg.bookAt) return null;
  const [h, mi] = cfg.bookAt.split(':').map(Number);
  return h * 3600 + mi * 60 - localNow(cfg.timeZone).secOfDay;
}

// ---------- page helpers ----------
let shotNo = 0;
async function shot(page, name) {
  const file = path.join(cfg.outDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  log('screenshot:', file);
}

async function firstVisible(page, selectors, timeout = 0) {
  const end = Date.now() + timeout;
  do {
    for (const sel of selectors) {
      const loc = typeof sel === 'string' ? page.locator(sel) : sel;
      const n = await loc.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
      }
    }
    if (timeout) await sleep(500);
  } while (Date.now() < end);
  return null;
}

const portalHost = new URL(cfg.portalUrl).hostname;
const onServiceNow = (page) => {
  try { return new URL(page.url()).hostname === portalHost; } catch { return false; }
};

// ---------- Okta login ----------
const SEL = {
  username: ['input[name="identifier"]', '#okta-signin-username', 'input[name="username"]', 'input[autocomplete="username"]'],
  password: ['input[name="credentials.passcode"]', '#okta-signin-password', 'input[type="password"]'],
  submit: ['input[type="submit"]', 'button[type="submit"]', '#okta-signin-submit'],
  remember: ['input[name="rememberMe"]', 'input[name="remember"]'],
  autoPush: ['input[name="autoChallenge"]'],
  push: [
    '[data-se="okta_verify-push"] a', '[data-se="okta_verify-push"] button',
    'input[value="Send push" i]', 'input[value="Send Push"]',
    'a:has-text("Send push")', 'button:has-text("Send push")',
    'a:has-text("Get a push notification")', 'button:has-text("Get a push notification")',
  ],
  // Login form fields living on the ServiceNow side, i.e. not logged in yet.
  snLogin: ['#user_name', 'button:has-text("Login with SSO")', 'a:has-text("Login with SSO")', 'a:has-text("Log in")', 'a:has-text("Sign in")'],
};

async function isLoggedIn(page) {
  if (!onServiceNow(page)) return false;
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  return !(await firstVisible(page, [...SEL.snLogin, ...SEL.username, ...SEL.password]));
}

async function login(page) {
  await page.goto(cfg.portalUrl, { waitUntil: 'domcontentloaded' });
  if (await isLoggedIn(page)) { log('Already logged in (saved session reused).'); return; }

  if (!cfg.username || !cfg.password) throw new Error('OKTA_USERNAME / OKTA_PASSWORD secrets are missing.');
  log('Logging in through Okta...');

  const done = { user: false, pass: false, push: 0, sso: false };
  const end = Date.now() + cfg.mfaTimeoutSec * 1000;
  while (Date.now() < end) {
    if (onServiceNow(page) && (await isLoggedIn(page))) { log('Logged in.'); return; }

    // ServiceNow's own login page with an SSO button
    if (onServiceNow(page) && !done.sso) {
      const sso = await firstVisible(page, SEL.snLogin.slice(1));
      if (sso) { await sso.click(); done.sso = true; await sleep(2000); continue; }
    }

    const user = !done.user && (await firstVisible(page, SEL.username));
    if (user) {
      await user.fill(cfg.username);
      const rem = await firstVisible(page, SEL.remember);
      if (rem) await rem.check({ force: true }).catch(() => {});
      // Classic Okta shows username + password on one page
      const pw = await firstVisible(page, SEL.password);
      if (pw) { await pw.fill(cfg.password); done.pass = true; }
      await (await firstVisible(page, SEL.submit)).click();
      done.user = true;
      await sleep(2500);
      continue;
    }

    const pw = !done.pass && (await firstVisible(page, SEL.password));
    if (pw) {
      await pw.fill(cfg.password);
      await (await firstVisible(page, SEL.submit)).click();
      done.pass = true;
      await sleep(2500);
      continue;
    }

    // Send the push at most twice (re-sends once if Okta shows the button again after a timeout)
    const push = done.push < 2 && (await firstVisible(page, SEL.push));
    if (push) {
      const auto = await firstVisible(page, SEL.autoPush);
      if (auto) await auto.check({ force: true }).catch(() => {});
      await push.click();
      done.push++;
      log('>>> Okta push sent. APPROVE IT ON YOUR PHONE NOW. <<<');
      await shot(page, 'okta-push-sent');
      await sleep(5000);
      continue;
    }
    await sleep(1500);
  }
  await shot(page, 'login-timeout');
  throw new Error(`Login did not finish within ${cfg.mfaTimeoutSec}s (push not approved, or the login page looks different).`);
}

// ---------- reservation form ----------
async function openReservationPage(page) {
  if (cfg.reservationUrl) {
    await page.goto(cfg.reservationUrl, { waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(cfg.portalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const menu = await firstVisible(page, [
      page.getByRole('link', { name: /^\s*reservations?\s*$/i }),
      page.getByRole('button', { name: /^\s*reservations?\s*$/i }),
      page.getByText(/^\s*reservations?\s*$/i),
    ], 20000);
    if (!menu) throw new Error('Could not find the "Reservation" menu. Set RESERVATION_URL to the page link instead.');
    await menu.click();
    const make = await firstVisible(page, [
      page.getByRole('link', { name: /make a reservation/i }),
      page.getByRole('button', { name: /make a reservation/i }),
      page.getByText(/make a reservation/i),
    ], 15000);
    if (!make) throw new Error('Could not find "Make a reservation".');
    await make.click();
  }
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await shot(page, 'reservation-page');
}

// Sets one form field by its visible label. Handles normal inputs, <select>, and
// ServiceNow type-ahead pickers (type the value, then click the matching suggestion).
async function setField(page, label, value) {
  log(`Setting "${label}" = "${value}"`);
  const labelRe = new RegExp(label, 'i');
  const field = await firstVisible(page, [
    page.getByLabel(labelRe),
    page.getByRole('combobox', { name: labelRe }),
    page.getByPlaceholder(labelRe),
  ], 15000);
  if (!field) throw new Error(`Field "${label}" not found on the form.`);

  const tag = await field.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    await field.selectOption({ label: value }).catch(() => field.selectOption(value));
    return;
  }
  await field.click();
  await field.fill('').catch(() => {});
  await field.pressSequentially(value, { delay: 40 });
  const option = await firstVisible(page, [
    page.getByRole('option', { name: new RegExp(escapeRe(value), 'i') }),
    page.locator('.select2-result-label, .select2-results__option, .dropdown-menu li, .uib-typeahead-match')
      .filter({ hasText: new RegExp(escapeRe(value), 'i') }),
  ], 4000);
  if (option) await option.click();
  else await field.press('Tab');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function clickButton(page, re, timeout = 10000) {
  const btn = await firstVisible(page, [page.getByRole('button', { name: re }), page.getByRole('link', { name: re })], timeout);
  if (btn) await btn.click();
  return !!btn;
}

async function makeReservation(page, target) {
  await openReservationPage(page);

  for (const f of cfg.formFields) {
    await setField(page, f.label, String(f.value).replaceAll('{date}', target.formatted));
  }
  await shot(page, 'form-filled');

  // 1. Search, then give the results 3 seconds to load.
  if (!(await clickButton(page, /^\s*(search|find|check availability|show available)/i, 10000))) {
    await shot(page, 'no-search-button');
    throw new Error('Could not find the Search button.');
  }
  log('Clicked Search, waiting for results...');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(3000);
  await shot(page, 'search-results');

  // 2. Switch the results to "Card view".
  const cardView = await firstVisible(page, [
    page.getByRole('button', { name: /card view|cards?$/i }),
    page.getByRole('tab', { name: /card view|cards?$/i }),
    page.getByRole('link', { name: /card view/i }),
    page.getByTitle(/card view/i),
    page.getByText(/^\s*card view\s*$/i),
  ], 10000);
  if (cardView) {
    await cardView.click();
    log('Switched to Card view.');
    await sleep(2000);
    await shot(page, 'card-view');
  } else {
    log('No "Card view" toggle found, continuing with the current view.');
  }

  // 3. Find the preferred desk (e.g. 2038), clicking "Show more" until it appears.
  const addRe = /^\s*(add|reserve|select)\b/i;
  const addBtn = () => page.getByRole('button', { name: addRe }).or(page.getByRole('link', { name: addRe }));
  const findCard = async (name) => {
    const nameRe = new RegExp(`(^|\\D)${escapeRe(name)}(\\D|$)`, 'i');
    const card = page.locator('div, li, tr, article').filter({ hasText: nameRe }).filter({ has: addBtn() }).last();
    return (await card.count()) && (await card.isVisible().catch(() => false)) ? card : null;
  };

  // Count of desk cards currently loaded (each has an Add/Remove button).
  const cardCount = () => page.getByRole('button', { name: /^\s*(add|remove)\s*$/i }).count();
  const findMore = () => firstVisible(page, [
    page.getByRole('button', { name: /show more|load more|more results/i }),
    page.getByRole('link', { name: /show more|load more|more results/i }),
    page.getByText(/^\s*(show|load) more/i),
  ], 8000);

  if (!cfg.preferredSpaces.length && cfg.onlyPreferred) {
    throw new Error('PREFERRED_SPACES is not set, so I don\'t know which desk to book. Add it under Settings > Secrets and variables > Actions > Variables (e.g. 2038).');
  }
  let card = null;
  for (let i = 0; i < 100 && cfg.preferredSpaces.length; i++) {
    for (const name of cfg.preferredSpaces) {
      card = await findCard(name);
      if (card) { log('Found preferred desk:', name); break; }
    }
    if (card) break;

    // Scroll to the bottom so "Show more" (or lazy-loaded cards) appear, then wait for it.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await sleep(1000);
    const more = await findMore();
    if (!more) {
      log(`No "Show more" button found after ${await cardCount()} desks; reached the end of the list.`);
      await shot(page, 'end-of-list');
      break;
    }
    const before = await cardCount();
    await more.scrollIntoViewIfNeeded().catch(() => {});
    await more.click({ timeout: 5000 }).catch(() => more.evaluate((el) => el.click()));
    // Wait until more desks have loaded (up to 15s).
    for (let t = 0; t < 30 && (await cardCount()) <= before; t++) await sleep(500);
    log(`Clicked "Show more" (${i + 1}): ${before} -> ${await cardCount()} desks loaded`);
  }

  let add;
  if (card) {
    add = card.locator(addBtn()).first();
  } else {
    if (cfg.preferredSpaces.length) {
      await shot(page, 'desk-not-found');
      if (cfg.onlyPreferred) throw new Error(`Desk ${cfg.preferredSpaces.join('/')} is not available on ${target.iso}.`);
      log(`Desk ${cfg.preferredSpaces.join('/')} not available, taking the first available one.`);
    }
    add = await firstVisible(page, [addBtn()], 10000);
    if (!add) { await shot(page, 'no-space'); throw new Error('No available desk found for that date.'); }
  }

  // 4. Add -> Next
  await add.scrollIntoViewIfNeeded().catch(() => {});
  await add.click();
  log('Clicked "Add".');
  await sleep(1500);
  await shot(page, 'desk-added');

  if (!(await clickButton(page, /^\s*next\b/i, 15000))) { await shot(page, 'no-next'); throw new Error('Could not find the "Next" button.'); }
  log('Clicked "Next".');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(2000);
  await shot(page, 'review-page');

  if (cfg.dryRun) { log('DRY RUN: stopping before "Submit reservation". Check the screenshots.'); return; }

  // 5. Submit reservation
  if (!(await clickButton(page, /submit reservation|^\s*submit\b/i, 15000))) {
    await shot(page, 'no-submit'); throw new Error('Could not find the "Submit reservation" button.');
  }
  log('Clicked "Submit reservation".');
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await sleep(3000);
  await shot(page, 'after-submit');

  const text = await page.locator('body').innerText().catch(() => '');
  if (!cfg.successText.test(text)) throw new Error('Clicked Submit, but no confirmation text was found. Check the after-submit screenshot.');
  log('Reservation confirmed for', target.iso);
}

// ---------- main ----------
const VERSION = '2026-11-18 v4 (Show more + desk-only)';

(async () => {
  log(`book.js ${VERSION}`);
  log(`Desk wanted: ${cfg.preferredSpaces.join(', ') || '(PREFERRED_SPACES not set!)'} | only that desk: ${cfg.onlyPreferred} | test only: ${cfg.dryRun}`);
  fs.mkdirSync(cfg.outDir, { recursive: true });
  fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });

  // On scheduled runs, only run if we're close to BOOK_AT (the schedule fires twice
  // to cover daylight-saving changes; the run outside the window just exits).
  let wait = secondsUntilBookAt();
  if (!cfg.force && wait !== null && (wait > 40 * 60 || wait < -25 * 60)) {
    log(`Not near BOOK_AT (${cfg.bookAt} ${cfg.timeZone}); nothing to do on this run.`);
    return;
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    storageState: fs.existsSync(cfg.stateFile) ? cfg.stateFile : undefined,
    viewport: { width: 1366, height: 900 },
    timezoneId: cfg.timeZone,
    locale: 'en-CA',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await login(page);
    await context.storageState({ path: cfg.stateFile }); // reused next run => often no push needed

    wait = secondsUntilBookAt();
    if (!cfg.force && wait !== null && wait > 0) {
      log(`Logged in. Waiting ${Math.round(wait)}s until ${cfg.bookAt} when the booking window opens...`);
      await sleep(wait * 1000 + 3000);
    }

    const target = computeTarget();
    log(`Target date: ${target.iso} (${target.weekday}), entered as "${target.formatted}"`);
    if (!cfg.targetDate && !cfg.bookDays.includes(target.weekday)) {
      log(`Target is a ${target.weekday}, not one of ${cfg.bookDays.join('/')}; skipping.`);
      return;
    }

    await makeReservation(page, target);
    await context.storageState({ path: cfg.stateFile });
  } catch (err) {
    await shot(page, 'error');
    fs.writeFileSync(path.join(cfg.outDir, 'error-page.html'), await page.content().catch(() => ''));
    console.error('FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
