const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;

class EmptyBase {}
class TFile {}
class TFolder {}

Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") {
    return {
      ItemView: EmptyBase,
      Menu: EmptyBase,
      Modal: EmptyBase,
      Notice: EmptyBase,
      Plugin: EmptyBase,
      PluginSettingTab: EmptyBase,
      Setting: EmptyBase,
      TFile,
      TFolder,
      normalizePath: (value) => value.replace(/\\/g, "/").replace(/\/+/g, "/"),
      setIcon: () => undefined,
    };
  }

  return originalLoad(request, parent, isMain);
};

const PluginClass = require("../main.js");
const {
  buildPhysicalLayoutPlan,
  buildVisibleRows,
  computeOrderAt,
  parsePageMetadata,
  sanitizeFileName,
  wouldCreateCycle,
} = PluginClass.__test;

assert.equal(sanitizeFileName('  North: \\ / * ? " < > |  '), "North");
assert.equal(sanitizeFileName("..."), "Untitled");

assert.equal(computeOrderAt([], 0), 1024);
assert.equal(computeOrderAt([{ order: 1024 }], 1), 2048);
assert.equal(computeOrderAt([{ order: 1024 }], 0), 0);
assert.equal(computeOrderAt([{ order: 1024 }, { order: 2048 }], 1), 1536);

const cycleNodes = new Map([
  ["a", { id: "a", parentId: null }],
  ["b", { id: "b", parentId: "a" }],
  ["c", { id: "c", parentId: "b" }],
]);
assert.equal(wouldCreateCycle(cycleNodes, "a", "c"), true);
assert.equal(wouldCreateCycle(cycleNodes, "c", null), false);

const file = { path: "Page Tree/North.md", basename: "North" };
const parsed = parsePageMetadata(file, {
  "page-tree": true,
  "page-tree-id": "north",
  "page-tree-parent": "world",
  "page-tree-order": "2048",
  title: "Northern Kingdom",
});
assert.equal(parsed.id, "north");
assert.equal(parsed.parentId, "world");
assert.equal(parsed.order, 2048);
assert.equal(parsed.title, "Northern Kingdom");

const nodes = new Map([
  ["world", { id: "world", parentId: null, order: 1024, title: "World", file: { path: "World.md" } }],
  ["north", { id: "north", parentId: "world", order: 1024, title: "North", file: { path: "North.md" } }],
  ["city", { id: "city", parentId: "north", order: 1024, title: "City", file: { path: "City.md" } }],
]);
const children = new Map([
  [null, [nodes.get("world")]],
  ["world", [nodes.get("north")]],
  ["north", [nodes.get("city")]],
]);
const rows = buildVisibleRows(nodes, children, new Set(["world", "north"]), "city");
assert.deepEqual(rows.map((row) => [row.id, row.depth]), [
  ["world", 0],
  ["north", 1],
  ["city", 2],
]);

const collapsedRows = buildVisibleRows(nodes, children, new Set(), "");
assert.deepEqual(
  collapsedRows.map((row) => [row.id, row.depth, row.invalid]),
  [["world", 0, false]],
);

const physicalNodes = new Map([
  ["home", { id: "home", parentId: null, order: 1024, title: "主页1", file: { path: "old/主页1.md" } }],
  ["leaf", { id: "leaf", parentId: "home", order: 1024, title: "子页面1", file: { path: "old/子页面1.md" } }],
  ["branch", { id: "branch", parentId: "home", order: 2048, title: "子页面2", file: { path: "old/子页面2.md" } }],
  ["grand", { id: "grand", parentId: "branch", order: 1024, title: "孙页面", file: { path: "old/孙页面.md" } }],
  ["other", { id: "other", parentId: null, order: 2048, title: "其他", file: { path: "old/其他.md" } }],
]);
const physicalChildren = new Map([
  [null, [physicalNodes.get("home"), physicalNodes.get("other")]],
  ["home", [physicalNodes.get("leaf"), physicalNodes.get("branch")]],
  ["branch", [physicalNodes.get("grand")]],
]);
const physicalPlan = buildPhysicalLayoutPlan(physicalNodes, physicalChildren, "main");
assert.equal(physicalPlan.get("home").filePath, "main/主页1/主页1.md");
assert.equal(physicalPlan.get("leaf").filePath, "main/主页1/子页面1.md");
assert.equal(physicalPlan.get("branch").filePath, "main/主页1/子页面2/子页面2.md");
assert.equal(physicalPlan.get("grand").filePath, "main/主页1/子页面2/孙页面.md");
assert.equal(physicalPlan.get("other").filePath, "main/其他.md");

const collisionNodes = new Map([
  ["first", { id: "first", parentId: null, order: 1024, title: "同名", file: { path: "old/a.md" } }],
  ["second", { id: "second", parentId: null, order: 2048, title: "同名", file: { path: "old/b.md" } }],
]);
const collisionChildren = new Map([[null, [...collisionNodes.values()]]]);
const collisionPlan = buildPhysicalLayoutPlan(
  collisionNodes,
  collisionChildren,
  "main",
  new Set(["main/同名.md"]),
);
assert.equal(collisionPlan.get("first").filePath, "main/同名 2.md");
assert.equal(collisionPlan.get("second").filePath, "main/同名 3.md");

console.log("core tests passed");
