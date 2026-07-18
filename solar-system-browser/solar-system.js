import * as THREE from "/node_modules/three/build/three.module.js";

const TAU = Math.PI * 2;
const MS_TO_DAYS = 1000 * 60 * 60 * 24;
const ORBIT_SCALE = 12;
const BASE_DATE = new Date("2026-07-08T12:00:00.000Z");
const SIM_SPEED_SCALE = 18;
const MAX_TRAIL_POINTS = 160;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

const PLANETS = [
  {
    id: "sun",
    name: "Sun",
    type: "Star",
    category: "planetary",
    color: 0xffcd66,
    radius: 3.2,
    orbitRadius: 0,
    periodDays: 0,
    summary: "Central star with strong light, heat, and gravity that anchors the system.",
    facts: [
      ["Type", "G-type star"],
      ["Mass", "1.989 × 10^30 kg"],
      ["Radius", "696,340 km"],
      ["Surface Temp", "5,778 K"]
    ]
  },
  {
    id: "mercury",
    name: "Mercury",
    type: "Planet",
    category: "planetary",
    color: 0xa9a6a2,
    radius: 0.38,
    orbitRadius: 2.9,
    periodDays: 88,
    tilt: 0.02,
    eccentricity: 0.06,
    summary: "The smallest planet with the fastest orbit in the inner system.",
    facts: [["Type", "Terrestrial"], ["Orbit Period", "88 days"], ["Moons", "0"], ["Orbit Radius", "57.9 million km"]]
  },
  {
    id: "venus",
    name: "Venus",
    type: "Planet",
    category: "planetary",
    color: 0xd4a652,
    radius: 0.95,
    orbitRadius: 5.4,
    periodDays: 225,
    tilt: 0.03,
    eccentricity: 0.007,
    summary: "Thick atmosphere gives Venus strong greenhouse warming and cloud cover.",
    facts: [["Type", "Terrestrial"], ["Orbit Period", "225 days"], ["Moons", "0"], ["Atmosphere", "CO₂ and clouds"]]
  },
  {
    id: "earth",
    name: "Earth",
    type: "Planet",
    category: "planetary",
    color: 0x4f9cff,
    radius: 1,
    orbitRadius: 8,
    periodDays: 365.25,
    tilt: 0.02,
    eccentricity: 0.016,
    summary: "Earth hosts liquid oceans, active climate, and a breathable atmosphere.",
    facts: [["Type", "Terrestrial"], ["Orbit Period", "365.25 days"], ["Moons", "1"], ["Length of Day", "23h 56m"]]
  },
  {
    id: "mars",
    name: "Mars",
    type: "Planet",
    category: "planetary",
    color: 0xb45e39,
    radius: 0.53,
    orbitRadius: 12.2,
    periodDays: 687,
    tilt: 0.01,
    eccentricity: 0.093,
    summary: "Mars is cold, dusty, and known for its large canyon systems.",
    facts: [["Type", "Terrestrial"], ["Orbit Period", "687 days"], ["Moons", "2"], ["Gravity", "0.38 g"]]
  },
  {
    id: "jupiter",
    name: "Jupiter",
    type: "Planet",
    category: "planetary",
    color: 0xcf9f72,
    radius: 2.8,
    orbitRadius: 40,
    periodDays: 4331,
    tilt: 0.008,
    eccentricity: 0.048,
    summary: "Jupiter is the largest planet and carries the strongest ringless storm systems.",
    facts: [["Type", "Gas giant"], ["Orbit Period", "11.86 years"], ["Moons", "95+"], ["Great Red Spot", "stable storm"]]
  },
  {
    id: "saturn",
    name: "Saturn",
    type: "Planet",
    category: "planetary",
    color: 0xd5be8e,
    radius: 2.4,
    orbitRadius: 72,
    periodDays: 10747,
    tilt: 0.004,
    eccentricity: 0.054,
    summary: "Saturn’s rings are broad and reflective in sunlight.",
    facts: [["Type", "Gas giant"], ["Orbit Period", "29.45 years"], ["Moons", "140+"], ["Special Feature", "Ring system"]]
  },
  {
    id: "uranus",
    name: "Uranus",
    type: "Planet",
    category: "planetary",
    color: 0x9ed6de,
    radius: 2,
    orbitRadius: 110,
    periodDays: 30589,
    tilt: 0.06,
    eccentricity: 0.047,
    summary: "Uranus is an ice giant with a pronounced axial tilt.",
    facts: [["Type", "Ice giant"], ["Orbit Period", "84 years"], ["Moons", "27"], ["Axial Tilt", "~98°"]]
  },
  {
    id: "neptune",
    name: "Neptune",
    type: "Planet",
    category: "planetary",
    color: 0x2e64d7,
    radius: 1.95,
    orbitRadius: 145,
    periodDays: 59800,
    tilt: 0.03,
    eccentricity: 0.009,
    summary: "Neptune carries strong winds and a deep blue visual tone in this scene.",
    facts: [["Type", "Ice giant"], ["Orbit Period", "164.8 years"], ["Moons", "14"], ["Color", "deep blue"]]
  }
];

