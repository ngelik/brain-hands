#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const appUrl = process.env.SOLAR_APP_URL ?? "http://127.0.0.1:5177/solar-system-browser/index.html";
const reportPath = resolve(repoRoot, "reports/solar-3d-browser-evidence.json");
const captures = [
  {
    name: "desktop",
    width: 1512,
    height: 738,
    mobile: false,
    expectedNetwork: [
      "/solar-system-browser/solar-system.js",
      "/solar-system-browser/styles.css",
      "/node_modules/three/build/three.module.js",
    ],
    screenshotPath: resolve(repoRoot, "reports/solar-3d-desktop.png"),
  },
  {
    name: "desktop-spacecraft-focus",
    width: 1512,
    height: 738,
    mobile: false,
    focusBodyId: "mro",
    expectedActive: "Mars Reconnaissance Orbiter",
    expectedNetwork: [
      "/solar-system-browser/solar-system.js",
      "/solar-system-browser/styles.css",
      "/node_modules/three/build/three.module.js",
    ],
    screenshotPath: resolve(repoRoot, "reports/solar-3d-spacecraft-focus.png"),
  },
  {
    name: "mobile",
    width: 390,
    height: 844,
    mobile: true,
    expectedNetwork: [
      "/solar-system-browser/solar-system.js",
      "/node_modules/three/build/three.module.js",
    ],
    screenshotPath: resolve(repoRoot, "reports/solar-3d-mobile.png"),
  },
];

class CdpSocket {
  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", resolveReady, { once: true });
      this.ws.addEventListener("error", rejectReady, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.id && this.pending.has(payload.id)) {
        const { resolveCommand, rejectCommand } = this.pending.get(payload.id);
        this.pending.delete(payload.id);
        if (payload.error) {
          rejectCommand(new Error(`${payload.error.message}: ${payload.error.data ?? ""}`));
        } else {
          resolveCommand(payload.result ?? {});
        }
        return;
      }
      if (payload.method) {
        this.events.push(payload);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    const command = { id, method, params };
    const result = new Promise((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
    });
    this.ws.send(JSON.stringify(command));
    return result;
  }

  close() {
    this.ws.close();
  }
}

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) {
      continue;
    }
    return candidate;
  }
  throw new Error("Could not find Chrome. Set CHROME_BIN to the installed Chrome executable.");
}

function waitForChrome(stderrBuffer) {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`Chrome did not expose a DevTools endpoint. stderr:\n${stderrBuffer.text}`));
    }, 15000);
    const poll = () => {
      const match = stderrBuffer.text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timeout);
        resolveReady(match[1]);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

async function waitForPage(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (page) {
      return page.webSocketDebuggerUrl;
    }
    await delay(100);
  }
  throw new Error("No debuggable page target found.");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function evaluateJson(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Runtime evaluation failed.");
  }
  return JSON.parse(result.result.value);
}

