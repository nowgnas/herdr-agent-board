// Pet species and growth stages for the Todo companion — original creatures
// grouped by element (not any existing franchise's characters), drawn as
// blocky pixel-art sprites.
//
// This file is the whole "design": main.js only calls buildSprite(stage,
// species). To change how pets look:
//   - add/edit a PETS entry: `color`/`accent`/`belly` set its palette,
//     `accessory` picks its head feature (see ACCESSORY_PAINTERS below —
//     "flame"/"fin"/"leaf"/"spark"/"horn"/"shard"), which is what makes each
//     element's silhouette actually different, not just its color.
//   - add/edit a STAGES entry to change growth pacing (`needs`), which
//     features turn on (eyes/accessory/belly/crown/sparkle) and how big the
//     sprite is (`radius`, `cellPx`).
//   - add a new accessory shape by writing a paint function and adding it
//     to ACCESSORY_PAINTERS.

export const PETS = [
  { id: "igni", name: "이그니", color: "#e8603c", accent: "#ff8a3d", belly: "#ffe4cf", accessory: "flame" },
  { id: "aqubi", name: "아쿠비", color: "#3b82c4", accent: "#8fd3ff", belly: "#eaf6ff", accessory: "fin" },
  { id: "lopl", name: "로플", color: "#4caf6d", accent: "#8de39a", belly: "#eafff0", accessory: "leaf" },
  { id: "volti", name: "볼티", color: "#e8c93c", accent: "#fff27a", belly: "#fffbe0", accessory: "spark" },
  { id: "gromd", name: "그로드", color: "#8a6a4e", accent: "#c9a876", belly: "#efe2cf", accessory: "horn" },
  { id: "frosty", name: "프로스티", color: "#a7d8e8", accent: "#eafcff", belly: "#ffffff", accessory: "shard" },
];

// `needs`: cumulative completed todos required to reach this stage.
// `key`: "egg" (unhatched) or "body" (the circular critter template).
// `radius`/`cellPx`: how big the body circle is and how big each pixel is
// drawn at — both grow with the stage so the sprite visibly gets bigger.
export const STAGES = [
  { name: "알", needs: 0, key: "egg", cellPx: 3 },
  { name: "부화", needs: 3, key: "hatch", radius: 3.1, eyes: true, cellPx: 3 },
  { name: "유년기", needs: 8, key: "body", radius: 3.7, eyes: true, cellPx: 4 },
  { name: "성장기", needs: 16, key: "body", radius: 4.1, eyes: true, accessory: true, aura: true, cellPx: 4 },
  { name: "성체", needs: 28, key: "body", radius: 4.5, eyes: true, accessory: true, belly: true, aura: true, cellPx: 5 },
  { name: "전설", needs: 45, key: "body", radius: 4.8, eyes: true, accessory: true, belly: true, crown: true, sparkle: true, aura: true, cellPx: 6 },
];

export function pickRandomPet() {
  return PETS[Math.floor(Math.random() * PETS.length)].id;
}
export function petById(id) {
  return PETS.find(p => p.id === id) ?? PETS[0];
}
export function stageForTotal(total) {
  let idx = 0;
  for (let i = 0; i < STAGES.length; i++) if (total >= STAGES[i].needs) idx = i;
  return idx;
}

// --- sprite drawing: a SIZE x SIZE grid of color strings (or null = empty) ---

const SIZE = 15, CX = 7, CY = 9;
const OUTLINE = "#20232b";
const EYE = "#14161b";
const CROWN = "#f3cf4d";
const SPARK = "#fdf6e3";

function emptyGrid() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(null)); }
function set(grid, r, c, color) { if (r >= 0 && r < SIZE && c >= 0 && c < SIZE) grid[r][c] = color; }