const SPACECRAFT = [
  {
    id: "iss",
    name: "ISS",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xcce5ff,
    radius: 0.11,
    anchorId: "earth",
    localRadius: 1.0,
    localHeight: 0.55,
    periodDays: 0.93,
    summary: "International Space Station orbiting Earth in low Earth orbit.",
    facts: [["Type", "Space station"], ["Operation", "Human-occupied"], ["Altitude", "400 km (simplified)"], ["Crew", "6 (nominal)"]]
  },
  {
    id: "tiangong",
    name: "Tiangong",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xe6bcff,
    radius: 0.1,
    anchorId: "earth",
    localRadius: 1.2,
    localHeight: 0.45,
    periodDays: 0.75,
    summary: "Chinese modular station concept used for long-duration missions.",
    facts: [["Type", "Space station"], ["Orbit", "Earth"], ["Category", "Crewed outpost"], ["Program", "Tiangong"]]
  },
  {
    id: "hubble",
    name: "Hubble",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xf0d17f,
    radius: 0.085,
    anchorId: "earth",
    localRadius: 1.4,
    localHeight: 0.35,
    periodDays: 0.2,
    summary: "Hubble-style scientific observatory in Earth orbit.",
    facts: [["Type", "Telescope"], ["Target", "Near-Earth orbit"], ["Wavelength", "Visible/UV/IR"], ["Program", "Space telescope"]]
  },
  {
    id: "voyager1",
    name: "Voyager 1",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xe3f1ff,
    radius: 0.11,
    orbitType: "sun",
    orbitRadius: 340,
    periodDays: 6500,
    summary: "Outer-system probe continuing past giant planets in this simplified path.",
    facts: [["Type", "Interplanetary probe"], ["Status", "Interstellar mission"], ["Era", "1970s launch"], ["Primary Target", "Outer boundary"]]
  },
  {
    id: "voyager2",
    name: "Voyager 2",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xa7d0ff,
    radius: 0.1,
    orbitType: "sun",
    orbitRadius: 365,
    periodDays: 6100,
    summary: "Interplanetary probe with a long heliocentric trajectory.",
    facts: [["Type", "Interplanetary probe"], ["Status", "Deep-space mission"], ["Era", "1977 launch"], ["Primary Target", "Heliopause"]]
  },
  {
    id: "newhorizons",
    name: "New Horizons",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xc5f5ff,
    radius: 0.09,
    orbitType: "sun",
    orbitRadius: 300,
    periodDays: 2300,
    summary: "A fast outer solar-system flyby mission represented as a heliocentric arc.",
    facts: [["Type", "Flyby mission"], ["Destination", "Outer solar system"], ["Era", "2006 launch"], ["Design", "Outer path probe"]]
  },
  {
    id: "parker",
    name: "Parker Solar Probe",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xffba88,
    radius: 0.07,
    orbitType: "sun",
    orbitRadius: 9,
    periodDays: 22,
    summary: "Mission with a low perihelion path dipping deep into the Sun’s atmosphere.",
    facts: [["Type", "Solar probe"], ["Perihelion", "Very close to Sun"], ["Heat load", "Extreme"], ["Path", "Tightly elliptical"]]
  },
  {
    id: "juno",
    name: "Juno",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xd8e8ff,
    radius: 0.08,
    anchorId: "jupiter",
    localRadius: 5.7,
    localHeight: 0.35,
    periodDays: 3.9,
    summary: "Polar mission modelled as a fast low-Jupiter orbit in this scene.",
    facts: [["Type", "Jupiter orbiter"], ["Mission", "Polar observations"], ["Orbit", "Elongated"], ["Focus", "Gravity/poles"]]
  },
  {
    id: "cassini",
    name: "Cassini",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xffdf90,
    radius: 0.085,
    anchorId: "saturn",
    localRadius: 5.8,
    localHeight: 0.25,
    periodDays: 3.1,
    summary: "Saturn orbiter represented by a compact ring-aligned path around Saturn.",
    facts: [["Type", "Saturn orbiter"], ["Mission", "Saturn system"], ["Legacy", "Rings and moons"], ["Orbit", "Inner system"]]
  },
  {
    id: "rosetta",
    name: "Rosetta",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xffc7dd,
    radius: 0.08,
    orbitType: "sun",
    orbitRadius: 80,
    periodDays: 1200,
    summary: "Comet mission represented with a broad heliocentric transfer.",
    facts: [["Type", "Comet mission"], ["Target", "Comet path"], ["Era", "2004 launch"], ["Path", "Heliocentric"]]
  },
  {
    id: "mro",
    name: "Mars Reconnaissance Orbiter",
    type: "Spacecraft",
    category: "spacecraft",
    color: 0xcdfff6,
    radius: 0.09,
    anchorId: "mars",
    localRadius: 1.3,
    localHeight: 0.2,
    periodDays: 1.7,
    summary: "Mars mapping platform represented as a recurring near-Mars path.",
    facts: [["Type", "Mars mapper"], ["Primary Target", "Mars"], ["Orbit", "Low/near orbit"], ["Mission", "Reconnaissance"]]
  }
];

