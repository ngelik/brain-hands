import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { inflateSync } from "node:zlib";
import { assertApprovedCommand, splitCommand } from "../core/command.js";
import {
  assertVerificationNamespaceAvailable,
  beginVerificationAttempt,
  recordVerificationAttemptArtifacts,
} from "../core/ledger.js";
import type {
  BrowserCheckSpec,
  BrowserEvidenceBundle,
  BrowserEvidenceReport,
  IssueSpec,
  VerificationIdentity,
} from "../core/types.js";
import { verificationIdentityDirectory } from "../core/types.js";
import { browserEvidenceBundleSchema } from "../core/schema.js";
import { currentExecutionAuthority, recordActiveExecutionChild, withCurrentExecutionEffect } from "../core/execution-context.js";
import { missingExpectedNetwork } from "./network-pattern.js";

export function assertBrowserProcessTreeSupport(platform = process.platform): void {
  if (platform === "win32" && currentExecutionAuthority()) {
    throw new Error("Approved browser execution is unsupported on Windows until Job Object process-tree proof is available");
  }
}

export interface BrowserPixelCheck {
  sampledPixels: number;
  nonBlankPixels: number;
  uniqueColors: number;
}

async function bindSpawnedBrowserChild(child: ChildProcess): Promise<void> {
  try {
    await recordActiveExecutionChild(child.pid ?? null);
  } catch (error) {
    await terminateBrowserChildTree(child);
    throw error;
  }
}

function signalBrowserChildTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through to the direct child as a last-resort termination attempt.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function browserProcessGroupIsLive(child: ChildProcess): boolean {
  if (process.platform === "win32" || child.pid === undefined) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateBrowserChildTree(child: ChildProcess): Promise<void> {
  signalBrowserChildTree(child);
  await Promise.race([
    child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "close"),
    new Promise<void>((resolveWait) => setTimeout(resolveWait, 500)),
  ]);
  if (browserProcessGroupIsLive(child)) signalBrowserChildTree(child, "SIGKILL");
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && browserProcessGroupIsLive(child)) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (browserProcessGroupIsLive(child)) throw new Error(`Browser process group ${child.pid ?? "unknown"} remains live after termination`);
}

export interface BrowserCheckCapture {
  observedSelectors: string[];
  observedNetwork: string[];
  consoleErrors: string[];
  screenshotArtifact: string;
  screenshotExists: boolean;
  horizontalOverflow: boolean;
  overlapFailures: string[];
  pixelCheck: BrowserPixelCheck;
}

export interface BrowserServerHandle {
  command: string;
  stop: () => Promise<void>;
}

export interface VerifyBrowserIssueInput {
  repoRoot: string;
  issue: IssueSpec;
  reportPath: string;
  /**
   * Root for evidence artifacts. Run-scoped identity verification derives its
   * final report and screenshot destinations from the attempt namespace.
   */
  artifactRoot?: string;
  runDir?: string;
  identity?: VerificationIdentity;
  /** Legacy input retained for read-only compatibility callers. */
  issueNumber?: number;
  attempt?: number;
  chromePath?: string;
}

export interface BrowserVerifyResult {
  status: BrowserEvidenceBundle["status"];
  reportPath: string;
  ledgerReportPath: string | null;
  bundle: BrowserEvidenceBundle;
}

export interface BrowserVerifierDependencies {
  now?: () => Date;
  startServer?: (command: string, repoRoot: string) => Promise<BrowserServerHandle>;
  captureCheck?: (
    check: BrowserCheckSpec,
    repoRoot: string,
    chromePath?: string,
    artifactRoot?: string,
  ) => Promise<BrowserCheckCapture>;
}

interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
}

interface CdpEvent {
  method?: string;
  params?: Record<string, unknown>;
}

class CdpSocket {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolveCommand: (value: Record<string, unknown>) => void;
      rejectCommand: (error: Error) => void;
    }
  >();

  public readonly events: CdpEvent[] = [];
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.ws.addEventListener("open", () => resolveReady(), { once: true });
      this.ws.addEventListener("error", () => rejectReady(new Error("Chrome WebSocket failed to open")), {
        once: true,
      });
    });
    this.ws.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: Record<string, unknown>;
        error?: { message?: string; data?: string };
      };

      if (payload.id !== undefined && this.pending.has(payload.id)) {
        const { resolveCommand, rejectCommand } = this.pending.get(payload.id)!;
        this.pending.delete(payload.id);
        if (payload.error) {
          rejectCommand(new Error(`${payload.error.message ?? "CDP error"}: ${payload.error.data ?? ""}`));
        } else {
          resolveCommand(payload.result ?? {});
        }
        return;
      }

      if (payload.method) {
        this.events.push({ method: payload.method, params: payload.params });
      }
    });
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;

    const result = new Promise<Record<string, unknown>>((resolveCommand, rejectCommand) => {
      this.pending.set(id, { resolveCommand, rejectCommand });
    });

    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }

  resetEvents(): void {
    this.events.length = 0;
  }

  close(): void {
    this.ws.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitForUrl(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { method: "GET" });
      await response.arrayBuffer();
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the local server is ready or the deadline expires.
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function isUrlReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "GET" });
    await response.arrayBuffer();
    return response.ok;
  } catch {
    return false;
  }
}

