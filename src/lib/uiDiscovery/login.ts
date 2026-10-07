// The login page, tested as a page rather than used as a turnstile.
//
// Everything else in this module signs in and then starts looking. That skips
// the one screen every user meets first, and the one where a regression is
// most expensive: a box that accepts an empty password, or stops saying why a
// wrong one failed, is broken in a way no amount of dashboard testing finds.
//
// What is generated comes from what the page has. This build offers a
// username, a password, a Remember Me checkbox, a Login button and four
// links; a build that adds Forgot Password gets a Forgot Password check with
// nobody editing this file, and one that drops Remember Me stops claiming it
// should be there.
//
// The behavioural checks each run in their own signed-out browser context, so
// they cannot be fooled by a session that already exists — and so a failed
// login attempt leaves nothing behind.

import type { Page } from 'playwright';
import type { GeneratedCheck, UiNode, UiElement } from './types.ts';

/** What the login screen offers, as read off the page. */
export interface LoginForm {
  url: string;
  usernameSelector?: string;
  passwordSelector?: string;
  /** The password field's type attribute — 'password' means masked. */
  passwordType?: string;
  submitLabel?: string;
  rememberMe?: boolean;
  /** How to find the Remember Me control, since a styled checkbox often hides
   *  its real input behind a label. */
  rememberSelector?: string;
  rememberLabel?: string;
  /** Links on the page: label, href, and whether it leaves the box. */
  links: Array<{ label: string; href: string; external: boolean }>;
}

export const LOGIN_NODE_ID = 'login';

/** Turn a read of the login page into the node the rest of the module
 *  understands, so the Login category appears beside the others. */