const scene = new THREE.Scene();
const labelLayer = document.getElementById("labelLayer");
const timelineDate = document.getElementById("timelineDate");
const focusButtons = document.getElementById("focusButtons");
const modeLabel = document.getElementById("modeLabel");
const detailsPanel = document.getElementById("detailsPanel");
const factsGrid = document.getElementById("factsGrid");
const focusedBodyName = document.getElementById("focusedBodyName");
const detailName = document.getElementById("detailName");
const detailSummary = document.getElementById("detailSummary");
const detailType = document.getElementById("detailType");
const fallbackMessage = document.getElementById("fallbackMessage");

const canvas = document.getElementById("spaceCanvas");
const playPauseButton = document.getElementById("playPauseButton");
const resetTimeButton = document.getElementById("resetTimeButton");
const speedSlider = document.getElementById("speedSlider");
const speedValue = document.getElementById("speedValue");
const timelineSlider = document.getElementById("timelineSlider");
const timelineHint = document.getElementById("timelineHint");
const zoomSlider = document.getElementById("zoomSlider");
const zoomValue = document.getElementById("zoomValue");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const cameraResetButton = document.getElementById("cameraResetButton");
const toggleOrbitLines = document.getElementById("toggleOrbitLines");
const toggleTrails = document.getElementById("toggleTrails");
const toggleLabels = document.getElementById("toggleLabels");
const toggleSpacecraft = document.getElementById("toggleSpacecraft");

const state = {
  speed: 1,
  timeDays: 0,
  showOrbitLines: true,
  showTrails: true,
  showLabels: true,
  showSpacecraft: true,
  isPlaying: !reducedMotionQuery.matches,
  prefersReducedMotion: reducedMotionQuery.matches,
  focusedBodyId: "earth",
  selectedBodyId: "earth",
  cameraRadius: 75,
  theta: Math.PI * 1.08,
  phi: Math.PI / 2.45,
  lastFrameAt: null,
  activeRenderLoop: null,
  needsRedraw: true
};

let renderer = null;

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 2500);
const sceneLighting = new THREE.Group();
scene.add(sceneLighting);

const ambientLight = new THREE.AmbientLight(0x1b2c47, 0.72);
const sunLight = new THREE.PointLight(0xffe8a0, 2.2, 0, 1.5);
sceneLighting.add(ambientLight, sunLight);

const sunGlow = new THREE.PointLight(0xffe7a4, 1.7, 0, 2);
sceneLighting.add(sunGlow);

const bodyGroup = new THREE.Group();
scene.add(bodyGroup);
const labels = new Map();
const celestialBodies = new Map();
const simulationState = new Map();