function resolveArtifactPath(repoRoot: string, artifactPath: string): string {
  if (isAbsolute(artifactPath)) {
    return artifactPath;
  }
  return join(repoRoot, artifactPath);
}

function resolveScopedArtifactPath(
  artifactRoot: string,
  artifactPath: string,
  label: string,
  allowAbsolute = false,
): string {
  if (!allowAbsolute && isAbsolute(artifactPath)) {
    throw new Error(`${label} must be a relative path inside the v2 run directory`);
  }

  const root = resolve(artifactRoot);
  const candidate = resolve(root, artifactPath);
  const relation = relative(root, candidate);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    return candidate;
  }

  throw new Error(`${label} must resolve inside the v2 run directory`);
}

function relativeArtifactPath(repoRoot: string, absolutePath: string): string {
  const normalizedRoot = resolve(repoRoot);
  const normalizedPath = resolve(absolutePath);
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function chromeExecutable(explicitPath?: string): string {
  const candidates = [
    explicitPath,
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate.includes("/") && !existsSync(candidate)) {
      continue;
    }
    return candidate;
  }

  throw new Error("Could not find Chrome. Set CHROME_BIN or pass --chrome.");
}

async function waitForChrome(stderrBuffer: { text: string }): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = stderrBuffer.text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) {
      return match[1];
    }
    await delay(50);
  }
  throw new Error(`Chrome did not expose a DevTools endpoint. stderr:\n${stderrBuffer.text}`);
}

async function waitForPage(port: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) {
      return page.webSocketDebuggerUrl;
    }
    await delay(100);
  }
  throw new Error("No debuggable page target found.");
}

function consoleEntries(events: CdpEvent[]): ConsoleEntry[] {
  return events
    .filter(
      (event) =>
        event.method === "Runtime.consoleAPICalled" ||
        event.method === "Runtime.exceptionThrown" ||
        event.method === "Log.entryAdded",
    )
    .map((event): ConsoleEntry | null => {
      const params = event.params ?? {};

      if (event.method === "Runtime.consoleAPICalled") {
        const args = Array.isArray(params.args) ? params.args as Array<Record<string, unknown>> : [];
        const stackTrace = params.stackTrace as { callFrames?: Array<{ url?: string }> } | undefined;
        return {
          level: typeof params.type === "string" ? params.type : "log",
          text: args.map((arg) => String(arg.value ?? arg.description ?? "")).join(" "),
          url: stackTrace?.callFrames?.[0]?.url,
        };
      }

      if (event.method === "Runtime.exceptionThrown") {
        const details = params.exceptionDetails as { text?: string; url?: string } | undefined;
        return {
          level: "error",
          text: details?.text ?? "Exception thrown",
          url: details?.url,
        };
      }

      const entry = params.entry as { level?: string; text?: string; url?: string } | undefined;
      return {
        level: entry?.level ?? "log",
        text: entry?.text ?? "",
        url: entry?.url,
      };
    })
    .filter((entry): entry is ConsoleEntry => entry !== null && entry.text.trim().length > 0);
}

function readUInt32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
  if (upDistance <= upperLeftDistance) return up;
  return upperLeft;
}

