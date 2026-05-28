/**
 * Thin Playwright wrapper used by the browser sub-agent.
 *
 * We never let the LLM touch the raw Playwright API. Every "tool" it
 * can call goes through a method on this class, which gives us a
 * single chokepoint to:
 *   - Cap page sizes (so a 1MB-of-html page can't blow the LLM context).
 *   - Generate stable, LLM-friendly selectors instead of fragile CSS.
 *   - Enforce per-navigation timeouts so a slow page can't stall the
 *     whole run.
 *
 * Lifecycle: one Playwright Browser per BrowserDriver, lazily
 * launched on the first command, explicitly closed via shutdown().
 * The BrowserAgent reuses the same driver across every step in a
 * single orchestrator run — multi-step plans benefit from the
 * page-context staying alive (logged-in sessions, history-back).
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/** Default per-action timeout. 30s catches genuinely slow pages
 *  without making the agent wait forever on a hung tab. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard cap on the text we extract from a page. The LLM context is
 *  finite; 8 KB of cleaned text is enough to identify what's on the
 *  page and which element to click next. The agent can scroll +
 *  re-read for more. */
const PAGE_TEXT_BUDGET = 8 * 1024;

/** Hard cap on interactive-elements list. 40 buttons/links/inputs is
 *  more than any sane navigation step needs. */
const INTERACTIVE_BUDGET = 40;

export interface InteractiveElement {
  /** A stable, LLM-readable identifier the agent uses in click()/
   *  type() calls. Format: "[N]" where N is the 1-based index in the
   *  list returned by read_page(). */
  ref: string;
  /** What the element looks like to the user — visible text for
   *  buttons/links, label/placeholder for inputs. */
  text: string;
  /** Element role: button | link | textbox | checkbox | radio | select. */
  role: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  /** Cleaned visible text, capped at PAGE_TEXT_BUDGET. */
  text: string;
  /** Whether `text` was truncated (so the prompt can mention "…(truncated)"). */
  truncated: boolean;
  /** Interactive elements with stable refs for click/type. */
  interactive: InteractiveElement[];
}

export class BrowserDriver {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /** Map ref → Playwright Locator handle. Rebuilt on every
   *  read_page() because the DOM may have changed since last call.
   *  The agent always reads BEFORE acting so this is fresh enough. */
  private refToLocator = new Map<string, ReturnType<Page["locator"]>>();

  private readonly headless: boolean;

  constructor(opts: { headless?: boolean } = {}) {
    this.headless = opts.headless ?? true;
  }