const reducedMotionLabel = reducedMotionQuery.matches ? "Reduced motion" : "Live";
modeLabel.textContent = `Simulation ${reducedMotionLabel}`;

const allBodies = [...PLANETS, ...SPACECRAFT];
const orbitingPlanets = PLANETS.filter((body) => body.id !== "sun");
const bodyById = new Map(allBodies.map((body) => [body.id, body]));

const starField = createStarfield();
scene.add(starField);

function buildBodyRegistry() {
  for (const body of allBodies) {
    if (body.id === "sun") {
      const sunCoreMaterial = new THREE.MeshBasicMaterial({ color: 0xffd173 });
      const sunCore = new THREE.Mesh(new THREE.SphereGeometry(body.radius * 2, 64, 64), sunCoreMaterial);
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(body.radius * 3.45, 32, 32),
        new THREE.MeshBasicMaterial({
          color: 0xffd173,
          transparent: true,
          opacity: 0.18,
          side: THREE.BackSide
        })
      );
      const parent = new THREE.Group();
      parent.add(sunCore);
      parent.add(glow);
      parent.userData.body = body;
      bodyGroup.add(parent);
      celestialBodies.set(body.id, { mesh: parent, body });
    } else {
      const material = new THREE.MeshStandardMaterial({
        color: body.color,
        roughness: 0.72,
        metalness: 0.12,
        emissive: 0x000000,
        emissiveIntensity: 0.05
      });
      const geometry = new THREE.SphereGeometry(body.radius, 32, 32);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.userData.body = body;
      if (body.category === "spacecraft") {
        mesh.visible = state.showSpacecraft;
      }

      const bodyEntry = {
        mesh,
        body,
        label: makeLabel(body),
        trailPoints: [],
        trailLine: null,
        orbitLine: null
      };

      if (body.category === "planetary" && body.id !== "sun") {
        const orbitLine = makeOrbitLine(body);
        bodyEntry.orbitLine = orbitLine;
        orbitLine.visible = state.showOrbitLines;
        bodyGroup.add(orbitLine);
      }

      const trailGeo = new THREE.BufferGeometry();
      const trailPosition = new THREE.BufferAttribute(new Float32Array(MAX_TRAIL_POINTS * 3), 3).setUsage(THREE.DynamicDrawUsage);
      trailGeo.setAttribute("position", trailPosition);
      trailGeo.setDrawRange(0, 0);
      const trailMat = new THREE.LineBasicMaterial({
        color: body.color,
        transparent: true,
        opacity: 0.4
      });
      bodyEntry.trailLine = new THREE.Line(trailGeo, trailMat);
      bodyEntry.trailLine.visible = state.showTrails && body.id !== "sun";
      bodyEntry.trailLine.userData.maxTrailPoints = MAX_TRAIL_POINTS;
      bodyGroup.add(bodyEntry.trailLine);
      bodyGroup.add(mesh);
      celestialBodies.set(body.id, bodyEntry);
    }

  }
}

function makeOrbitLine(body) {
  const segments = 128;
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const progress = (index / segments) * TAU;
    const radius = body.orbitRadius * ORBIT_SCALE;
    const x = Math.cos(progress) * radius;
    const z = Math.sin(progress) * radius;
    const y = Math.sin(progress * 2 + body.tilt) * radius * 0.07;
    points.push(new THREE.Vector3(x, y, z));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: 0x7fa8cf,
    transparent: true,
    opacity: 0.35
  });
  return new THREE.LineLoop(geometry, material);
}

function makeLabel(body) {
  const label = document.createElement("p");
  label.className = "scene-label";
  label.style.setProperty("--label-color", body.color ? `#${body.color.toString(16).padStart(6, "0")}` : "#ffffff");
  label.textContent = body.name;
  label.setAttribute("aria-label", `${body.name} label`);
  labels.set(body.id, label);
  labelLayer.appendChild(label);
  return label;
}

function createStarfield() {
  const count = 2500;
  const geometry = new THREE.BufferGeometry();
  const position = new Float32Array(count * 3);
  const size = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const radius = 1200;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random() * 2 - 1);
    const r = Math.cbrt(Math.random()) * radius;
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    const base = index * 3;
    position[base] = x;
    position[base + 1] = y;
    position[base + 2] = z;
    size[index] = Math.random() * 1.6 + 0.2;
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(size, 1));
  const material = new THREE.PointsMaterial({ color: 0xd6e6ff, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.8 });
  const points = new THREE.Points(geometry, material);
  return points;
}

