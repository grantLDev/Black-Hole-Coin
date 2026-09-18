/**
 * The banding check.
 *
 * Wide, very dark gradients quantised to 8 bits are where amateur post work
 * gives itself away: the eye's Mach-band response turns a one-level step
 * across forty pixels into a visible contour, and this project's background is
 * nothing but wide dark gradients — the galactic band, the outer disk's
 * falloff, and now the vignette, which lays a smooth radial ramp over the
 * entire frame. The brief calls this out as the most common tell, so it gets
 * measured rather than eyeballed.
 *
 *   npx tsx scripts/banding.ts
 *
 * HOW IT MEASURES. Banding is not "few distinct values", and it is not "long
 * runs of one value" either — a patch of true black is a very long run of one
 * value and is not a band. A band is a PLATEAU IN A RAMP: a long run whose
 * neighbours on either side are exactly one level away. That is the signature
 * the eye picks up, and it is what this measures. For every dark tile, each row
 * is broken into maximal constant-value runs, and a run is counted as a band
 * when all of the following hold:
 *
 *   - it is at least BAND_RUN pixels long;
 *   - its value is neither 0 nor 255, so clipped black and blown highlights,
 *     which cannot be dithered and are not banding, are excluded;
 *   - every neighbouring run it has is exactly one level away, so a hard edge
 *     between two different things is excluded, and so is a run that spans a
 *     whole row with nothing to compare against.
 *
 * A dithered ramp produces runs one or two pixels long, because the dither
 * keeps flipping the rounding decision from pixel to pixel. An undithered ramp
 * produces plateaus as long as the ramp is shallow, and those plateaus are the
 * contours.
 *
 * WHY IT IS AN EXPERIMENT AND NOT AN ASSERTION. A run-length threshold on its
 * own is satisfied by any frame with enough texture in it, including a frame
 * where the dither does nothing. So each tile is measured twice: once as
 * rendered, and once with `uNoiseScale` at 0, which turns off grain and dither
 * together. The control has to FAIL — if the undithered frame does not band,
 * the tile had no gradient to band and proves nothing, and it is reported as
 * inconclusive rather than counted as a pass. Only tiles that band without the
 * dither and do not band with it are evidence.
 *
 * Requires a dev or production server on BASE_URL, and a browser that can
 * render to half float — the post chain does not exist without it, and neither
 * does the frame this measures.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const OUT_DIR = process.env.OUT_DIR ?? path.join(process.cwd(), "capture");

const VIEWPORT = { width: 1280, height: 720 };
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH;

const CHROMIUM_ARGS = [
  "--use-gl=angle",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

/** Side of one analysis tile, in pixels. */
const TILE = 64;

/**
 * Mean 8-bit luma below which a tile counts as "dark".
 *
 * Banding is a shadow problem: the sRGB curve allocates its levels so that one
 * step near black is a far larger relative change than one step near white, and
 * the background of this scene lives entirely down there.
 */
const DARK_LUMA_MAX = 70;

/**
 * A tile with no gradient at all — a patch of pure black, or the inside of the
 * shadow — has nothing to band and would pass any test. Tiles whose channel
 * range is below this are skipped outright.
 */
const MIN_TILE_RANGE = 2;

/**
 * Run length at or above which a run counts as a band, in pixels.
 *
 * Eight is deliberately conservative. Contours become visible to most people
 * somewhere around four to six pixels of constant value in a smooth ramp; at
 * eight, anything this flags is unambiguous.
 */
const BAND_RUN = 8;

/**
 * Share of a tile's pixels allowed to sit inside a band, as rendered.
 *
 * Two percent, which at 64x64 is about 80 pixels out of 4096 — enough slack for
 * a tile that clips the edge of the shadow, where a genuinely constant region
 * meets a gradient, and far below what a real contour produces.
 */
const MAX_BANDED_FRACTION = 0.02;

/**
 * Share of a tile's pixels that must sit inside a band with the dither OFF for
 * the tile to count as evidence rather than as an inconclusive sample.
 */
const CONTROL_BANDED_FRACTION = 0.08;

interface Scene {
  readonly name: string;
  readonly query: string;
}

/**
 * Tier 0 and tier 11 bracket the range: the darkest frame this project can
 * show and the brightest. The dark one is where banding is most likely and the
 * bright one is where the bloom lays its own wide smooth ramp over the sky.
 */
const SCENES: readonly Scene[] = [
  { name: "tier0", query: "tier=0&t=0&quality=high" },
  { name: "tier4", query: "tier=4&t=0&quality=high" },
  { name: "tier11", query: "tier=11&t=0&quality=high" },
];

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

interface TileStats {
  readonly x: number;
  readonly y: number;
  readonly meanLuma: number;
  readonly range: number;
  /** Fraction of channel samples inside a run of BAND_RUN or longer. */
  readonly bandedFraction: number;
  readonly longestRun: number;
}

