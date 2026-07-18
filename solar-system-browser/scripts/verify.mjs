import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(".");
const requiredFiles = [
  "solar-system-browser/index.html",
  "solar-system-browser/favicon.svg",
  "solar-system-browser/styles.css",
  "solar-system-browser/solar-system.js",
  "solar-system-browser/README.md",
  "solar-system-browser/issues/3d-spacecraft-upgrade.json"
];
const browserReportPath = "reports/solar-3d-browser-report.json";
const browserEvidenceReportPath = "reports/solar-3d-browser-evidence.json";

const requiredSelectors = [
  "#spaceCanvas",
  "#focusButtons",
  "#timelineSlider",
  "#detailsPanel",
  "#modeLabel",
  "#zoomSlider"
];
const requiredNames = [
  "ISS",
  "Tiangong",
  "Hubble",
  "Voyager 1",
  "Voyager 2",
  "New Horizons",
  "Parker Solar Probe",
  "Juno",
  "Cassini",
  "Rosetta",
  "Mars Reconnaissance Orbiter",
  "Mercury",
  "Venus",
  "Earth",
  "Mars",
  "Jupiter",
  "Saturn",
  "Uranus",
  "Neptune",
  "Sun"
];
const localThreeImport = '"/node_modules/three/build/three.module.js"';

async function assertFile(path) {
  await access(path, constants.R_OK);
}

async function assertRequiredFile(path, label) {
  try {
    await assertFile(path);
  } catch (error) {
    throw new Error(`Missing required file for ${label}: ${path}`);
  }
}

function hasId(html, selector) {
  const id = selector.startsWith("#") ? selector.slice(1) : selector;
  return new RegExp(`id=["']${id}["']`, "i").test(html);
}

function includeMissing(content, requiredItems) {
  return requiredItems.filter((item) => !content.includes(item));
}