function buildFocusButtons() {
  const fragment = document.createDocumentFragment();

  for (const body of allBodies) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "focus-button";
    button.dataset.bodyId = body.id;
    button.textContent = body.name;
    button.setAttribute("aria-pressed", "false");

    button.addEventListener("click", () => {
      selectBody(body.id);
      requestRender();
    });
    fragment.append(button);
  }

  focusButtons.appendChild(fragment);
}

function bindEvents() {
  window.addEventListener("resize", resizeAndSync);
  reducedMotionQuery.addEventListener("change", handleReducedMotionChange);

  playPauseButton.addEventListener("click", () => {
    if (state.prefersReducedMotion) {
      return;
    }
    state.isPlaying = !state.isPlaying;
    syncControls();
    requestRender();
  });

  resetTimeButton.addEventListener("click", () => {
    state.timeDays = 0;
    state.isPlaying = false;
    syncControls();
    requestRender();
  });

  cameraResetButton.addEventListener("click", () => {
    state.theta = Math.PI * 1.05;
    state.phi = Math.PI / 2.45;
    state.cameraRadius = 75;
    requestRender();
    syncControls();
  });

  speedSlider.addEventListener("input", (event) => {
    state.speed = Number(event.target.value);
    syncControls();
    requestRender();
  });

  timelineSlider.addEventListener("input", (event) => {
    state.timeDays = Number(event.target.value);
    state.isPlaying = false;
    syncControls();
    requestRender();
  });

  zoomSlider.addEventListener("input", (event) => {
    state.cameraRadius = Number(event.target.value);
    requestRender();
    syncControls();
  });

  zoomInButton.addEventListener("click", () => {
    state.cameraRadius = Math.max(24, state.cameraRadius - 10);
    requestRender();
    syncControls();
  });

  zoomOutButton.addEventListener("click", () => {
    state.cameraRadius = Math.min(210, state.cameraRadius + 10);
    requestRender();
    syncControls();
  });

  toggleOrbitLines.addEventListener("change", (event) => {
    state.showOrbitLines = event.target.checked;
    updateVisibility();
    requestRender();
  });
  toggleTrails.addEventListener("change", (event) => {
    state.showTrails = event.target.checked;
    updateVisibility();
    requestRender();
  });
  toggleLabels.addEventListener("change", (event) => {
    state.showLabels = event.target.checked;
    requestRender();
  });
  toggleSpacecraft.addEventListener("change", (event) => {
    state.showSpacecraft = event.target.checked;
    updateVisibility();
    requestRender();
  });

  canvas.addEventListener("pointerdown", startPointerDrag);
  canvas.addEventListener("wheel", handleWheelZoom, { passive: false });
}

let dragging = false;
let dragStart = { x: 0, y: 0 };
let dragReference = {
  theta: 0,
  phi: 0
};

function handleWheelZoom(event) {
  event.preventDefault();
  const direction = event.deltaY > 0 ? 1 : -1;
  const newRadius = Math.max(24, Math.min(210, state.cameraRadius + direction * 9));
  state.cameraRadius = newRadius;
  syncControls();
  requestRender();
}

function startPointerDrag(event) {
  dragging = true;
  dragStart = { x: event.clientX, y: event.clientY };
  dragReference = {
    theta: state.theta,
    phi: state.phi
  };
  window.addEventListener("pointermove", dragCamera);
  window.addEventListener("pointerup", stopPointerDrag);
  window.addEventListener("pointercancel", stopPointerDrag);
}

function dragCamera(event) {
  if (!dragging) {
    return;
  }
  const dx = event.clientX - dragStart.x;
  const dy = event.clientY - dragStart.y;
  state.theta = dragReference.theta - dx * 0.004;
  state.phi = Math.min(Math.PI - 0.1, Math.max(0.1, dragReference.phi + dy * 0.004));
  requestRender();
}

function stopPointerDrag() {
  dragging = false;
  window.removeEventListener("pointermove", dragCamera);
  window.removeEventListener("pointerup", stopPointerDrag);
  window.removeEventListener("pointercancel", stopPointerDrag);
}

