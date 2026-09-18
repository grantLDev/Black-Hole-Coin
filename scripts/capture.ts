/**
 * Headless capture and benchmark harness.
 *
 * Drives the real page in a real browser rather than re-implementing the
 * shader in a test rig, because the thing most likely to be wrong is the
 * interaction between the quality defines, the uniform plumbing and the GLSL —
 * none of which a re-implementation would exercise.
 *
 *   npx tsx scripts/capture.ts shots      screenshots across tiers and times
 *   npx tsx scripts/capture.ts bench      frame time at 1920x1080
 *
 * The banding check is a separate harness — see scripts/banding.ts — because it
 * measures pixel values rather than looking at them, and needs a frame read back
 * from the renderer rather than a PNG of the page.
 *
 * Requires the dev or production server to already be listening on BASE_URL.
 *
 * A NOTE ON THE NUMBERS. On a machine with no GPU, Chromium falls back to
 * SwiftShader and rasterises on the CPU. The harness reports the unmasked
 * renderer string alongside every measurement for exactly that reason: a
 * SwiftShader frame time says something about the shader's instruction count
 * and nothing about whether it holds 60fps on real hardware.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? path.join(process.cwd(), "capture");

const VIEWPORT = { width: 1920, height: 1080 };

/**
 * Explicit Chromium binary, for environments that ship browsers separately
 * from the npm package. Playwright refuses to launch when the installed
 * package's expected build number differs from what is on disk, even though
 * any recent Chromium runs this page fine.
 */
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH;

/** Flags that force the software rasteriser to run WebGL2 at all. */
const CHROMIUM_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-lcd-text",
  // rAF is throttled in a headless window that is considered occluded, which
  // would make every frame-time sample a scheduler artefact.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

interface Shot {
  readonly name: string;
  readonly query: string;
}

/**
 * Each of these isolates one claim from the brief, so a regression shows up in
 * a specific frame rather than as "the black hole looks different".
 */
const SHOTS: readonly Shot[] = [
  { name: "01-tier0-protostar", query: "tier=0&t=0&quality=high" },
  { name: "02-tier4-photon-ring", query: "tier=4&t=0&quality=high" },
  { name: "03-tier8-quasar", query: "tier=8&t=0&quality=high" },
  { name: "04-tier11-gargantua", query: "tier=11&t=0&quality=high" },
  { name: "05-tier11-later", query: "tier=11&t=48&quality=high" },
  // A narrow fov is the only way to see whether the photon ring is a sharp
  // line or a soft band: at 50 degrees it is a couple of pixels wide.
  { name: "06-photon-ring-closeup", query: "tier=11&t=0&quality=high&fov=13" },
  { name: "07-shadow-edge", query: "tier=4&t=0&quality=high&fov=20" },
  // The elevation sweep runs 0.115..0.205 rad with a 134s period, so pinning
  // scene time is also how the inclination gets inspected.
  { name: "11-high-inclination", query: "tier=11&t=33.4&quality=high" },
  { name: "12-low-inclination", query: "tier=11&t=100&quality=high" },
  { name: "08-quality-low", query: "tier=11&t=0&quality=low" },
  { name: "09-quality-medium", query: "tier=11&t=0&quality=medium" },
  // The post chain, on and off, on the same frame. `13` and `14` are the pair
  // to compare: everything the post stack does — bloom, aberration, vignette,
  // grain — is the difference between them, and the low tier's shipped image
  // is exactly `14`.
  { name: "13-post-on", query: "tier=11&t=0&quality=high&post=1" },
  { name: "14-post-off", query: "tier=11&t=0&quality=high&post=0" },
  // Tier 0 with post on: the quietest the chain ever gets, and where an
  // overdone bloom or a visible grain would show first.
  { name: "15-post-tier0", query: "tier=0&t=0&quality=high&post=1" },
  // Above the plane, to confirm the over-and-under wrap is lensing and not a
  // mirrored copy of the disk.
  { name: "10-oblique", query: "tier=11&t=33.4&quality=high" },
];

async function collectErrors(page: Page, sink: string[]): Promise<void> {
  page.on("pageerror", (error) => sink.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") sink.push(`console: ${message.text()}`);
  });
}

async function withBrowser<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({
    args: CHROMIUM_ARGS,
    ...(EXECUTABLE_PATH ? { executablePath: EXECUTABLE_PATH } : {}),
  });
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

/**
 * `?t=` pins scene time, so the frame is deterministic — but the shader still
 * has to compile and the first draw still has to land. Waiting for the debug
 * overlay to report a frame is the signal that both happened.
 */
async function waitForFirstFrame(page: Page): Promise<void> {
  await page.waitForSelector("pre", { timeout: 60_000 });
  await page.waitForTimeout(1200);
}

async function captureShots(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  // A full sweep is slow enough on a software rasteriser to be worth
  // narrowing: SHOTS=photon-ring,low re-takes just the frames a change
  // actually affects.
  const filter = process.env.SHOTS?.split(",").map((part) => part.trim()).filter(Boolean);
  const wanted = filter?.length
    ? SHOTS.filter((shot) => filter.some((part) => shot.name.includes(part)))
    : SHOTS;

  await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();

    const errors: string[] = [];
    await collectErrors(page, errors);

    for (const shot of wanted) {
      await page.goto(`${BASE_URL}/?debug&${shot.query}`, { waitUntil: "networkidle" });
      await waitForFirstFrame(page);
      const file = path.join(OUT_DIR, `${shot.name}.png`);
      // Generous: under SwiftShader a single 1080p frame at 300 steps takes
      // seconds, and a narrow fov fills the screen with the most expensive
      // rays in the scene.
      await page.screenshot({ path: file, timeout: 300_000 });
      console.log(`captured ${shot.name}  (${shot.query})`);
    }

    // A WebGL program that fails to link shows up here and nowhere else: the
    // canvas just stays black, which is also what a correct shadow looks like.
    if (errors.length > 0) {
      console.error("\nPAGE ERRORS:");
      for (const line of errors) console.error(`  ${line}`);
      process.exitCode = 1;
    } else {
      console.log("\nno page errors");
    }
  });
}

async function runBench(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const result = await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();

    const errors: string[] = [];
    await collectErrors(page, errors);

    const quality = process.env.BENCH_QUALITY ?? "high";
    const tier = process.env.BENCH_TIER ?? "11";
    await page.goto(`${BASE_URL}/?bench&quality=${quality}&tier=${tier}`, {
      waitUntil: "networkidle",
    });

    const value = await page.waitForFunction(() => window.__singularityBench, null, {
      timeout: 180_000,
      polling: 500,
    });
    const bench = await value.jsonValue();

    if (errors.length > 0) {
      console.error("PAGE ERRORS:");
      for (const line of errors) console.error(`  ${line}`);
    }
    return bench;
  });

  console.log(JSON.stringify(result, null, 2));
  await writeFile(path.join(OUT_DIR, "bench.json"), `${JSON.stringify(result, null, 2)}\n`);
}

const mode = process.argv[2] ?? "shots";
const run = mode === "bench" ? runBench : captureShots;

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