function decodePng(buffer: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
  const signature = "89504e470d0a1a0a";
  if (buffer.subarray(0, 8).toString("hex") !== signature) {
    throw new Error("Screenshot was not a PNG.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const chunks: Buffer[] = [];

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
      let value: number;
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

function screenshotPixelCheck(buffer: Buffer): BrowserPixelCheck {
  const png = decodePng(buffer);
  const unique = new Set<string>();
  let sampledPixels = 0;
  let nonBlankPixels = 0;
  const step = 6;

  for (let y = 0; y < png.height; y += step) {
    for (let x = 0; x < png.width; x += step) {
      const index = (y * png.width + x) * png.channels;
      const red = png.pixels[index];
      const green = png.pixels[index + 1];
      const blue = png.pixels[index + 2];
      sampledPixels += 1;
      if (red + green + blue > 30) {
        nonBlankPixels += 1;
      }
      unique.add([red >> 3, green >> 3, blue >> 3].join(","));
    }
  }

  return {
    sampledPixels,
    nonBlankPixels,
    uniqueColors: unique.size,
  };
}

function viewportForCheck(check: BrowserCheckSpec): { width: number; height: number; mobile: boolean } {
  if (check.viewport) {
    return {
      width: check.viewport.width,
      height: check.viewport.height,
      mobile: check.viewport.mobile ?? false,
    };
  }

  const marker = `${check.name} ${check.screenshot_artifact}`.toLowerCase();
  return marker.includes("mobile")
    ? { width: 390, height: 844, mobile: true }
    : { width: 1512, height: 738, mobile: false };
}

async function evaluateJson(cdp: CdpSocket, expression: string): Promise<Record<string, unknown>> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error("Runtime evaluation failed.");
  }

  const runtimeResult = result.result as { value?: string } | undefined;
  return JSON.parse(runtimeResult?.value ?? "{}") as Record<string, unknown>;
}

async function startLocalServer(command: string, repoRoot: string): Promise<BrowserServerHandle> {
  const { executable, args } = splitCommand(command);
  assertApprovedCommand([executable, ...args], repoRoot);
  const child = spawn(executable, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  await bindSpawnedBrowserChild(child);
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
  });

  await delay(200);
  if (child.exitCode !== null) {
    throw new Error(`Local server command exited early: ${command}\n${stderr.join("")}`);
  }

  return {
    command,
    stop: () => terminateBrowserChildTree(child),
  };
}

export function buildBrowserEvidenceReport(
  check: BrowserCheckSpec,
  capture: BrowserCheckCapture,
): BrowserEvidenceReport {
  const missingSelectors = check.required_selectors.filter(
    (selector) => !capture.observedSelectors.includes(selector),
  );
  const missingNetwork = missingExpectedNetwork(check.expected_network, capture.observedNetwork);
  const failureReasons = [
    ...missingSelectors.map((selector) => `missing selector: ${selector}`),
    ...missingNetwork.map((networkEntry) => `missing expected network: ${networkEntry}`),
  ];

  if (check.console_error_policy === "no_errors" && capture.consoleErrors.length > 0) {
    failureReasons.push(`console error policy violated: ${capture.consoleErrors.length} blocking console entries`);
  }

  if (!capture.screenshotExists) {
    failureReasons.push(`screenshot missing: ${check.screenshot_artifact}`);
  }

  if (check.require_no_horizontal_overflow && capture.horizontalOverflow) {
    failureReasons.push("horizontal overflow detected");
  }

  for (const overlapFailure of capture.overlapFailures) {
    failureReasons.push(`forbidden overlap: ${overlapFailure}`);
  }

  if (
    capture.pixelCheck.sampledPixels <= 0 ||
    capture.pixelCheck.nonBlankPixels <= 0 ||
    capture.pixelCheck.uniqueColors < 2
  ) {
    failureReasons.push("screenshot pixel check failed");
  }

  return {
    check_name: check.name,
    url: check.url,
    status: failureReasons.length === 0 ? "passed" : "failed",
    observed_selectors: capture.observedSelectors,
    missing_selectors: missingSelectors,
    console_errors: capture.consoleErrors,
    expected_network: check.expected_network,
    observed_network: capture.observedNetwork,
    screenshot_artifact: capture.screenshotArtifact,
    console_error_policy: check.console_error_policy,
    viewport: viewportForCheck(check),
    horizontal_overflow: capture.horizontalOverflow,
    overlap_failures: capture.overlapFailures,
    pixel_check: {
      sampled_pixels: capture.pixelCheck.sampledPixels,
      non_blank_pixels: capture.pixelCheck.nonBlankPixels,
      unique_colors: capture.pixelCheck.uniqueColors,
    },
    failure_reasons: failureReasons,
    skipped_reason: null,
  };
}