function handleReducedMotionChange(event) {
  state.prefersReducedMotion = event.matches;
  if (event.matches) {
    state.isPlaying = false;
    playPauseButton.disabled = true;
    playPauseButton.textContent = "Reduced Motion";
    playPauseButton.setAttribute("aria-label", "Play disabled while reduced motion is enabled");
  } else {
    playPauseButton.disabled = false;
    playPauseButton.removeAttribute("aria-label");
    syncControls();
  }
  syncControls();
  requestRender();
}

function selectBody(bodyId) {
  state.focusedBodyId = bodyId;
  state.selectedBodyId = bodyId;

  const selected = bodyById.get(bodyId);
  if (!selected) {
    return;
  }

  for (const button of focusButtons.querySelectorAll(".focus-button")) {
    const active = button.dataset.bodyId === bodyId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }

  focusedBodyName.textContent = selected.name;
  detailName.textContent = selected.name;
  detailSummary.textContent = selected.summary;
  detailType.textContent = `${selected.type} · ${selected.category === "spacecraft" ? "spacecraft focus" : "planetary body"}`;
  factsGrid.innerHTML = "";
  for (const [key, value] of selected.facts) {
    const pair = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    pair.append(dt, dd);
    factsGrid.append(pair);
  }

  requestRender();
}

function getBodyPosition(body, timeDays, positions) {
  if (body.id === "sun") {
    return new THREE.Vector3(0, 0, 0);
  }

  if (body.category === "planetary") {
    const progress = (timeDays / Math.max(1, body.periodDays)) * TAU;
    const radius = body.orbitRadius * ORBIT_SCALE;
    const orbitWobble = Math.sin(progress * 0.5 + body.eccentricity) * 0.2;
    const x = Math.cos(progress + body.eccentricity) * radius;
    const z = Math.sin(progress + body.eccentricity) * (radius * (1 - body.eccentricity) + orbitWobble);
    const y = Math.sin(progress * 2 + body.id.length) * radius * body.tilt;
    return new THREE.Vector3(x, y, z);
  }

  if (body.orbitType === "sun") {
    const progress = (timeDays / Math.max(1, body.periodDays)) * TAU;
    const radius = body.orbitRadius * 1;
    const x = Math.cos(progress) * radius;
    const z = Math.sin(progress) * radius;
    const y = Math.sin(progress * 0.5) * 4;
    return new THREE.Vector3(x, y, z);
  }

  const anchor = positions.get(body.anchorId);
  if (!anchor) {
    return new THREE.Vector3(0, 0, 0);
  }
  const progress = (timeDays / Math.max(1, body.periodDays)) * TAU;
  const localX = Math.cos(progress) * body.localRadius * ORBIT_SCALE * 0.28;
  const localZ = Math.sin(progress) * body.localRadius * ORBIT_SCALE * 0.28;
  const localY = Math.sin(progress * 2 + body.id.length) * body.localHeight;
  return new THREE.Vector3(anchor.x + localX, anchor.y + localY, anchor.z + localZ);
}

function updateSimulation(timeDays) {
  const positions = new Map();
  for (const planet of orbitingPlanets) {
    positions.set(planet.id, getBodyPosition(planet, timeDays, positions));
  }
  positions.set("sun", new THREE.Vector3(0, 0, 0));

  for (const craft of SPACECRAFT) {
    positions.set(craft.id, getBodyPosition(craft, timeDays, positions));
  }

  simulationState.clear();
  for (const [id, point] of positions.entries()) {
    simulationState.set(id, point);
  }
}

function updateBodies() {
  for (const [id, entry] of celestialBodies.entries()) {
    const body = bodyById.get(id);
    if (!body) {
      continue;
    }
    const point = simulationState.get(id);
    if (!point) {
      continue;
    }

    if (entry.mesh) {
      entry.mesh.position.copy(point);
      if (body.id !== "sun") {
        entry.mesh.visible = state.showSpacecraft || body.category === "planetary";
      }
    }

    if (entry.trailLine) {
      if (state.showTrails && (body.category === "planetary" || state.showSpacecraft)) {
        const history = entry.trailPoints;
        history.push(point.clone());
        if (history.length > MAX_TRAIL_POINTS) {
          history.shift();
        }
        if (history.length < 2) {
          clearTrailGeometry(entry.trailLine);
          entry.trailLine.visible = false;
        } else {
          updateTrailGeometry(entry.trailLine, history);
          entry.trailLine.visible = true;
        }
      } else {
        entry.trailLine.visible = false;
        entry.trailPoints.length = 0;
        clearTrailGeometry(entry.trailLine);
      }
    }

    if (entry.label) {
      const isFocused = id === state.focusedBodyId;
      entry.label.classList.toggle("is-active", isFocused);
      const hideCraftLabel = body.category === "spacecraft" && !state.showSpacecraft;
      entry.label.style.display = state.showLabels && !hideCraftLabel ? "block" : "none";
      positionBodyLabel(entry.label, point);
    }
  }
}