export function loginNode(form: LoginForm): UiNode {
  const el = (key: string, kind: UiElement['kind'], label: string, selector: string, extra: Partial<UiElement> = {}): UiElement => ({
    key, kind, label, selector, risk: 'read', ...extra,
  });
  const elements: UiElement[] = [];
  if (form.usernameSelector) elements.push(el('input:username', 'input', 'Username', form.usernameSelector, { required: true }));
  if (form.passwordSelector) elements.push(el('input:password', 'input', 'Password', form.passwordSelector, { required: true }));
  if (form.rememberMe) elements.push(el('checkbox:remember-me', 'checkbox', 'Remember Me', 'input[type="checkbox"]'));
  if (form.submitLabel) elements.push(el('button:login', 'button', form.submitLabel, 'button:has-text("' + form.submitLabel + '")'));
  for (const l of form.links) {
    elements.push(el(`link:${l.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'link', l.label, `a[href="${l.href}"]`, { note: l.external ? 'leaves the box' : undefined }));
  }
  return {
    id: LOGIN_NODE_ID,
    kind: 'page',
    path: ['Login'],
    label: 'Login',
    url: form.url,
    reach: { via: 'url', url: form.url },
    elements,
  };
}

/** Everything worth asserting about this login page. Pure: the executor does
 *  the typing. */
export function loginChecks(form: LoginForm): GeneratedCheck[] {
  const out: GeneratedCheck[] = [];
  const add = (id: string, kind: GeneratedCheck['kind'], severity: GeneratedCheck['severity'], test: string, expected: string, element?: string) => {
    out.push({
      id: `${LOGIN_NODE_ID}::${id}`, kind, severity,
      section: 'Login', page: 'Login', nodeId: LOGIN_NODE_ID,
      element, test, expected,
      target: { url: form.url },
    });
  };

  add('page', 'login-page-loads', 'critical',
    'Open the login page',
    'the page renders with its sign-in form');

  if (form.usernameSelector && form.passwordSelector) {
    add('accepts-input', 'login-accepts-input', 'critical',
      'Type into the username and password fields',
      'both fields take the text and keep it', 'Username and Password');
  }

  if (form.passwordSelector) {
    add('password-masked', 'login-password-masked', 'critical',
      'Check how the password field renders what is typed',
      'the characters are masked, not shown in clear text', 'Password');
  }

  if (form.usernameSelector && form.passwordSelector && form.submitLabel) {
    add('empty-both', 'login-rejects-empty', 'critical',
      'Submit with both fields empty',
      'the box refuses and says so — nobody is signed in', 'Username and Password');
    add('empty-username', 'login-rejects-empty', 'critical',
      'Submit with the username empty and a password filled in',
      'the box refuses and says so', 'Username');
    add('empty-password', 'login-rejects-empty', 'critical',
      'Submit with a username filled in and the password empty',
      'the box refuses and says so', 'Password');
    add('wrong-password', 'login-rejects-wrong', 'critical',
      'Sign in with a real username and a wrong password',
      'the box refuses, says why, and stays on the login page', 'Password');
    add('valid', 'login-accepts-valid', 'critical',
      'Sign in with the credentials this run is configured with',
      'the box accepts them and the application opens', 'Login');
  }

  if (form.rememberMe) {
    add('remember-me', 'login-remember-me', 'normal',
      'Tick Remember Me, then untick it',
      'the checkbox changes state both ways', 'Remember Me');
  }

  for (const l of form.links) {
    add(`link-${l.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'login-link-opens', 'optional',
      l.external ? `Check the "${l.label}" link` : `Open "${l.label}"`,
      l.external
        ? 'it points somewhere real and opens in its own tab, so a half-signed-in operator is not navigated away'
        : 'it opens and the page renders',
      l.label);
  }

  return out;
}

// ------------------------------------------------------------- reading it --

/** Read the login page. Runs before anything signs in. */
export async function readLoginPage(page: Page, host: string): Promise<LoginForm | undefined> {
  const url = `http://${host}/`;
  const ok = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 })
    .then(() => true).catch(() => false);
  if (!ok) return undefined;
  await page.waitForTimeout(1200);

  const read: any = await page.evaluate(`(() => {
    const vis = (el) => el.getClientRects().length > 0;
    const user = Array.from(document.querySelectorAll('#username, input[name="username"], input[type="text"]')).filter(vis)[0];
    const pass = Array.from(document.querySelectorAll('#password, input[name="password"], input[type="password"]')).filter(vis)[0];
    const btns = Array.from(document.querySelectorAll('button, input[type="submit"]')).filter(vis);
    const submit = btns.find(b => /log\\s?in|sign\\s?in|submit/i.test((b.innerText || b.value || '')));
    const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    const cb = cbs.filter(vis)[0] || cbs[0];
    const cbLabel = cb ? ((cb.closest('label') || document.querySelector('label[for="' + (cb.id || '') + '"]') || {}).innerText || '').replace(/s+/g, ' ').trim().slice(0, 40) : '';
    const sel = (el) => el ? (el.id ? '#' + el.id : (el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : el.tagName.toLowerCase())) : undefined;
    const links = Array.from(document.querySelectorAll('a[href]')).filter(vis).map(a => ({
      label: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      href: a.getAttribute('href'),
      target: a.getAttribute('target') || '',
    })).filter(l => l.label && l.href && !l.href.startsWith('javascript:'));
    return {
      url: location.href,
      usernameSelector: sel(user),
      passwordSelector: sel(pass),
      passwordType: pass ? pass.getAttribute('type') : undefined,
      submitLabel: submit ? (submit.innerText || submit.value || 'Login').trim().slice(0, 30) : undefined,
      rememberMe: !!cb,
      rememberSelector: sel(cb),
      rememberLabel: cbLabel,
      links: links,
    };
  })()`).catch(() => undefined);
  if (!read) return undefined;

  return {
    url: read.url ?? url,
    usernameSelector: read.usernameSelector,
    passwordSelector: read.passwordSelector,
    passwordType: read.passwordType,
    submitLabel: read.submitLabel,
    rememberMe: !!read.rememberMe,
    rememberSelector: read.rememberSelector,
    rememberLabel: read.rememberLabel,
    links: (read.links ?? []).map((l: any) => ({
      label: l.label,
      href: l.href,
      external: /^https?:\/\//i.test(l.href) && !l.href.includes(host),
    })),
  };
}

// ------------------------------------------------------------- running it --

export interface StepRecord {
  n: number;
  label: string;
  ok: boolean;
  detail?: string;
  screenshotFile?: string;
}

export interface LoginCheckResult {
  status: 'pass' | 'fail' | 'skip' | 'error';
  actual: string;
  error?: string;
  reason?: string;
  steps: StepRecord[];
  screenshotFile?: string;
}

