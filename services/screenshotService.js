import https from "https";
import http from "http";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { Storage } from "@google-cloud/storage";

const __dirname = dirname(fileURLToPath(import.meta.url));

const storage = new Storage({
  keyFilename: join(__dirname, "../routes/service-project-file.json"),
});

const GCS_BUCKET = 'bucket-myhandle';
const GCS_FOLDER = "discover/screenshots";

// ── Binary HTTP fetch (follows one redirect) ───────────────────────────────────
function fetchBinary(url, timeoutMs = 30000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 3) return reject(new Error("Too many redirects"));
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        req.destroy();
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchBinary(next, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        req.destroy();
        return reject(new Error(`ScreenshotOne HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end",  () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("Screenshot request timed out")); });
    req.on("error", reject);
  });
}

  const SCREENSHOTONE_ACCESS_KEY = process.env.SCREENSHOTONE_ACCESS_KEY;


// ── Build ScreenshotOne API URL (unsigned — access_key only) ──────────────────
function buildApiUrl(targetUrl, opts = {}) {
  const accessKey = SCREENSHOTONE_ACCESS_KEY;
  if (!accessKey) throw new Error("SCREENSHOTONE_ACCESS_KEY not set");

  const isFullPage = opts.full_page ?? false;
  const params = new URLSearchParams({
    access_key:           accessKey,
    url:                  targetUrl,
    format:               "webp",
    image_quality:        "82",
    viewport_width:       "1280",
    viewport_height:      String(opts.viewport_height ?? 800),
    full_page:            String(isFullPage),
    delay:                String(opts.delay ?? 2),
    timeout:              "25",
    block_ads:            "true",
    block_cookie_banners: "true",
    block_chats:          "true",
  });

  // full_page_max_height is only valid when full_page is true
  if (isFullPage) params.set("full_page_max_height", String(opts.full_page_max_height ?? 5000));

  return `https://api.screenshotone.com/take?${params.toString()}`;
}

// ── Upload buffer to GCS and return the public URL ────────────────────────────
async function uploadToGCS(buffer, filename) {
  const bucket = storage.bucket(GCS_BUCKET);
  const file   = bucket.file(`${GCS_FOLDER}/${filename}`);

  await file.save(buffer, {
    metadata: { contentType: "image/webp", cacheControl: "public, max-age=31536000" },
    resumable: false,
  });

  // Public URL format for a public GCS bucket
  return `https://storage.googleapis.com/${GCS_BUCKET}/${GCS_FOLDER}/${filename}`;
}

// ── Slug a URL into a safe filename prefix ─────────────────────────────────────
function urlToSlug(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  } catch {
    return "site";
  }
}

/**
 * Capture a single full-page screenshot and return the raw Buffer.
 * Used for passing to Gemini Vision — no GCS upload needed.
 * Throws if ScreenshotOne is not configured or the request fails.
 */
export async function capturePageBuffer(pageUrl, opts = {}) {
  if (!SCREENSHOTONE_ACCESS_KEY) throw new Error("SCREENSHOTONE_ACCESS_KEY not set");
  const apiUrl = buildApiUrl(pageUrl, { full_page: true, viewport_height: 1200, ...opts });
  return await fetchBinary(apiUrl);
}

/**
 * Capture screenshots of a website via ScreenshotOne and upload them to GCS.
 * Pass extraUrl to capture a 3rd screenshot of a different page (e.g. pricing).
 * Returns an array of public GCS URLs (up to 3), or [] on failure / missing config.
 */
export async function captureScreenshots(websiteUrl, extraUrls = []) {
  if (!SCREENSHOTONE_ACCESS_KEY) {
    console.warn("[screenshotService] SCREENSHOTONE_ACCESS_KEY not set — skipping");
    return [];
  }
  if (!GCS_BUCKET) {
    console.warn("[screenshotService] GCS_BUCKET_NAME not set — skipping");
    return [];
  }

  const slug = urlToSlug(websiteUrl);
  const ts   = Date.now();
  const urls = [];

  // hero: viewport-only shot of homepage (good for SPAs — avoids animated whitespace)
  // extras: full-page shots of secondary pages (pricing, features, etc.)
  const shots = [
    { targetUrl: websiteUrl, suffix: "hero", full_page: false, viewport_height: 800 },
  ];
  (Array.isArray(extraUrls) ? extraUrls : [extraUrls]).filter(Boolean).slice(0, 2).forEach((u, i) => {
    shots.push({ targetUrl: u, suffix: `extra${i + 1}`, full_page: true, viewport_height: 1000 });
  });

  for (const shot of shots) {
    try {
      const apiUrl    = buildApiUrl(shot.targetUrl, shot);
      const buffer    = await fetchBinary(apiUrl);
      const filename  = `${slug}-${ts}-${shot.suffix}.webp`;
      const publicUrl = await uploadToGCS(buffer, filename);
      urls.push(publicUrl);
    } catch (err) {
      console.error(`[screenshotService] ${shot.suffix} screenshot failed:`, err.message);
    }
  }

  return urls;
}

/**
 * Delete screenshot files from GCS (call on listing delete or re-analyze).
 * Pass the array of public GCS URLs stored in the DB.
 */
export async function deleteScreenshots(publicUrls = []) {
  if (!GCS_BUCKET) return;
  const bucket = storage.bucket(GCS_BUCKET);

  for (const url of publicUrls) {
    try {
      // Extract the GCS object path from the public URL
      const objectPath = url.replace(`https://storage.googleapis.com/${GCS_BUCKET}/`, "");
      if (objectPath) await bucket.file(objectPath).delete({ ignoreNotFound: true });
    } catch (err) {
      console.warn("[screenshotService] Could not delete GCS file:", url, err.message);
    }
  }
}
