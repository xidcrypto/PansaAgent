// Optional browser page reader (playwright is an optional peer). The
// loader is injectable so tests never need a real browser.
import { createRequire } from "node:module";
export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
}

export interface BrowserPage {
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number }) => Promise<void>;
  title: () => Promise<string>;
  innerText: (selector: string) => Promise<string>;
  close: () => Promise<void>;
}

export interface BrowserInstance {
  newPage: () => Promise<BrowserPage>;
  close: () => Promise<void>;
}

export type PlaywrightLoader = () => Promise<{
  chromium: { launch: (opts?: { headless?: boolean }) => Promise<BrowserInstance> };
}>;

export async function openPage(url: string, load: PlaywrightLoader | null = null): Promise<PageSnapshot> {
  let loader = load;
  if (!loader) {
    try {
      // createRequire (not import()) so a missing optional peer is a
      // runtime error we can report honestly, not a type error.
      const req = createRequire(import.meta.url);
      const mod = req("playwright") as unknown as {
        chromium: { launch: (opts?: { headless?: boolean }) => Promise<BrowserInstance> };
      };
      loader = async () => ({ chromium: mod.chromium });
    } catch {
      throw new Error("playwright tidak terinstal (peer opsional). Jalankan: npm i playwright");
    }
  }
  const pw = await loader();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const title = await page.title();
    const text = (await page.innerText("body")).slice(0, 8000);
    await page.close();
    return { url, title, text };
  } finally {
    await browser.close();
  }
}