async function captureBrowserCheckUnsafe(
  check: BrowserCheckSpec,
  repoRoot: string,
  explicitChromePath?: string,
  artifactRoot = repoRoot,
): Promise<BrowserCheckCapture> {
  await waitForUrl(check.url);

  const viewport = viewportForCheck(check);
  const profileDir = join(tmpdir(), `brain-hands-chrome-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(profileDir, { recursive: true });
  const stderrBuffer = { text: "" };
  const chrome = spawn(chromeExecutable(explicitChromePath), [
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
  ], { detached: process.platform !== "win32" });
  await bindSpawnedBrowserChild(chrome);

  chrome.stderr.on("data", (chunk) => {
    stderrBuffer.text += chunk.toString();
  });

  let page: CdpSocket | null = null;
  try {
    const browserWs = await waitForChrome(stderrBuffer);
    const pageWs = await waitForPage(new URL(browserWs).port);
    page = new CdpSocket(pageWs);
    await page.send("Page.enable");
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    page.resetEvents();
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
    });
    await page.send("Page.navigate", { url: check.url });
    await delay(check.wait_ms ?? 1200);

    const layout = await evaluateJson(
      page,
      `JSON.stringify((() => {
        const selectors = ${JSON.stringify(check.required_selectors)};
        const forbiddenOverlaps = ${JSON.stringify(check.forbidden_overlaps ?? [])};
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
        const intersects = (first, second) => first && second && first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
        const normalizeResource = (value) => {
          try {
            const url = new URL(value);
            return url.pathname + url.search;
          } catch {
            return value;
          }
        };
        const resources = performance
          .getEntriesByType("resource")
          .map((entry) => normalizeResource(entry.name))
          .sort();
        const overlapFailures = forbiddenOverlaps
          .map(([firstSelector, secondSelector]) => {
            const first = rect(firstSelector);
            const second = rect(secondSelector);
            return intersects(first, second) ? firstSelector + " overlaps " + secondSelector : null;
          })
          .filter(Boolean);
        return {
          observedSelectors: selectors.filter((selector) => document.querySelector(selector)),
          observedNetwork: resources,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
          overlapFailures
        };
      })())`,
    );

    const screenshot = await page.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const screenshotData = (screenshot as { data?: unknown }).data;
    if (typeof screenshotData !== "string") {
      throw new Error("Chrome did not return screenshot data.");
    }

    const screenshotBuffer = Buffer.from(screenshotData, "base64");
    const screenshotPath = resolveArtifactPath(artifactRoot, check.screenshot_artifact);
    await mkdir(dirname(screenshotPath), { recursive: true });
    await writeFile(screenshotPath, screenshotBuffer);

    const logs = consoleEntries(page.events)
      .filter((entry) => !entry.text.includes("GPU stall due to ReadPixels"));
    const blockingConsole = logs
      .filter((entry) => ["error", "warning", "warn"].includes(entry.level))
      .map((entry) => `${entry.level}: ${entry.text}`);

    return {
      observedSelectors: Array.isArray(layout.observedSelectors)
        ? layout.observedSelectors.filter((entry): entry is string => typeof entry === "string")
        : [],
      observedNetwork: Array.isArray(layout.observedNetwork)
        ? layout.observedNetwork.filter((entry): entry is string => typeof entry === "string")
        : [],
      consoleErrors: blockingConsole,
      screenshotArtifact: relativeArtifactPath(artifactRoot, screenshotPath),
      screenshotExists: true,
      horizontalOverflow: layout.horizontalOverflow === true,
      overlapFailures: Array.isArray(layout.overlapFailures)
        ? layout.overlapFailures.filter((entry): entry is string => typeof entry === "string")
        : [],
      pixelCheck: screenshotPixelCheck(screenshotBuffer),
    };
  } finally {
    if (page) {
      page.close();
    }
    await terminateBrowserChildTree(chrome);
    await rm(profileDir, { recursive: true, force: true });
  }
}

export async function captureBrowserCheck(
  check: BrowserCheckSpec,
  repoRoot: string,
  explicitChromePath?: string,
  artifactRoot = repoRoot,
): Promise<BrowserCheckCapture> {
  assertBrowserProcessTreeSupport();
  return withCurrentExecutionEffect(`browser:capture:${check.name}`, () =>
    captureBrowserCheckUnsafe(check, repoRoot, explicitChromePath, artifactRoot));
}

export async function verifyBrowserIssue(
  input: VerifyBrowserIssueInput,
  dependencies: BrowserVerifierDependencies = {},
): Promise<BrowserVerifyResult> {
  assertBrowserProcessTreeSupport();
  const checks = input.issue.browser_checks ?? [];
  const now = dependencies.now ?? (() => new Date());
  const startServer = dependencies.startServer ?? startLocalServer;
  const captureCheck = dependencies.captureCheck ?? captureBrowserCheck;
  const artifactRoot = input.artifactRoot ?? input.runDir ?? input.repoRoot;
  const runScopedIdentity = input.runDir !== undefined && input.identity !== undefined;
  const identityDirectory = input.identity ? verificationIdentityDirectory(input.identity) : null;
  const reports: BrowserEvidenceReport[] = [];
  const groupedChecks = new Map<string, BrowserCheckSpec[]>();

  if (input.identity?.scope === "github" && input.issueNumber !== undefined && input.identity.issue_number !== input.issueNumber) {
    throw new Error("Browser verification issue number does not match its mapped identity");
  }
  if (input.identity && input.identity.scope !== "github" && input.issueNumber !== undefined) {
    throw new Error("Local and integrated browser verification cannot include a GitHub issue number");
  }
  if (input.runDir && !input.identity) {
    throw new Error("A verification identity is required when --run is provided");
  }
  const identity = input.identity;
  const attempt = input.attempt ?? 1;

  if (input.runDir && identity) {
    await assertVerificationNamespaceAvailable(input.runDir, identity, attempt, { allowInProgressAttempt: true });
    await beginVerificationAttempt(input.runDir, identity, attempt);
  }

  const scopedChecks = runScopedIdentity && input.runDir && identity && identityDirectory
    ? checks.map((check) => {
        const attemptRoot = join(input.runDir!, identityDirectory, `attempt-${attempt}`);
        resolveScopedArtifactPath(attemptRoot, check.screenshot_artifact, "Browser screenshot artifact");
        return {
          ...check,
          screenshot_artifact: `${identityDirectory}/attempt-${attempt}/${check.screenshot_artifact}`,
        };
      })
    : checks;
  const captureArtifactRoot = runScopedIdentity ? input.runDir! : artifactRoot;

  if (input.artifactRoot !== undefined && !runScopedIdentity && resolve(input.artifactRoot) !== resolve(input.repoRoot)) {
    for (const check of scopedChecks) {
      resolveScopedArtifactPath(artifactRoot, check.screenshot_artifact, "Browser screenshot artifact");
    }
  }

  for (const check of scopedChecks) {
    const group = groupedChecks.get(check.local_server_command) ?? [];
    group.push(check);
    groupedChecks.set(check.local_server_command, group);
  }

  for (const [command, group] of groupedChecks.entries()) {
    await withCurrentExecutionEffect(`browser:${command}`, async () => {
    const firstCheck = group[0];
    const parsed = splitCommand(command);
    // Validate even injected/custom server starters and the reachable-server
    // fast path; no browser command may bypass the frozen argv policy.
    assertApprovedCommand([parsed.executable, ...parsed.args], input.repoRoot);
    const server = dependencies.startServer === undefined && await isUrlReachable(firstCheck.url)
      ? { command, stop: async () => {} }
      : await startServer(command, input.repoRoot);

    try {
      if (dependencies.startServer === undefined) {
        await waitForUrl(firstCheck.url);
      }

      for (const check of group) {
        const capture = await captureCheck(check, input.repoRoot, input.chromePath, captureArtifactRoot);
        reports.push(buildBrowserEvidenceReport(check, {
          ...capture,
          screenshotArtifact: check.screenshot_artifact,
        }));
      }
    } finally {
      await server.stop();
    }
    });
  }

  const status: BrowserEvidenceBundle["status"] =
    reports.length === 0
      ? "skipped"
      : reports.every((report) => report.status === "passed")
        ? "passed"
        : "failed";
  const bundle = browserEvidenceBundleSchema.parse({
    generated_at: now().toISOString(),
    status,
    reports,
  });
  const reportRelativePath = runScopedIdentity && identityDirectory
    ? `${identityDirectory}/attempt-${attempt}/browser-evidence.json`
    : input.reportPath;
  const absoluteReportPath = runScopedIdentity
    ? resolveScopedArtifactPath(input.runDir!, reportRelativePath, "Browser evidence report")
    : input.artifactRoot !== undefined && resolve(input.artifactRoot) !== resolve(input.repoRoot)
      ? resolveScopedArtifactPath(artifactRoot, reportRelativePath, "Browser evidence report", true)
    : resolveArtifactPath(input.repoRoot, input.reportPath);

  await mkdir(dirname(absoluteReportPath), { recursive: true });
  await writeFile(absoluteReportPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

  const ledgerReportPath = runScopedIdentity && input.runDir && identity
    ? await recordVerificationAttemptArtifacts(
        input.runDir,
        identity,
        attempt,
        [reportRelativePath, ...reports.map((report) => report.screenshot_artifact)],
      ).then(() => absoluteReportPath)
    : null;

  return {
    status,
    reportPath: absoluteReportPath,
    ledgerReportPath,
    bundle,
  };
}