function paintEgg(grid, color) {
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const dr = (r - CY) / 4.4, dc = (c - CX) / 3.1;
    const d = dr * dr + dc * dc;
    if (d <= 1) set(grid, r, c, d > 0.72 ? OUTLINE : color);
  }
}
function paintCircle(grid, radius, color) {
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) {
    const dr = r - CY, dc = c - CX;
    const d = Math.sqrt(dr * dr + dc * dc);
    if (d <= radius) set(grid, r, c, d > radius - 1 ? OUTLINE : color);
  }
}
function paintEyes(grid) {
  set(grid, CY - 1, CX - 2, EYE);
  set(grid, CY - 1, CX + 2, EYE);
}
function paintBelly(grid, radius, color) {
  for (let r = CY; r <= CY + Math.floor(radius) - 1; r++) for (let c = CX - 1; c <= CX + 1; c++) {
    if (grid[r]?.[c] && grid[r][c] !== OUTLINE) set(grid, r, c, color);
  }
}
function paintCrown(grid, radius) {
  const top = Math.round(CY - radius);
  set(grid, top - 3, CX, CROWN);
  set(grid, top - 2, CX - 1, CROWN);
  set(grid, top - 2, CX, CROWN);
  set(grid, top - 2, CX + 1, CROWN);
}
function paintSparkle(grid) {
  for (const [r, c] of [[1, 2], [1, SIZE - 3], [SIZE - 2, 2], [SIZE - 2, SIZE - 3]]) set(grid, r, c, SPARK);
}

// Head/body features that make each element's silhouette distinct, not just
// its color. Each takes (grid, radius, accent) and paints onto the template.
const ACCESSORY_PAINTERS = {
  // fire: a flame tuft rising off the head
  flame(grid, radius, accent) {
    const top = Math.round(CY - radius);
    set(grid, top - 3, CX, accent);
    set(grid, top - 2, CX - 1, accent);
    set(grid, top - 2, CX, accent);
    set(grid, top - 2, CX + 1, accent);
    set(grid, top - 1, CX, accent);
  },
  // water: a small crest plus two side fins at shoulder height
  fin(grid, radius, accent) {
    const top = Math.round(CY - radius), side = Math.round(radius - 1.4);
    set(grid, top - 2, CX, accent);
    set(grid, top - 1, CX - 1, accent);
    set(grid, top - 1, CX + 1, accent);
    set(grid, CY, CX - side - 1, accent);
    set(grid, CY, CX + side + 1, accent);
  },
  // grass: a leaf sprouting from the head
  leaf(grid, radius, accent) {
    const top = Math.round(CY - radius);
    set(grid, top - 3, CX, accent);
    set(grid, top - 2, CX - 1, accent);
    set(grid, top - 2, CX, accent);
    set(grid, top - 2, CX + 1, accent);
    set(grid, top - 1, CX, "#2f7d3a");
  },
  // electric: two jagged spikes
  spark(grid, radius, accent) {
    const top = Math.round(CY - radius), side = Math.round(radius - 1.4);
    set(grid, top - 2, CX - side, accent);
    set(grid, top - 3, CX - side - 1, accent);
    set(grid, top - 2, CX + side, accent);
    set(grid, top - 3, CX + side + 1, accent);
  },
  // earth: a single stout center horn
  horn(grid, radius, accent) {
    const top = Math.round(CY - radius);
    set(grid, top - 1, CX, OUTLINE);
    set(grid, top - 2, CX, accent);
    set(grid, top - 3, CX, accent);
  },
  // ice: two crystal shards
  shard(grid, radius, accent) {
    const top = Math.round(CY - radius), side = Math.round(radius - 1.4);
    set(grid, top - 1, CX - side, accent);
    set(grid, top - 2, CX - side, accent);
    set(grid, top - 1, CX + side, accent);
    set(grid, top - 2, CX + side, accent);
  },
};

export function buildSprite(stage, species) {
  const grid = emptyGrid();
  if (stage.key === "egg") { paintEgg(grid, species.color); return grid; }
  paintCircle(grid, stage.radius, species.color);
  if (stage.eyes) paintEyes(grid);
  if (stage.accessory) ACCESSORY_PAINTERS[species.accessory]?.(grid, stage.radius, species.accent);
  if (stage.belly) paintBelly(grid, stage.radius, species.belly);
  if (stage.crown) paintCrown(grid, stage.radius);
  if (stage.sparkle) paintSparkle(grid);
  return grid;
}