  /** Launch on first use. Idempotent. */
  private async ensure(): Promise<Page> {
    if (this.page) return this.page;
    this.browser = await chromium.launch({ headless: this.headless });
    this.context = await this.browser.newContext({
      // Identifying ourselves keeps us off bot blockers that target
      // "HeadlessChrome". Same UA string Playwright uses in non-
      // headless mode.
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
      locale: "fr-FR",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    return this.page;
  }

  async navigate(url: string): Promise<PageSnapshot> {
    const page = await this.ensure();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    // Some sites finish rendering after the load event (React SPAs).
    // 800ms is a pragmatic settling window before we snapshot.
    await page.waitForTimeout(800);
    return this.readPage();
  }

  async readPage(): Promise<PageSnapshot> {
    const page = await this.ensure();
    const [url, title] = await Promise.all([page.url(), page.title()]);

    // Visible text: innerText drops display:none + script content
    // automatically. We also collapse runs of whitespace because
    // pages tend to be soup-y.
    const rawText: string = await page.evaluate(() => {
      const root = document.body;
      if (!root) return "";
      // ts-ignore: cross-window typing
      const text = (root as HTMLElement).innerText ?? "";
      return text.replace(/\s+/g, " ").trim();
    });
    const truncated = rawText.length > PAGE_TEXT_BUDGET;
    const text = truncated ? rawText.slice(0, PAGE_TEXT_BUDGET) + "…" : rawText;

    // Interactive elements. We snapshot once into an array of
    // {ref, role, text, locator-spec}. The driver remembers the
    // mapping from `ref` to a Playwright locator so the next click()
    // call can resolve back.
    const interactives = await page.evaluate(() => {
      function visibleText(el: Element): string {
        const txt = (el as HTMLElement).innerText || el.textContent || "";
        return txt.replace(/\s+/g, " ").trim().slice(0, 80);
      }
      function label(el: HTMLInputElement | HTMLTextAreaElement): string {
        // Try aria-label → placeholder → associated <label>. Falls
        // back to the input's name attribute.
        if (el.getAttribute("aria-label"))
          return el.getAttribute("aria-label")!.slice(0, 80);
        if (el.placeholder) return el.placeholder.slice(0, 80);
        const id = el.id;
        if (id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (lbl) return (lbl.textContent || "").trim().slice(0, 80);
        }
        return (el.getAttribute("name") || "").slice(0, 80);
      }
      const out: { role: string; text: string; selector: string }[] = [];

      // Buttons + button-roled elements.
      document
        .querySelectorAll<HTMLElement>(
          'button, [role="button"], input[type="submit"], input[type="button"]'
        )
        .forEach((el) => {
          if (!(el as HTMLElement).offsetParent && el.tagName !== "INPUT")
            return; // hidden
          out.push({
            role: "button",
            text:
              visibleText(el) ||
              ((el as HTMLInputElement).value ?? "").slice(0, 80) ||
              "(unnamed button)",
            selector: cssPath(el),
          });
        });

      // Links.
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((el) => {
        if (!el.offsetParent) return;
        const t = visibleText(el);
        if (!t) return; // skip naked anchors
        out.push({ role: "link", text: t, selector: cssPath(el) });
      });

      // Text inputs + textareas.
      document
        .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea'
        )
        .forEach((el) => {
          if (!(el as HTMLElement).offsetParent) return;
          out.push({
            role: "textbox",
            text: label(el) || "(unnamed input)",
            selector: cssPath(el),
          });
        });

      // Checkboxes + radios.
      document
        .querySelectorAll<HTMLInputElement>(
          'input[type="checkbox"], input[type="radio"]'
        )
        .forEach((el) => {
          if (!el.offsetParent) return;
          out.push({
            role: el.type,
            text: label(el) || el.name || "(unnamed)",
            selector: cssPath(el),
          });
        });

      // Selects.
      document.querySelectorAll<HTMLSelectElement>("select").forEach((el) => {
        if (!el.offsetParent) return;
        out.push({
          role: "select",
          text: label(el as unknown as HTMLInputElement) || "(unnamed select)",
          selector: cssPath(el),
        });
      });

      function cssPath(el: Element): string {
        // Stable selector: nth-of-type chain. CSS selectors that
        // depend on text content are brittle when localised; the
        // agent gets the visible text separately as `text`, so the
        // selector only needs to be unique.
        if (el.id) return `#${CSS.escape(el.id)}`;
        const parts: string[] = [];
        let current: Element | null = el;
        while (current && current.tagName !== "HTML") {
          const parent: Element | null = current.parentElement;
          if (!parent) break;
          const siblings = Array.from(parent.children).filter(
            (c) => c.tagName === current!.tagName
          );
          const idx = siblings.indexOf(current) + 1;
          parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${idx})`);
          current = parent;
        }
        return parts.join(" > ");
      }

      return out;
    });

    // Cap + assign refs. Rebuilds the ref→locator map; the previous
    // refs are now stale, but the agent always reads before acting
    // so that's fine.
    this.refToLocator.clear();
    const capped = interactives.slice(0, INTERACTIVE_BUDGET);
    const interactive: InteractiveElement[] = capped.map((el, i) => {
      const ref = `[${i + 1}]`;
      this.refToLocator.set(ref, page.locator(el.selector).first());
      return { ref, text: el.text, role: el.role };
    });

    return { url, title, text, truncated, interactive };
  }

  async click(ref: string): Promise<void> {
    const loc = this.refToLocator.get(ref);
    if (!loc) {
      throw new Error(
        `Unknown element ref '${ref}'. Call read_page first to get fresh refs.`
      );
    }
    await loc.scrollIntoViewIfNeeded();
    await loc.click({ timeout: DEFAULT_TIMEOUT_MS });
    await this.settle();
  }

  async type(ref: string, text: string): Promise<void> {
    const loc = this.refToLocator.get(ref);
    if (!loc) {
      throw new Error(
        `Unknown element ref '${ref}'. Call read_page first to get fresh refs.`
      );
    }
    await loc.scrollIntoViewIfNeeded();
    // fill() clears existing content first — closest to what a human
    // would do when "typing" into a search box.
    await loc.fill(text);
  }

  async press(key: string): Promise<void> {
    const page = await this.ensure();
    await page.keyboard.press(key);
    await this.settle();
  }

  async scroll(direction: "down" | "up", amount = 800): Promise<void> {
    const page = await this.ensure();
    const dy = direction === "down" ? amount : -amount;
    await page.evaluate((d: number) => window.scrollBy(0, d), dy);
    await page.waitForTimeout(300);
  }

  async back(): Promise<void> {
    const page = await this.ensure();
    await page.goBack({ waitUntil: "domcontentloaded" });
    await this.settle();
  }

  async waitMs(ms: number): Promise<void> {
    const page = await this.ensure();
    await page.waitForTimeout(Math.max(0, Math.min(ms, 10_000)));
  }

  async shutdown(): Promise<void> {
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.close();
    } catch {
      /* best-effort */
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
      this.refToLocator.clear();
    }
  }

  /** Brief settle after any interaction — gives the page a moment to
   *  navigate / re-render before the agent reads it again. */
  private async settle(): Promise<void> {
    const page = await this.ensure();
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
    } catch {
      /* page didn't navigate — that's fine, settle anyway */
    }
    await page.waitForTimeout(400);
  }
}
