import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

let browserInstance: Browser | null = null;

const getBrowser = async (): Promise<Browser> => {
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
    }
    return browserInstance;
};

export interface SafeGetResult {
    html: string;
    cookies: any[];
}

/**
 * A CloudflareKiller equivalent using Puppeteer.
 * It navigates to the URL, waits for the Cloudflare challenge to pass, and returns the HTML and cookies.
 */
export const safeGet = async (url: string, headers?: Record<string, string>): Promise<SafeGetResult> => {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        if (headers) {
            await page.setExtraHTTPHeaders(headers);
        }

        // Navigate and wait for network to be idle
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Wait a bit to ensure Cloudflare challenge is solved if present
        let html = await page.content();
        
        // Basic check for Cloudflare challenge
        if (html.includes('Just a moment...') || html.includes('cf-browser-verification')) {
            console.log(`[CloudflareKiller] Challenge detected on ${url}. Waiting...`);
            // Wait up to 15 seconds for challenge to clear (usually redirects or removes the challenge div)
            try {
                await page.waitForFunction(
                    () => !document.body.innerText.includes('Just a moment...'),
                    { timeout: 15000 }
                );
                // Extra wait to let final page render
                await new Promise(r => setTimeout(r, 2000));
            } catch (e) {
                console.log(`[CloudflareKiller] Timeout waiting for challenge to clear.`);
            }
        }

        html = await page.content();
        if (process.env.CF_DEBUG === 'true') {
            await page.screenshot({ path: 'cloudflare_debug.png' });
        }
        const cookies = await page.cookies();

        return { html, cookies };
    } catch (e) {
        console.error(`[CloudflareKiller] Error fetching ${url}`, e);
        throw e;
    } finally {
        await page.close();
    }
};

export const closeBrowser = async () => {
    if (browserInstance) {
        await browserInstance.close();
        browserInstance = null;
    }
};