function positionBodyLabel(label, point) {
  if (!label) {
    return;
  }

  const projected = point.clone().project(camera);
  if (projected.z > 1 || projected.z < -1) {
    label.style.display = "none";
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = (projected.x * 0.5 + 0.5) * rect.width;
  const y = (-projected.y * 0.5 + 0.5) * rect.height;
  const { width, height } = label.getBoundingClientRect();
  const clampedX = rect.width > width
    ? Math.max(width / 2, Math.min(x, rect.width - width / 2))
    : 0;
  const clampedY = rect.height > height
    ? Math.max(height / 2, Math.min(y, rect.height - height / 2))
    : 0;
  label.style.display = "block";
  label.style.left = `${clampedX}px`;
  label.style.top = `${clampedY}px`;
}

function updateCamera() {
  const target = simulationState.get(state.focusedBodyId) ?? new THREE.Vector3(0, 0, 0);
  const spherical = new THREE.Spherical();
  spherical.radius = state.cameraRadius;
  spherical.theta = state.theta;
  spherical.phi = state.phi;
  const offset = new THREE.Vector3().setFromSpherical(spherical);
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
}

function updateVisibility() {
  for (const [, entry] of celestialBodies.entries()) {
    const body = bodyById.get(entry.mesh?.userData?.body?.id ?? entry.body?.id);
    if (!body) {
      continue;
    }
    if (entry.orbitLine) {
      entry.orbitLine.visible = state.showOrbitLines;
    }
    if (entry.trailLine) {
      entry.trailLine.visible = state.showTrails && (body.category === "planetary" || state.showSpacecraft);
    }
    if (entry.mesh) {
      entry.mesh.visible = body.category === "planetary" ? true : state.showSpacecraft;
    }
    if (entry.label) {
      const body = bodyById.get(entry.mesh?.userData?.body?.id ?? entry.body?.id);
      const hideCraftLabel = body?.category === "spacecraft" && !state.showSpacecraft;
      entry.label.style.display = state.showLabels && !hideCraftLabel ? "" : "none";
    }
  }
}

function clampTimeline(value) {
  const min = Number(timelineSlider.min);
  const max = Number(timelineSlider.max);
  return Math.max(min, Math.min(max, value));
}

function syncControls() {
  speedSlider.value = String(state.speed);
  speedValue.textContent = `${state.speed.toFixed(2)}x`;
  timelineSlider.value = String(Math.round(state.timeDays));
  timelineHint.textContent = state.isPlaying ? "drag to scrub" : "timeline is paused";
  zoomSlider.value = String(Math.round(state.cameraRadius));
  zoomValue.textContent = `${Math.round(state.cameraRadius)}%`;
  playPauseButton.textContent = state.isPlaying ? "Pause" : "Play";
  playPauseButton.setAttribute("aria-pressed", String(state.isPlaying));
  toggleOrbitLines.checked = state.showOrbitLines;
  toggleTrails.checked = state.showTrails;
  toggleLabels.checked = state.showLabels;
  toggleSpacecraft.checked = state.showSpacecraft;

  const dateText = new Date(BASE_DATE.getTime() + state.timeDays * MS_TO_DAYS);
  const timestamp = dateText.toISOString().replace("T", " ").slice(0, 16);
  timelineDate.textContent = `${timestamp} UTC`;
  modeLabel.textContent = state.prefersReducedMotion
    ? "Simulation Reduced Motion"
    : state.isPlaying
      ? "Simulation Running"
      : "Simulation Paused";

  if (state.prefersReducedMotion) {
    playPauseButton.disabled = true;
    playPauseButton.textContent = "Reduced Motion";
    playPauseButton.setAttribute("aria-label", "Play disabled while reduced motion is enabled");
    timelineHint.textContent = "reduced motion mode";
  } else {
    playPauseButton.disabled = false;
    playPauseButton.removeAttribute("aria-label");
  }
}

function updateScene() {
  const clamped = clampTimeline(state.timeDays);
  if (clamped !== state.timeDays) {
    state.timeDays = clamped;
  }

  updateSimulation(clamped);
  updateBodies();

  sunLight.position.set(0, 0, 0);
  sunGlow.position.set(0, 0, 0);
  updateCamera();
  renderer.render(scene, camera);
  syncControls();
}

function requestRender() {
  state.needsRedraw = true;
  if (state.activeRenderLoop !== null) {
    return;
  }
  state.activeRenderLoop = requestAnimationFrame((timestamp) => {
    state.activeRenderLoop = null;
    const now = timestamp;
    if (state.lastFrameAt === null) {
      state.lastFrameAt = now;
    }

    const delta = (now - state.lastFrameAt) / 1000;
    state.lastFrameAt = now;

    if (state.isPlaying) {
      state.timeDays += delta * state.speed * SIM_SPEED_SCALE;
    } else {
      state.lastFrameAt = now;
    }

    updateScene();

    if (state.isPlaying) {
      state.activeRenderLoop = requestAnimationFrame(() => {
        state.activeRenderLoop = null;
        requestRender();
      });
    } else {
      state.needsRedraw = false;
    }
  });
}

function draw() {
  requestRender();
}

function resizeAndSync() {
  if (!renderer) {
    return;
  }
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  syncControls();
  requestRender();
}

function updateTrailGeometry(trailLine, history) {
  const pointCount = history.length;
  const positionAttribute = trailLine.geometry?.getAttribute("position");
  if (!positionAttribute) {
    return;
  }
  const maxPointCount = Math.min(trailLine.userData.maxTrailPoints ?? MAX_TRAIL_POINTS, MAX_TRAIL_POINTS);
  const drawCount = Math.min(pointCount, maxPointCount);
  if (drawCount <= 0) {
    clearTrailGeometry(trailLine);
    return;
  }

  const positions = positionAttribute.array;
  for (let index = 0; index < drawCount; index += 1) {
    const point = history[index];
    const baseIndex = index * 3;
    positions[baseIndex] = point.x;
    positions[baseIndex + 1] = point.y;
    positions[baseIndex + 2] = point.z;
  }
  positionAttribute.needsUpdate = true;
  trailLine.geometry.setDrawRange(0, drawCount);
}

function clearTrailGeometry(trailLine) {
  const positionAttribute = trailLine.geometry?.getAttribute("position");
  if (!positionAttribute) {
    return;
  }
  trailLine.geometry.setDrawRange(0, 0);
  positionAttribute.needsUpdate = true;
}

function createRenderer() {
  const contextOptions = { preserveDrawingBuffer: true };
  const webGlContext = canvas.getContext("webgl2", contextOptions) || canvas.getContext("webgl", contextOptions);
  if (!webGlContext) {
    applyWebGLFallbackState();
    return null;
  }

  const next = new THREE.WebGLRenderer({
    antialias: true,
    canvas,
    context: webGlContext,
    preserveDrawingBuffer: true,
  });
  next.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  next.setSize(canvas.clientWidth, canvas.clientHeight, false);
  return next;
}

function applyWebGLFallbackState() {
  fallbackMessage.textContent = "WebGL is unavailable in this environment. This app requires WebGL to render the 3D scene.";
  fallbackMessage.classList.add("is-visible");
  playPauseButton.disabled = true;
  timelineSlider.disabled = true;
  speedSlider.disabled = true;
  zoomSlider.disabled = true;
  detailsPanel.setAttribute("aria-hidden", "true");
}

function checkLoop() {
  if (!renderer) {
    return;
  }

  if (!state.prefersReducedMotion && state.isPlaying) {
    requestRender();
  } else {
    updateScene();
  }
}

renderer = createRenderer();
if (!renderer) {
  throw new Error("WebGL context unavailable.");
}

buildBodyRegistry();
buildFocusButtons();
bindEvents();
selectBody("earth");
syncControls();
resizeAndSync();
draw();
checkLoop();