export interface LoginRunContext {
  /** A page in a context with no session — every login check needs one. */
  newAnonPage: () => Promise<Page>;
  host: string;
  username: string;
  password: string;
  /** Save a capture of the given page and return its file name. */
  shotOf: (page: Page, name: string) => Promise<string | undefined>;
}

const errorTextOf = (text: string): string | undefined => {
  const m = /(invalid|incorrect|wrong|required|cannot be empty|must be|failed|unauthori[sz]ed|not found)[^.\n]{0,80}/i.exec(text);
  return m ? m[0].trim() : undefined;
};

/** Run one login check in its own signed-out session. */
export async function runLoginCheck(ctx: LoginRunContext, c: GeneratedCheck, form: LoginForm): Promise<LoginCheckResult> {
  const steps: StepRecord[] = [];
  const page = await ctx.newAnonPage();
  let n = 0;
  const step = async (label: string, ok: boolean, detail?: string, capture = true): Promise<void> => {
    n += 1;
    steps.push({
      n, label, ok, detail,
      screenshotFile: capture ? await ctx.shotOf(page, `${c.id}__step${n}`) : undefined,
    });
  };

  try {
    const opened = await page.goto(form.url, { waitUntil: 'domcontentloaded', timeout: 40000 })
      .then(() => true).catch(() => false);
    await page.waitForTimeout(900);
    await step('Open the login page', opened, opened ? form.url : 'the page did not open');
    if (!opened) {
      return { status: 'fail', actual: `the login page at ${form.url} did not open`, steps, screenshotFile: steps[0]?.screenshotFile };
    }

    const user = form.usernameSelector ? page.locator(form.usernameSelector).first() : undefined;
    const pass = form.passwordSelector ? page.locator(form.passwordSelector).first() : undefined;
    const submit = form.submitLabel
      ? page.getByRole('button', { name: form.submitLabel, exact: false }).first()
      : undefined;

    const bodyText = async () => page.evaluate('document.body ? document.body.innerText : ""')
      .then(v => String(v ?? '')).catch(() => '');
    const signedIn = async () => {
      const u = page.url();
      const stillForm = form.usernameSelector
        ? await page.locator(form.usernameSelector).count().then(x => x > 0).catch(() => true)
        : false;
      return !stillForm && !/\/login|\/signin/.test(u) && u.replace(/\/$/, '') !== form.url.replace(/\/$/, '');
    };

    switch (c.kind) {
      case 'login-page-loads': {
        const text = await bodyText();
        const hasForm = !!(user && await user.count().catch(() => 0));
        await step('Look for the sign-in form', hasForm, hasForm ? 'username field present' : 'no username field found');
        return hasForm
          ? { status: 'pass', actual: `the login page rendered (${text.trim().length} characters) with its sign-in form`, steps, screenshotFile: steps[steps.length - 1]?.screenshotFile }
          : { status: 'fail', actual: 'the login page opened but the sign-in form is not on it', steps, screenshotFile: steps[steps.length - 1]?.screenshotFile };
      }

      case 'login-accepts-input': {
        if (!user || !pass) return { status: 'skip', actual: 'no form to type into', reason: 'fields absent', steps };
        await user.fill('probe-user');
        await step('Type a username', true, 'typed "probe-user"');
        await pass.fill('probe-pass');
        await step('Type a password', true, 'typed six characters');
        const got = await user.inputValue().catch(() => '');
        const gotPass = await pass.inputValue().catch(() => '');
        const ok = got === 'probe-user' && gotPass === 'probe-pass';
        await step('Read both fields back', ok, `username="${got}", password length ${gotPass.length}`, false);
        return ok
          ? { status: 'pass', actual: 'both fields took the text and kept it', steps, screenshotFile: steps[1]?.screenshotFile }
          : { status: 'fail', actual: `the fields did not keep what was typed (username="${got}", password length ${gotPass.length})`, steps, screenshotFile: steps[1]?.screenshotFile };
      }

      case 'login-password-masked': {
        if (!pass) return { status: 'skip', actual: 'no password field', reason: 'field absent', steps };
        await pass.fill('secret-value');
        const type = await pass.getAttribute('type').catch(() => null);
        const masked = type === 'password';
        await step('Type into the password field and check how it renders', masked, `type="${type ?? 'none'}"`);
        return masked
          ? { status: 'pass', actual: 'the field is type="password", so what is typed is masked', steps, screenshotFile: steps[1]?.screenshotFile }
          : { status: 'fail', actual: `the password field renders as type="${type ?? 'none'}" — what is typed is readable on screen`, steps, screenshotFile: steps[1]?.screenshotFile };
      }

      case 'login-rejects-empty': {
        if (!user || !pass || !submit) return { status: 'skip', actual: 'no form to submit', reason: 'form absent', steps };
        const which = c.id.endsWith('empty-username') ? 'username'
          : c.id.endsWith('empty-password') ? 'password' : 'both';
        // Empty the field under test and fill the other one. Written the
        // other way round first, which emptied neither in the both-empty case
        // and signed straight in — reported, for a few minutes, as the box
        // accepting an empty password. A test that lies about a security
        // behaviour is worse than no test.
        await user.fill(which === 'password' ? ctx.username : '');
        await pass.fill(which === 'username' ? ctx.password : '');
        await step(`Fill the form with ${which === 'both' ? 'nothing' : 'no ' + which}`, true);
        await submit.click({ timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(1500);
        await step('Press Login', true);
        const inside = await signedIn();
        const text = await bodyText();
        const complaint = errorTextOf(text) ?? (await page.evaluate(`(() => {
          const el = document.querySelector('#username:invalid, #password:invalid, input:invalid');
          return el ? (el.validationMessage || 'the browser blocked the submit') : '';
        })()`).then(v => String(v ?? '')).catch(() => ''));
        await step('Read what the page says', !inside, inside ? 'it signed in' : (complaint || 'it stayed on the login page'), false);
        if (inside) {
          return { status: 'fail', actual: `signing in succeeded with ${which === 'both' ? 'both fields' : 'the ' + which} empty`, steps, screenshotFile: steps[1]?.screenshotFile };
        }
        return {
          status: 'pass',
          actual: complaint ? `refused: "${complaint}"` : 'refused, and stayed on the login page',
          steps,
          screenshotFile: steps[1]?.screenshotFile,
        };
      }

      case 'login-rejects-wrong': {
        if (!user || !pass || !submit) return { status: 'skip', actual: 'no form to submit', reason: 'form absent', steps };
        await user.fill(ctx.username);
        await pass.fill(`not-${ctx.password}-either`);
        await step('Fill in a real username and a wrong password', true);
        const resp = page.waitForResponse(r => /\/v\d\/login/.test(r.url()), { timeout: 15000 }).catch(() => null);
        await submit.click({ timeout: 8000 }).catch(() => null);
        const r = await resp;
        await page.waitForTimeout(1500);
        await step('Press Login', true, r ? `the box answered ${r.status()}` : 'no login response seen');
        const inside = await signedIn();
        const text = await bodyText();
        const complaint = errorTextOf(text);
        await step('Read what the page says', !inside, inside ? 'it signed in' : (complaint || 'no message found'), false);
        if (inside) {
          return { status: 'fail', actual: 'a wrong password was accepted', error: 'this is an access-control failure, not a UI one', steps, screenshotFile: steps[1]?.screenshotFile };
        }
        if (!complaint) {
          return { status: 'fail', actual: 'the wrong password was refused but the page says nothing — an operator is left guessing', steps, screenshotFile: steps[1]?.screenshotFile };
        }
        return { status: 'pass', actual: `refused with "${complaint}"${r ? `, box answered ${r.status()}` : ''}`, steps, screenshotFile: steps[1]?.screenshotFile };
      }

      case 'login-accepts-valid': {
        if (!user || !pass || !submit) return { status: 'skip', actual: 'no form to submit', reason: 'form absent', steps };
        await user.fill(ctx.username);
        await pass.fill(ctx.password);
        await step(`Fill in ${ctx.username} and its password`, true);
        await submit.click({ timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(3500);
        await step('Press Login', true);
        const inside = await signedIn();
        await step('Check where we landed', inside, page.url());
        return inside
          ? { status: 'pass', actual: `signed in as ${ctx.username}, landed on ${page.url()}`, steps, screenshotFile: steps[2]?.screenshotFile }
          : { status: 'fail', actual: `the credentials were not accepted — still at ${page.url()}`, steps, screenshotFile: steps[2]?.screenshotFile };
      }

      case 'login-remember-me': {
        const cb = page.locator(form.rememberSelector || 'input[type="checkbox"]').first();
        if (!(await cb.count().catch(() => 0))) {
          return { status: 'skip', actual: 'no Remember Me checkbox on the page now', reason: 'it was there when the page was read', steps };
        }
        const was = await cb.isChecked().catch(() => false);
        // A styled checkbox hides its real input and takes the click on the
        // label, so the input alone is not enough to drive it.
        const toggle = async () => {
          if (await cb.setChecked(!(await cb.isChecked().catch(() => false)), { timeout: 4000 }).then(() => true).catch(() => false)) return;
          const label = form.rememberLabel
            ? page.getByText(form.rememberLabel, { exact: false }).first()
            : page.getByText(/remember/i).first();
          await label.click({ timeout: 4000 }).catch(() => null);
        };
        await toggle();
        await page.waitForTimeout(300);
        const after = await cb.isChecked().catch(() => was);
        await step(`Tick it (it was ${was ? 'on' : 'off'})`, after !== was, `now ${after ? 'on' : 'off'}`);
        if (after !== was) await toggle();
        await page.waitForTimeout(300);
        const back = await cb.isChecked().catch(() => after);
        await step('Put it back', back === was, `now ${back ? 'on' : 'off'}`, false);
        return after !== was && back === was
          ? { status: 'pass', actual: 'the checkbox changes state both ways', steps, screenshotFile: steps[1]?.screenshotFile }
          : { status: 'fail', actual: `the checkbox did not change state (started ${was}, after ticking ${after}, after unticking ${back})`, steps, screenshotFile: steps[1]?.screenshotFile };
      }

      case 'login-link-opens': {
        const link = form.links.find(l => c.element === l.label);
        if (!link) return { status: 'skip', actual: 'the link is no longer on the page', reason: 'not found', steps };
        const el = page.locator(`a[href="${link.href}"]`).first();
        if (!(await el.count().catch(() => 0))) {
          return { status: 'fail', actual: `the "${link.label}" link is not on the login page any more`, steps };
        }
        if (link.external) {
          // Not followed: the lab browser has no business loading simnovus.com,
          // and an operator who clicks it should not lose the login page.
          const target = await el.getAttribute('target').catch(() => null);
          await step('Check the link without following it', true, `href=${link.href}, target=${target ?? 'none'}`);
          return {
            status: 'pass',
            actual: `points at ${link.href}${target === '_blank' ? ', opens in its own tab' : ' (opens in this tab)'}`,
            steps,
            screenshotFile: steps[0]?.screenshotFile,
          };
        }
        const before = page.url();
        await el.click({ timeout: 8000 }).catch(() => null);
        await page.waitForTimeout(1800);
        const text = await bodyText();
        const rendered = text.trim().length > 20;
        // "It rendered" is not enough: the login page renders too. The link
        // has to have actually gone where it points, or the check passes on
        // every dead link in the footer.
        const path = link.href.replace(/^https?:\/\/[^/]+/, '') || '/';
        const went = page.url() !== before || page.url().includes(path);
        await step(`Open "${link.label}"`, rendered && went, `${page.url()} — ${text.trim().length} characters`);
        if (!went) {
          return { status: 'fail', actual: `clicking "${link.label}" did not leave the login page — still at ${page.url()}, expected ${path}`, steps, screenshotFile: steps[1]?.screenshotFile };
        }
        return rendered
          ? { status: 'pass', actual: `opened ${page.url()} and it rendered`, steps, screenshotFile: steps[1]?.screenshotFile }
          : { status: 'fail', actual: `"${link.label}" opened ${page.url()} and it came back blank`, steps, screenshotFile: steps[1]?.screenshotFile };
      }

      default:
        return { status: 'skip', actual: `no executor for "${c.kind}"`, reason: 'unimplemented', steps };
    }
  } catch (e: any) {
    return { status: 'error', actual: 'the check could not be completed', error: String(e?.message ?? e).slice(0, 300), steps };
  } finally {
    await page.context().close().catch(() => null);
  }
}