/**
 * Break one row of one channel into maximal constant-value runs and count how
 * many pixels sit inside a run that qualifies as a band.
 *
 * Rows only, not columns. Every gradient in this frame is either radial (the
 * vignette, the disk's falloff) or follows the disk, so none of them is exactly
 * vertical, and a horizontal scan crosses all of them. Scanning both ways would
 * double the work to find the same contours twice.
 */
function bandedPixelsInRow(values: number[]): { banded: number; longest: number } {
  const runs: { value: number; length: number }[] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.length += 1;
    else runs.push({ value, length: 1 });
  }

  let banded = 0;
  let longest = 0;

  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i];
    if (run.length > longest) longest = run.length;
    if (run.length < BAND_RUN) continue;

    // Clipped black and blown white are not banding. Nothing can dither a
    // value that has nowhere left to go.
    if (run.value === 0 || run.value === 255) continue;

    const previous = runs[i - 1];
    const next = runs[i + 1];
    // A run with no neighbour at all spans the whole row: flat, not a plateau.
    if (!previous && !next) continue;
    // A neighbour more than one level away is an edge between two different
    // things, not the next step of a ramp.
    if (previous && Math.abs(previous.value - run.value) > 1) continue;
    if (next && Math.abs(next.value - run.value) > 1) continue;

    banded += run.length;
  }

  return { banded, longest };
}

function analyseTile(frame: Frame, x0: number, y0: number): TileStats {
  let lumaSum = 0;
  let min = 255;
  let max = 0;
  let banded = 0;
  let samples = 0;
  let longest = 0;

  const row: number[] = new Array(TILE);

  for (let y = y0; y < y0 + TILE; y += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      for (let x = 0; x < TILE; x += 1) {
        const value = frame.data[(y * frame.width + x0 + x) * 4 + channel];
        row[x] = value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      const result = bandedPixelsInRow(row);
      banded += result.banded;
      if (result.longest > longest) longest = result.longest;
      samples += TILE;
    }

    for (let x = x0; x < x0 + TILE; x += 1) {
      const i = (y * frame.width + x) * 4;
      lumaSum += 0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2];
    }
  }

  return {
    x: x0,
    y: y0,
    meanLuma: lumaSum / (TILE * TILE),
    range: max - min,
    bandedFraction: banded / samples,
    longestRun: longest,
  };
}

/** Every full tile of the frame, left to right and top to bottom. */
function tiles(frame: Frame): TileStats[] {
  const out: TileStats[] = [];
  for (let y = 0; y + TILE <= frame.height; y += TILE) {
    for (let x = 0; x + TILE <= frame.width; x += TILE) out.push(analyseTile(frame, x, y));
  }
  return out;
}

async function captureFrames(page: Page): Promise<{ dithered: Frame; control: Frame }> {
  const grab = async (noise: number): Promise<Frame> => {
    const raw = await page.evaluate((scale) => {
      const capture = window.__singularityCapture;
      if (!capture) return null;
      const frame = capture(scale);
      if (!frame) return null;

      // A typed array does not survive the bridge. An array of three and a half
      // million numbers technically does, and takes the best part of a minute
      // to serialise; base64 of the same bytes takes a moment. Chunked because
      // String.fromCharCode blows the argument limit somewhere above 100k.
      let binary = "";
      for (let i = 0; i < frame.data.length; i += 0x8000) {
        binary += String.fromCharCode(...frame.data.subarray(i, i + 0x8000));
      }
      return { width: frame.width, height: frame.height, base64: btoa(binary) };
    }, noise);

    if (!raw) {
      throw new Error(
        "The page returned no frame. Either the post chain is off (this browser " +
          "may not render to half float) or the page was not loaded with ?debug.",
      );
    }
    return {
      width: raw.width,
      height: raw.height,
      data: new Uint8Array(Buffer.from(raw.base64, "base64")),
    };
  };

  return { dithered: await grab(1), control: await grab(0) };
}

interface SceneReport {
  readonly scene: string;
  /** Dark tiles with a gradient in them, before the control filter. */
  readonly candidates: number;
  readonly evaluated: number;
  readonly inconclusive: number;
  readonly failures: number;
  readonly worstBandedFraction: number;
  readonly worstLongestRun: number;
  readonly controlWorstBandedFraction: number;
  /**
   * The most any candidate tile bands in the undithered control, whether or not
   * it cleared the evidence bar.
   *
   * Reported separately from `controlWorstBandedFraction`, which only covers
   * tiles that DID clear it: if nothing clears the bar, that number is
   * vacuously zero and says nothing, while this one says how close the run came
   * and whether the bar is in the wrong place.
   */
  readonly controlCeiling: number;
  /**
   * Mean absolute difference between the rendered frame and the undithered
   * control, in 8-bit levels.
   *
   * Reported because it is the one number that catches the worst possible
   * failure of this whole check: a noise scale that does nothing, which would
   * make the control identical to the frame and every comparison below
   * vacuously true.
   */
  readonly meanNoiseLevels: number;
}