function consoleEntries(events) {
  return events
    .filter((event) => event.method === "Runtime.consoleAPICalled" || event.method === "Runtime.exceptionThrown" || event.method === "Log.entryAdded")
    .map((event) => {
      if (event.method === "Runtime.consoleAPICalled") {
        return {
          level: event.params.type,
          text: event.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "),
          url: event.params.stackTrace?.callFrames?.[0]?.url,
        };
      }
      if (event.method === "Runtime.exceptionThrown") {
        return {
          level: "error",
          text: event.params.exceptionDetails?.text ?? "Exception thrown",
          url: event.params.exceptionDetails?.url,
        };
      }
      return {
        level: event.params.entry.level,
        text: event.params.entry.text,
        url: event.params.entry.url,
      };
    })
    .filter((entry) => entry.text.trim().length > 0);
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function paeth(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodePng(buffer) {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Screenshot was not a PNG.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks = [];

  while (offset < buffer.length) {
    const length = readUInt32(buffer, offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      const interlace = data[12];
      if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
        throw new Error(`Unsupported PNG format: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
      }
    } else if (type === "IDAT") {
      chunks.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const channels = colorType === 6 ? 4 : 3;
  const bytesPerPixel = channels;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(chunks));
  const pixels = Buffer.alloc(height * stride);
  let sourceOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[sourceOffset];
    sourceOffset += 1;
    const rowOffset = y * stride;
    const previousRowOffset = rowOffset - stride;

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[sourceOffset + x];
      const left = x >= bytesPerPixel ? pixels[rowOffset + x - bytesPerPixel] : 0;
      const up = y > 0 ? pixels[previousRowOffset + x] : 0;
      const upperLeft = y > 0 && x >= bytesPerPixel ? pixels[previousRowOffset + x - bytesPerPixel] : 0;
      let value;
      if (filter === 0) {
        value = raw;
      } else if (filter === 1) {
        value = raw + left;
      } else if (filter === 2) {
        value = raw + up;
      } else if (filter === 3) {
        value = raw + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        value = raw + paeth(left, up, upperLeft);
      } else {
        throw new Error(`Unsupported PNG row filter: ${filter}`);
      }
      pixels[rowOffset + x] = value & 0xff;
    }
    sourceOffset += stride;
  }

  return { width, height, channels, pixels };
}

function screenshotPixelCheck(buffer, rect) {
  const png = decodePng(buffer);
  const sampleRect = {
    left: Math.max(0, Math.floor(rect?.left ?? 0)),
    top: Math.max(0, Math.floor(rect?.top ?? 0)),
    right: Math.min(png.width, Math.ceil(rect?.right ?? png.width)),
    bottom: Math.min(png.height, Math.ceil(rect?.bottom ?? png.height)),
  };
  const unique = new Set();
  let sampledPixels = 0;
  let nonDarkPixels = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const step = 4;

  for (let y = sampleRect.top; y < sampleRect.bottom; y += step) {
    for (let x = sampleRect.left; x < sampleRect.right; x += step) {
      const index = (y * png.width + x) * png.channels;
      const red = png.pixels[index];
      const green = png.pixels[index + 1];
      const blue = png.pixels[index + 2];
      r += red;
      g += green;
      b += blue;
      sampledPixels += 1;
      if (red + green + blue > 30) nonDarkPixels += 1;
      unique.add([red >> 3, green >> 3, blue >> 3].join(","));
    }
  }

  return {
    sampleRect,
    sampledPixels,
    nonDarkPixels,
    uniqueColors: unique.size,
    colorSamples: [...unique],
    averageRgb: [r, g, b].map((value) => Number((value / Math.max(sampledPixels, 1)).toFixed(2))),
  };
}

function clampRect(rect, maxWidth, maxHeight) {
  if (!rect || maxWidth === 0 || maxHeight === 0) {
    return null;
  }
  const clamped = {
    left: Math.max(0, Math.floor(rect.left)),
    top: Math.max(0, Math.floor(rect.top)),
    right: Math.min(maxWidth, Math.ceil(rect.right)),
    bottom: Math.min(maxHeight, Math.ceil(rect.bottom))
  };
  if (clamped.right <= clamped.left || clamped.bottom <= clamped.top) {
    return null;
  }
  return clamped;
}

function buildSceneSampleRects(layout) {
  const canvas = layout.rects?.canvas ?? {};
  const width = canvas.width ?? layout.innerWidth;
  const height = canvas.height ?? layout.innerHeight;
  const left = canvas.left ?? 0;
  const top = canvas.top ?? 0;
  const right = canvas.right ?? left + width;
  const bottom = canvas.bottom ?? top + height;

  if (width < 12 || height < 12) {
    return [];
  }

  const safeTop = Math.max(top, canvas.top ?? 0, layout.rects?.readout?.bottom ?? top, layout.rects?.controls?.bottom ?? top);
  const safeBottom = Math.min(bottom, layout.rects?.details?.top ?? bottom);
  const bandTop = Math.floor(top + height * 0.35);
  const bandBottom = Math.floor(top + height * 0.65);
  const safeBandTop = Math.max(safeTop + 4, Math.min(bandTop, safeBottom - 4));
  const safeBandBottom = Math.max(safeBandTop + 40, Math.min(bandBottom, safeBottom - 4));

  const regionTop = Math.max(0, safeBandTop);
  const regionBottom = Math.min(bottom, safeBandBottom);
  if (regionBottom <= regionTop) {
    return [];
  }

  const regionHeight = regionBottom - regionTop;
  const regionWidth = Math.max(1, Math.floor(width * 0.58));
  const sideBandWidth = Math.max(1, Math.floor(width * 0.28));
  const centerBandLeft = left + Math.floor((width - regionWidth) * 0.5);
  const sideMargin = Math.floor(width * 0.05);
  const sampleHeight = Math.max(60, Math.floor(regionHeight * 0.75));

  const candidates = [
    { left: centerBandLeft, top: regionTop, right: centerBandLeft + regionWidth, bottom: regionTop + sampleHeight },
    { left: left + sideMargin, top: regionTop, right: left + sideMargin + sideBandWidth, bottom: regionTop + sampleHeight },
    { left: right - sideMargin - sideBandWidth, top: regionTop, right: right - sideMargin, bottom: regionTop + sampleHeight }
  ].map((candidate) => clampRect(candidate, right, bottom));

  return candidates.filter((candidate) => candidate !== null);
}

function combineSceneChecks(checks) {
  const validChecks = checks.filter((check) => check.sampledPixels > 0);
  let sampledPixels = 0;
  let nonDarkPixels = 0;
  let uniqueColors = new Set();

  for (const check of validChecks) {
    sampledPixels += check.sampledPixels;
    nonDarkPixels += check.nonDarkPixels;
    for (const colorSample of check.colorSamples) {
      uniqueColors.add(colorSample);
    }
  }

  return {
    validRects: validChecks.length,
    sampledPixels,
    nonDarkPixels,
    uniqueColors: uniqueColors.size,
    checks: validChecks,
  };
}

async function capture(cdp, target) {
  cdp.events = [];
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: target.width,
    height: target.height,
    deviceScaleFactor: 1,
    mobile: target.mobile,
  });
  await cdp.send("Page.navigate", { url: appUrl });
  await delay(1800);
  if (target.focusBodyId) {
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector('.focus-button[data-body-id="${target.focusBodyId}"]')?.click()`,
      awaitPromise: true,
      returnByValue: true,
    });
    await delay(700);
  }

  const layout = await evaluateJson(
    cdp,
    `JSON.stringify((() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const bounds = element.getBoundingClientRect();
        return {
          left: Math.round(bounds.left),
          top: Math.round(bounds.top),
          right: Math.round(bounds.right),
          bottom: Math.round(bounds.bottom),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height)
        };
      };
      const canvas = document.querySelector("#spaceCanvas");
      const sampleCanvas = () => {
        if (!canvas) {
          return { sampledPixels: 0, nonDarkPixels: 0, uniqueColors: 0, colorSamples: [], averageRgb: [0, 0, 0] };
        }
        const probe = document.createElement("canvas");
        probe.width = 96;
        probe.height = 96;
        const context = probe.getContext("2d", { willReadFrequently: true });
        if (!context) {
          return { sampledPixels: 0, nonDarkPixels: 0, uniqueColors: 0, colorSamples: [], averageRgb: [0, 0, 0] };
        }
        context.drawImage(canvas, 0, 0, probe.width, probe.height);
        const pixels = context.getImageData(0, 0, probe.width, probe.height).data;
        const unique = new Set();
        let nonDarkPixels = 0;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          r += red;
          g += green;
          b += blue;
          if (red + green + blue > 30) nonDarkPixels += 1;
          if (index % 64 === 0) unique.add([red >> 3, green >> 3, blue >> 3].join(","));
        }
        const sampledPixels = pixels.length / 4;
        return {
          sampledPixels,
          nonDarkPixels,
          uniqueColors: unique.size,
          colorSamples: [...unique],
          averageRgb: [r, g, b].map((value) => Number((value / sampledPixels).toFixed(2)))
        };
      };
      const spacecraftIds = ["iss", "tiangong", "hubble", "voyager1", "voyager2", "newhorizons", "parker", "juno", "cassini", "rosetta", "mro"];
      const resources = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name.replace(location.origin, ""))
        .sort();
      const intersects = (first, second) => first && second && first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
      const readout = rect(".readout-bar");
      const controls = rect(".control-dock");
      const details = rect(".details-panel");
      return {
        innerWidth,
        innerHeight,
        mobileMedia: matchMedia("(max-width: 620px)").matches,
        overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        hasThreeModule: resources.includes("/node_modules/three/build/three.module.js"),
        title: document.title,
        focusButtonCount: document.querySelectorAll(".focus-button").length,
        spacecraftButtonCount: spacecraftIds.filter((id) => document.querySelector(\`.focus-button[data-body-id="\${id}"]\`)).length,
        activeFocus: document.querySelector("#focusedBodyName")?.textContent,
        timelineDate: document.querySelector("#timelineDate")?.textContent,
        webglRenderer: document.querySelector("#fallbackMessage")?.classList.contains("is-visible") ? "fallback" : "webgl",
        rects: {
          readout: rect(".readout-bar"),
          controls: rect(".control-dock"),
          details: rect(".details-panel"),
          canvas: rect("#spaceCanvas")
        },
        canvasPixelCheck: sampleCanvas(),
        panelOverlap: {
          readoutControls: intersects(readout, controls),
          readoutDetails: intersects(readout, details),
          controlsDetails: intersects(controls, details)
        },
        resources
      };
    })())`,
  );

  const screenshot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const screenshotBuffer = Buffer.from(screenshot.data, "base64");
  writeFileSync(target.screenshotPath, screenshotBuffer);

  const rawConsole = consoleEntries(cdp.events);
  const ignoredConsole = rawConsole.filter((entry) => entry.text.includes("GPU stall due to ReadPixels"));
  const logs = rawConsole.filter((entry) => !entry.text.includes("GPU stall due to ReadPixels"));
  const blockingConsole = logs.filter((entry) => ["error", "warning", "warn"].includes(entry.level));
  const sceneSampleRects = buildSceneSampleRects(layout);
  const sceneSampleChecks = sceneSampleRects.map((rect) => screenshotPixelCheck(screenshotBuffer, rect));
  const sceneViewportPixelCheck = combineSceneChecks(sceneSampleChecks);
  const expectedNetwork = target.expectedNetwork ?? [];
  const missingExpectedNetwork = expectedNetwork.filter((entry) => !layout.resources.includes(entry));
  return {
    name: target.name,
    viewport: {
      width: target.width,
      height: target.height,
      mobile: target.mobile,
      focusBodyId: target.focusBodyId,
    },
    screenshotPath: target.screenshotPath.replace(`${repoRoot}/`, ""),
    layout,
    console: logs,
    ignoredConsole,
    blockingConsole,
    expectedNetwork,
    missingExpectedNetwork,
    sceneSampleRects,
    sceneViewportPixelCheck,
    passed:
      layout.webglRenderer === "webgl" &&
      !layout.overflowX &&
      !layout.panelOverlap.readoutControls &&
      !layout.panelOverlap.readoutDetails &&
      !layout.panelOverlap.controlsDetails &&
      layout.hasThreeModule &&
      missingExpectedNetwork.length === 0 &&
      layout.focusButtonCount >= 20 &&
      layout.spacecraftButtonCount >= 10 &&
      (!target.expectedActive || layout.activeFocus === target.expectedActive) &&
      blockingConsole.length === 0 &&
      layout.canvasPixelCheck.sampledPixels > 1000 &&
      layout.canvasPixelCheck.nonDarkPixels > 100 &&
      layout.canvasPixelCheck.uniqueColors >= 8,
  };
}

async function main() {
  mkdirSync(resolve(repoRoot, "reports"), { recursive: true });
  const profileDir = `${tmpdir()}/solar-chrome-evidence-${Date.now()}`;
  mkdirSync(profileDir, { recursive: true });
  const stderrBuffer = { text: "" };
  const chrome = spawn(chromePath(), [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--hide-scrollbars",
    "about:blank",
  ]);
  chrome.stderr.on("data", (chunk) => {
    stderrBuffer.text += chunk.toString();
  });

  let page;
  try {
    const browserWs = await waitForChrome(stderrBuffer);
    const port = new URL(browserWs).port;
    const pageWs = await waitForPage(port);
    page = new CdpSocket(pageWs);
    await page.ready;
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");

    const results = [];
    for (const target of captures) {
      results.push(await capture(page, target));
    }

    const report = {
      generatedAt: new Date().toISOString(),
      appUrl,
      status: results.every((result) => result.passed) ? "pass" : "fail",
      captures: results,
    };
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.status}: wrote ${reportPath}`);
    if (report.status !== "pass") {
      process.exitCode = 1;
    }
  } finally {
    if (page) page.close();
    chrome.kill();
    rmSync(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