function assertNoRemoteAsset(content, label) {
  const remoteMatch = content.match(/https?:\/\/[^"'\s)]+/g);
  if (remoteMatch && remoteMatch.length > 0) {
    throw new Error(`${label} contains remote URL references: ${remoteMatch.join(", ")}`);
  }
}

function getIssueChecks(issuePayload) {
  if (!issuePayload || !Array.isArray(issuePayload.browser_checks)) {
    return [];
  }
  return issuePayload.browser_checks;
}

function collectExpectedNetwork(checks) {
  const network = new Set();
  for (const check of checks) {
    for (const expected of check.expected_network ?? []) {
      network.add(expected);
    }
  }
  return [...network];
}

function collectExpectedScreenshots(checks) {
  const shots = [];
  for (const check of checks) {
    if (typeof check.screenshot_artifact === "string") {
      shots.push(check.screenshot_artifact);
    }
  }
  return shots;
}

function normalizeEvidenceCaptures(browserEvidence) {
  if (Array.isArray(browserEvidence?.reports)) {
    return browserEvidence.reports.map((report) => ({
      name: report?.check_name,
      passed: report?.status === "passed",
      screenshotPath: report?.screenshot_artifact,
      missingExpectedNetwork: Array.isArray(report?.expected_network) && Array.isArray(report?.observed_network)
        ? report.expected_network.filter((entry) => !report.observed_network.includes(entry))
        : [],
      missingSelectors: Array.isArray(report?.missing_selectors) ? report.missing_selectors : [],
      consoleErrors: Array.isArray(report?.console_errors) ? report.console_errors : [],
      failureReasons: Array.isArray(report?.failure_reasons) ? report.failure_reasons : []
    }));
  }

  if (Array.isArray(browserEvidence?.captures)) {
    return browserEvidence.captures.map((capture) => ({
      name: capture?.name,
      passed: capture?.passed === true,
      screenshotPath: capture?.screenshotPath,
      missingExpectedNetwork: Array.isArray(capture?.missingExpectedNetwork) ? capture.missingExpectedNetwork : [],
      missingSelectors: [],
      consoleErrors: Array.isArray(capture?.blockingConsole) ? capture.blockingConsole : [],
      failureReasons: []
    }));
  }

  return [];
}

async function main() {
  for (const file of requiredFiles) {
    await assertRequiredFile(file, "workflow source");
  }
  await assertRequiredFile(browserEvidenceReportPath, "browser evidence");

  const [issueRaw, indexRaw, cssRaw, jsRaw, readmeRaw, browserEvidenceRaw] = await Promise.all([
    readFile(join(repoRoot, "solar-system-browser/issues/3d-spacecraft-upgrade.json"), "utf8"),
    readFile(join(repoRoot, "solar-system-browser/index.html"), "utf8"),
    readFile(join(repoRoot, "solar-system-browser/styles.css"), "utf8"),
    readFile(join(repoRoot, "solar-system-browser/solar-system.js"), "utf8"),
    readFile(join(repoRoot, "solar-system-browser/README.md"), "utf8"),
    readFile(join(repoRoot, browserEvidenceReportPath), "utf8")
  ]);

  const issue = JSON.parse(issueRaw);
  const browserEvidence = JSON.parse(browserEvidenceRaw);
  const browserChecks = getIssueChecks(issue);

  for (const selector of requiredSelectors) {
    if (!hasId(indexRaw, selector)) {
      throw new Error(`index.html is missing selector: ${selector}`);
    }
  }

  const browserSelectorFailures = [];
  for (const browserCheck of browserChecks) {
    const required = browserCheck.required_selectors ?? [];
    for (const selector of required) {
      if (!hasId(indexRaw, selector)) {
        browserSelectorFailures.push(selector);
      }
    }
  }

  assertNoRemoteAsset(indexRaw, "index.html");
  assertNoRemoteAsset(cssRaw, "styles.css");
  assertNoRemoteAsset(jsRaw, "solar-system.js");

  const expectedInReadme = ["python3 -m http.server 5177", "node solar-system-browser/scripts/verify.mjs"];
  const missingFromReadme = includeMissing(readmeRaw, expectedInReadme);
  if (missingFromReadme.length > 0) {
    throw new Error(`README.md is missing: ${missingFromReadme.join(", ")}`);
  }

  const missingNames = requiredNames.filter((name) => !jsRaw.includes(`"${name}"`) && !jsRaw.includes(`'${name}'`));
  if (missingNames.length > 0) {
    throw new Error(`solar-system.js missing required bodies: ${missingNames.join(", ")}`);
  }

  const missingThreeImport = !jsRaw.includes(localThreeImport);
  if (missingThreeImport) {
    throw new Error(`solar-system.js must import Three.js via ${localThreeImport}`);
  }

  const requiredFragments = [
    "new THREE.Scene",
    "new THREE.PerspectiveCamera",
    "new THREE.WebGLRenderer",
    "requestAnimationFrame",
    "requestRender(",
    "prefers-reduced-motion",
    "toggleSpacecraft",
    "toggleOrbitLines",
    "toggleTrails",
    "toggleLabels",
    "showLabels",
    "showTrails",
    "showOrbitLines",
    "showSpacecraft"
  ];
  const missingFragments = includeMissing(jsRaw, requiredFragments);
  if (missingFragments.length > 0) {
    throw new Error(`solar-system.js is missing implementation markers: ${missingFragments.join(", ")}`);
  }

  const checks = {
    requiredSelectorsPresent: browserSelectorFailures.length === 0,
    requiredBodyDefinitionsPresent: missingNames.length === 0,
    localThreeImport: !missingThreeImport,
    hasThreeScene: jsRaw.includes("new THREE.Scene"),
    hasThreeCamera: jsRaw.includes("new THREE.PerspectiveCamera"),
    hasThreeRenderer: jsRaw.includes("new THREE.WebGLRenderer"),
    hasReducedMotion: jsRaw.includes("prefers-reduced-motion"),
    hasOrbitVisibilityToggle: jsRaw.includes("toggleOrbitLines"),
    hasTrailVisibilityToggle: jsRaw.includes("toggleTrails"),
    hasLabelVisibilityToggle: jsRaw.includes("toggleLabels"),
    hasSpacecraftVisibilityToggle: jsRaw.includes("toggleSpacecraft"),
    hasZoomControl: indexRaw.includes("zoomSlider"),
    hasTimeControls: indexRaw.includes("timelineSlider") && indexRaw.includes("speedSlider"),
    remoteFree: true,
    issueMetadataPresent: Boolean(issue?.run_id)
  };

  const expectedEvidenceScreenshots = collectExpectedScreenshots(browserChecks);
  const normalizedEvidenceCaptures = normalizeEvidenceCaptures(browserEvidence);
  const evidenceCaptureScreenshots = normalizedEvidenceCaptures
    .map((capture) => capture?.screenshotPath)
    .filter((screenshotPath) => typeof screenshotPath === "string");
  const requiredEvidenceScreenshots = [...new Set([...expectedEvidenceScreenshots, ...evidenceCaptureScreenshots])];

  const missingEvidenceArtifacts = [];
  for (const screenshotPath of requiredEvidenceScreenshots) {
    const absolutePath = join(repoRoot, screenshotPath);
    try {
      await assertFile(absolutePath);
    } catch (error) {
      missingEvidenceArtifacts.push(screenshotPath);
    }
  }

  const evidenceCaptureFailures = normalizedEvidenceCaptures.filter((capture) => capture?.passed !== true);
  const browserEvidenceChecks = {
    evidenceReportValid: browserEvidence?.status === "pass" || browserEvidence?.status === "passed",
    evidenceCapturesPassed: evidenceCaptureFailures.length === 0 && normalizedEvidenceCaptures.length > 0,
    evidenceArtifactsPresent: missingEvidenceArtifacts.length === 0
  };

  const report = {
    task: "2026-07-08-brain-hands-solar-3d-task-4",
    run_id: issue.run_id,
    status: Object.values({ ...checks, ...browserEvidenceChecks }).every(Boolean) ? "passed" : "failed",
    executedAt: new Date().toISOString(),
    checks,
    evidenceChecks: browserEvidenceChecks,
    verificationMetadata: {
      expectedNetwork: collectExpectedNetwork(browserChecks),
      expectedScreenshots: collectExpectedScreenshots(browserChecks),
      requiredSelectors,
      issueSelectors: browserChecks.flatMap((check) => check.required_selectors ?? []),
      browserChecks
    },
    browserEvidencePath: browserEvidenceReportPath,
    evidenceCaptureFailures,
    missingEvidenceArtifacts,
    missingBodyDefs: missingNames,
    missingSelectors: browserSelectorFailures
  };

  await writeFile(join(repoRoot, browserReportPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");

  const allChecks = {
    ...checks,
    ...browserEvidenceChecks
  };
  if (!Object.values(allChecks).every(Boolean)) {
    const issues = [];
    for (const [key, value] of Object.entries(allChecks)) {
      if (!value) {
        issues.push(key);
      }
    }
    throw new Error(`Verification failed: ${issues.join(", ")}`);
  }

  console.log("verify: ok");
}

main().catch((error) => {
  console.error(`verify: failed\n${error.stack}`);
  process.exitCode = 1;
});