/** Mean absolute per-channel difference between two frames, in 8-bit levels. */
function meanDifference(a: Frame, b: Frame): number {
  let total = 0;
  let samples = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      total += Math.abs(a.data[i + channel] - b.data[i + channel]);
      samples += 1;
    }
  }
  return samples > 0 ? total / samples : 0;
}

function report(name: string, dithered: Frame, control: Frame): SceneReport {
  const ditheredTiles = tiles(dithered);
  const controlTiles = tiles(control);

  let candidates = 0;
  let evaluated = 0;
  let inconclusive = 0;
  let failures = 0;
  let worst = 0;
  let worstRun = 0;
  let controlWorst = 0;
  let controlCeiling = 0;

  for (let i = 0; i < ditheredTiles.length; i += 1) {
    const rendered = ditheredTiles[i];
    const reference = controlTiles[i];

    // Only dark tiles with an actual gradient in them are worth anything.
    if (rendered.meanLuma > DARK_LUMA_MAX) continue;
    if (reference.range < MIN_TILE_RANGE) continue;

    candidates += 1;
    controlCeiling = Math.max(controlCeiling, reference.bandedFraction);

    if (reference.bandedFraction < CONTROL_BANDED_FRACTION) {
      // The tile does not band even undithered, so it is not a test of the
      // dither. Counted and reported, never scored.
      inconclusive += 1;
      continue;
    }

    evaluated += 1;
    controlWorst = Math.max(controlWorst, reference.bandedFraction);
    worst = Math.max(worst, rendered.bandedFraction);
    worstRun = Math.max(worstRun, rendered.longestRun);
    if (rendered.bandedFraction > MAX_BANDED_FRACTION) failures += 1;
  }

  return {
    scene: name,
    candidates,
    evaluated,
    inconclusive,
    failures,
    worstBandedFraction: worst,
    worstLongestRun: worstRun,
    controlWorstBandedFraction: controlWorst,
    controlCeiling,
    meanNoiseLevels: meanDifference(dithered, control),
  };
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

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const reports = await withBrowser(async (browser) => {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();

    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(`console: ${message.text()}`);
    });

    const out: SceneReport[] = [];
    for (const scene of SCENES) {
      await page.goto(`${BASE_URL}/?debug&${scene.query}`, { waitUntil: "networkidle" });
      await page.waitForSelector("pre", { timeout: 120_000 });
      await page.waitForTimeout(1500);

      const { dithered, control } = await captureFrames(page);
      out.push(report(scene.name, dithered, control));
    }

    if (errors.length > 0) {
      console.error("PAGE ERRORS:");
      for (const line of errors) console.error(`  ${line}`);
    }
    return out;
  });

  let failed = false;
  for (const r of reports) {
    // Three ways to fail, and the last two matter as much as the first: a run
    // that finds no evidence, or one where the noise did nothing, has not
    // established that the dither works — it has only failed to look.
    const ok = r.failures === 0 && r.evaluated > 0 && r.meanNoiseLevels > 0.1;
    if (!ok) failed = true;
    console.log(
      [
        `${ok ? "PASS" : "FAIL"}  ${r.scene}`,
        `      ${r.candidates} dark gradient tile(s): ${r.evaluated} evaluated, ${r.inconclusive} inconclusive`,
        `      grain + dither move the frame by ${r.meanNoiseLevels.toFixed(2)} levels on average`,
        `      undithered control: up to ${(r.controlWorstBandedFraction * 100).toFixed(1)}% of a tile banded`,
        `      as rendered:        up to ${(r.worstBandedFraction * 100).toFixed(2)}% banded, longest plateau ${r.worstLongestRun}px`,
        r.evaluated === 0
          ? `      NO EVIDENCE: no tile banded even without the dither ` +
            `(worst candidate reached ${(r.controlCeiling * 100).toFixed(2)}%, ` +
            `bar is ${(CONTROL_BANDED_FRACTION * 100).toFixed(0)}%)`
          : "",
        r.meanNoiseLevels <= 0.1 ? "      NO EVIDENCE: the noise scale changed nothing" : "",
        r.failures > 0 ? `      ${r.failures} tile(s) over the ${(MAX_BANDED_FRACTION * 100).toFixed(0)}% ceiling` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  await writeFile(path.join(OUT_DIR, "banding.json"), `${JSON.stringify(reports, null, 2)}\n`);
  console.log(failed ? "\nBANDING CHECK FAILED." : "\nNo banding detected.");
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
