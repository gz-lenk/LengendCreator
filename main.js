const {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  setIcon,
} = require("obsidian");

const VIEW_TYPE = "nested-page-tree-view";
const META_MARKER = "page-tree";
const META_ID = "page-tree-id";
const META_PARENT = "page-tree-parent";
const META_ORDER = "page-tree-order";
const META_TITLE = "title";
const ORDER_STEP = 1024;
const MIN_ORDER_GAP = 0.000001;

const DEFAULT_SETTINGS = {
  managedFolder: "main",
  syncFileNames: true,
  openOnStartup: true,
  hideManagedProperties: true,
  storageLayoutVersion: 2,
  expandedIds: [],
};

function textValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

function normalizeParentId(value) {
  const parentId = textValue(value);
  return parentId || null;
}

function parsePageMetadata(file, frontmatter) {
  if (!frontmatter || typeof frontmatter !== "object") return null;

  const id = textValue(frontmatter[META_ID]);
  const isMarked = frontmatter[META_MARKER] === true || frontmatter[META_MARKER] === "true";
  if (!isMarked && !id) return null;
  if (!id) return null;

  const parsedOrder = Number(frontmatter[META_ORDER]);
  return {
    id,
    parentId: normalizeParentId(frontmatter[META_PARENT]),
    order: Number.isFinite(parsedOrder) ? parsedOrder : 0,
    title: textValue(frontmatter[META_TITLE]) || file.basename,
    file,
  };
}

function compareNodes(left, right) {
  if (left.order !== right.order) return left.order - right.order;
  const titleResult = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
  if (titleResult !== 0) return titleResult;
  return left.file.path.localeCompare(right.file.path);
}

function sanitizeFileName(value) {
  let sanitized = textValue(value)
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/[\[\]#^]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "")
    .trim();

  if (!sanitized) sanitized = "Untitled";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) {
    sanitized = `${sanitized}-page`;
  }

  return sanitized.slice(0, 100).replace(/[. ]+$/g, "") || "Untitled";
}

function createPageId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function wouldCreateCycle(nodesById, nodeId, candidateParentId) {
  if (!candidateParentId) return false;
  if (nodeId === candidateParentId) return true;

  const visited = new Set();
  let cursor = candidateParentId;
  while (cursor) {
    if (cursor === nodeId) return true;
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = nodesById.get(cursor)?.parentId || null;
  }

  return false;
}

function computeOrderAt(siblings, requestedIndex) {
  const index = Math.max(0, Math.min(requestedIndex, siblings.length));
  const previous = index > 0 ? siblings[index - 1].order : null;
  const next = index < siblings.length ? siblings[index].order : null;

  if (previous === null && next === null) return ORDER_STEP;
  if (previous === null) return next - ORDER_STEP;
  if (next === null) return previous + ORDER_STEP;
  if (next - previous <= MIN_ORDER_GAP) return null;
  return previous + (next - previous) / 2;
}

function buildVisibleRows(nodesById, childrenByParentId, expandedIds, query) {
  const normalizedQuery = textValue(query).toLocaleLowerCase();
  let allowedIds = null;

  if (normalizedQuery) {
    allowedIds = new Set();
    for (const node of nodesById.values()) {
      const haystack = `${node.title}\n${node.file.path}`.toLocaleLowerCase();
      if (!haystack.includes(normalizedQuery)) continue;

      let cursor = node;
      const ancestorGuard = new Set();
      while (cursor && !ancestorGuard.has(cursor.id)) {
        ancestorGuard.add(cursor.id);
        allowedIds.add(cursor.id);
        cursor = cursor.parentId ? nodesById.get(cursor.parentId) : null;
      }
    }
  }

  const rootNodes = [];
  for (const node of nodesById.values()) {
    const hasValidParent = node.parentId && node.parentId !== node.id && nodesById.has(node.parentId);
    if (!hasValidParent) rootNodes.push(node);
  }
  rootNodes.sort(compareNodes);

  const rows = [];
  const visited = new Set();
  const structurallyReachable = new Set();

  // Expansion only controls visibility. Walk the complete structure separately
  // so descendants of a collapsed page are not mistaken for rootless cycles.
  const structuralStack = [...rootNodes];
  while (structuralStack.length > 0) {
    const node = structuralStack.pop();
    if (structurallyReachable.has(node.id)) continue;
    structurallyReachable.add(node.id);
    const children = childrenByParentId.get(node.id) || [];
    for (const child of children) structuralStack.push(child);
  }

  const visitFrom = (rootNode, rootInvalid) => {
    const stack = [{ node: rootNode, depth: 0, invalid: rootInvalid }];
    while (stack.length > 0) {
      const current = stack.pop();
      const node = current.node;
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      if (allowedIds && !allowedIds.has(node.id)) continue;
      rows.push({ id: node.id, depth: current.depth, invalid: current.invalid });

      const shouldExpand = normalizedQuery || expandedIds.has(node.id);
      if (!shouldExpand) continue;

      const children = childrenByParentId.get(node.id) || [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (allowedIds && !allowedIds.has(child.id)) continue;
        stack.push({ node: child, depth: current.depth + 1, invalid: false });
      }
    }
  };

  for (const root of rootNodes) {
    const invalid = Boolean(root.parentId);
    visitFrom(root, invalid);
  }

  // Cycles have no natural root. Keep every affected file visible as a root entry.
  const unvisited = [...nodesById.values()]
    .filter((node) => !structurallyReachable.has(node.id))
    .sort(compareNodes);
  for (const node of unvisited) {
    if (!visited.has(node.id)) visitFrom(node, true);
  }

  return rows;
}

function buildPhysicalLayoutPlan(
  nodesById,
  childrenByParentId,
  rootPath,
  blockedFilePaths = new Set(),
  blockedFolderPaths = new Set(),
) {
  const normalizedRoot = normalizePath(rootPath);
  const planById = new Map();
  const visited = new Set();
  const usedNamesByDirectory = new Map();

  const allocateName = (node, parentDirectory, hasChildren) => {
    const directoryKey = parentDirectory.toLocaleLowerCase();
    const usedNames = usedNamesByDirectory.get(directoryKey) || new Set();
    usedNamesByDirectory.set(directoryKey, usedNames);
    const baseName = sanitizeFileName(node.title);
    let suffix = 1;

    while (true) {
      const candidate = suffix === 1 ? baseName : `${baseName} ${suffix}`;
      const loweredCandidate = candidate.toLocaleLowerCase();
      const directoryPath = normalizePath(`${parentDirectory}/${candidate}`);
      const filePath = hasChildren
        ? normalizePath(`${directoryPath}/${candidate}.md`)
        : normalizePath(`${parentDirectory}/${candidate}.md`);
      const fileBlocked = blockedFilePaths.has(filePath.toLocaleLowerCase());
      const fileIsFolder = blockedFolderPaths.has(filePath.toLocaleLowerCase());
      const directoryIsFile = hasChildren && blockedFilePaths.has(directoryPath.toLocaleLowerCase());

      if (!usedNames.has(loweredCandidate) && !fileBlocked && !fileIsFolder && !directoryIsFile) {
        usedNames.add(loweredCandidate);
        return { storageName: candidate, directoryPath: hasChildren ? directoryPath : null, filePath };
      }
      suffix += 1;
    }
  };

  const queue = [];
  const enqueueGroup = (nodes, parentDirectory) => {
    for (const node of [...nodes].sort(compareNodes)) {
      if (visited.has(node.id)) continue;
      const hasChildren = (childrenByParentId.get(node.id) || []).some((child) => child.id !== node.id);
      const planned = allocateName(node, parentDirectory, hasChildren);
      visited.add(node.id);
      planById.set(node.id, { id: node.id, ...planned });
      queue.push(node);
    }
  };

  const processQueue = () => {
    for (let index = 0; index < queue.length; index += 1) {
      const node = queue[index];
      const plan = planById.get(node.id);
      const children = childrenByParentId.get(node.id) || [];
      if (children.length > 0 && plan.directoryPath) enqueueGroup(children, plan.directoryPath);
    }
  };

  const roots = [...nodesById.values()].filter(
    (node) => !node.parentId || node.parentId === node.id || !nodesById.has(node.parentId),
  );
  enqueueGroup(roots, normalizedRoot);
  processQueue();

  // A cycle has no natural root. Give each still-unvisited component a stable
  // physical root while leaving the logical validation warning intact.
  const residual = [...nodesById.values()].filter((node) => !visited.has(node.id)).sort(compareNodes);
  for (const node of residual) {
    if (visited.has(node.id)) continue;
    enqueueGroup([node], normalizedRoot);
    processQueue();
  }

  return planById;
}

class PageRepository {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.nodesById = new Map();
    this.idByPath = new Map();
    this.childrenByParentId = new Map();
    this.listeners = new Set();
    this.isReconcilingPhysical = false;
    this.physicalSyncChain = Promise.resolve();
    this.physicalSyncTimer = null;
    this.ready = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit() {
    for (const listener of this.listeners) listener();
  }

  async initialize() {
    await this.ensureManagedFolder();
    await this.rebuild();
    await this.syncPhysicalTree();
    this.ready = true;
    this.emit();
  }

  async ensureManagedFolder() {
    const folderPath = normalizePath(textValue(this.plugin.settings.managedFolder) || DEFAULT_SETTINGS.managedFolder);
    await this.ensureFolderPath(folderPath);
  }

  async ensureFolderPath(folderPath) {
    const parts = folderPath.split("/").filter(Boolean);
    let currentPath = "";

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (!existing) {
        await this.app.vault.createFolder(currentPath);
      } else if (!(existing instanceof TFolder)) {
        throw new Error(`受控目录路径被文件占用：${currentPath}`);
      }
    }
  }

  requestPhysicalSync() {
    if (this.isReconcilingPhysical) return;
    if (this.physicalSyncTimer !== null) window.clearTimeout(this.physicalSyncTimer);
    this.physicalSyncTimer = window.setTimeout(() => {
      this.physicalSyncTimer = null;
      void this.plugin.runAction(() => this.syncPhysicalTree());
    }, 150);
  }

  dispose() {
    if (this.physicalSyncTimer !== null) {
      window.clearTimeout(this.physicalSyncTimer);
      this.physicalSyncTimer = null;
    }
  }

  async syncPhysicalTree() {
    const operation = this.physicalSyncChain
      .catch(() => undefined)
      .then(() => this.performPhysicalSync());
    this.physicalSyncChain = operation;
    return operation;
  }

  getBlockedLayoutPaths() {
    const managedPaths = new Set([...this.nodesById.values()].map((node) => node.file.path.toLocaleLowerCase()));
    const blockedFilePaths = new Set();
    const blockedFolderPaths = new Set();

    for (const abstractFile of this.app.vault.getAllLoadedFiles()) {
      const loweredPath = abstractFile.path.toLocaleLowerCase();
      if (abstractFile instanceof TFile) {
        if (!managedPaths.has(loweredPath)) blockedFilePaths.add(loweredPath);
      } else if (abstractFile instanceof TFolder) {
        blockedFolderPaths.add(loweredPath);
      }
    }
    return { blockedFilePaths, blockedFolderPaths };
  }

  async performPhysicalSync() {
    const rootPath = normalizePath(this.plugin.settings.managedFolder || DEFAULT_SETTINGS.managedFolder);
    await this.ensureFolderPath(rootPath);
    const { blockedFilePaths, blockedFolderPaths } = this.getBlockedLayoutPaths();
    const planById = buildPhysicalLayoutPlan(
      this.nodesById,
      this.childrenByParentId,
      rootPath,
      blockedFilePaths,
      blockedFolderPaths,
    );
    const movingNodes = [...this.nodesById.values()].filter(
      (node) => planById.get(node.id)?.filePath !== node.file.path,
    );
    const cleanupPaths = new Set();
    const managedRoots = new Set([
      rootPath,
      ...(this.plugin.legacyManagedFolders || []),
    ].map((path) => normalizePath(path)));
    const rememberManagedAncestors = (filePath) => {
      let folderPath = normalizePath(filePath).split("/").slice(0, -1).join("/");
      const owningRoot = [...managedRoots].find(
        (candidate) => folderPath === candidate || folderPath.startsWith(`${candidate}/`),
      );
      if (!owningRoot) return;

      while (folderPath && folderPath !== rootPath) {
        cleanupPaths.add(folderPath);
        if (folderPath === owningRoot) break;
        folderPath = folderPath.split("/").slice(0, -1).join("/");
      }
    };
    for (const node of movingNodes) rememberManagedAncestors(node.file.path);

    this.isReconcilingPhysical = true;
    try {
      if (movingNodes.length > 0) {
        const stagingPath = normalizePath(`${rootPath}/_page-tree-staging-${createPageId().slice(0, 8)}`);
        cleanupPaths.add(stagingPath);
        await this.ensureFolderPath(stagingPath);

        for (const node of movingNodes) {
          const oldPath = node.file.path;
          const stagedPath = normalizePath(`${stagingPath}/${node.id}.md`);
          await this.app.fileManager.renameFile(node.file, stagedPath);
          this.idByPath.delete(oldPath);
          this.idByPath.set(node.file.path, node.id);
        }

        const destinationFolders = new Set([rootPath]);
        for (const plan of planById.values()) {
          const parentPath = plan.filePath.split("/").slice(0, -1).join("/");
          if (parentPath) destinationFolders.add(parentPath);
        }
        const sortedFolders = [...destinationFolders].sort(
          (left, right) => left.split("/").length - right.split("/").length,
        );
        for (const folderPath of sortedFolders) await this.ensureFolderPath(folderPath);

        for (const node of movingNodes) {
          const plan = planById.get(node.id);
          await this.app.fileManager.renameFile(node.file, plan.filePath);
          this.idByPath.set(node.file.path, node.id);
        }
      }

      this.idByPath.clear();
      for (const node of this.nodesById.values()) this.idByPath.set(node.file.path, node.id);
      await this.cleanupEmptyManagedFolders(rootPath, cleanupPaths);
      this.emit();
    } finally {
      this.isReconcilingPhysical = false;
    }
  }

  async cleanupEmptyManagedFolders(rootPath, requestedPaths = new Set()) {
    const candidatePaths = new Set([...requestedPaths].map((path) => normalizePath(path)));
    const legacyRoots = [...(this.plugin.legacyManagedFolders || [])].map((path) => normalizePath(path));

    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (!(file instanceof TFolder)) continue;
      if (
        file.path.startsWith(`${rootPath}/_page-tree-staging-`) ||
        legacyRoots.some((legacyRoot) => file.path === legacyRoot || file.path.startsWith(`${legacyRoot}/`))
      ) {
        candidatePaths.add(file.path);
      }
    }

    const sortedPaths = [...candidatePaths]
      .filter((path) => path && path !== rootPath)
      .sort((left, right) => right.split("/").length - left.split("/").length);
    for (const path of sortedPaths) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder && folder.children.length === 0) {
        await this.app.vault.delete(folder, true);
      }
    }
  }

  async rebuild() {
    this.nodesById.clear();
    this.idByPath.clear();

    const files = [...this.app.vault.getMarkdownFiles()].sort((a, b) => a.path.localeCompare(b.path));
    let repairedDuplicates = 0;

    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      let node = parsePageMetadata(file, cache?.frontmatter);
      if (!node) continue;

      const duplicate = this.nodesById.get(node.id);
      if (duplicate && duplicate.file.path !== file.path) {
        const newId = createPageId();
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter[META_MARKER] = true;
          frontmatter[META_ID] = newId;
        });
        node = { ...node, id: newId };
        repairedDuplicates += 1;
      }

      this.nodesById.set(node.id, node);
      this.idByPath.set(file.path, node.id);
    }

    this.rebuildChildrenIndex();
    this.pruneExpandedIds();
    if (repairedDuplicates > 0) {
      new Notice(`已修复 ${repairedDuplicates} 个重复页面 ID`);
    }
    this.emit();
  }

  rebuildChildrenIndex() {
    this.childrenByParentId.clear();
    for (const node of this.nodesById.values()) {
      const key = node.parentId || null;
      const children = this.childrenByParentId.get(key) || [];
      children.push(node);
      this.childrenByParentId.set(key, children);
    }

    for (const children of this.childrenByParentId.values()) {
      children.sort(compareNodes);
    }
  }

  pruneExpandedIds() {
    const expandedIds = this.plugin.getExpandedIds();
    const validIds = new Set([...expandedIds].filter((id) => this.nodesById.has(id)));
    if (validIds.size !== expandedIds.size) this.plugin.setExpandedIds(validIds);
  }

  getNode(id) {
    return id ? this.nodesById.get(id) || null : null;
  }

  getNodeForFile(file) {
    const id = file ? this.idByPath.get(file.path) : null;
    return id ? this.getNode(id) : null;
  }

  rebuildPathIndex() {
    this.idByPath.clear();
    for (const node of this.nodesById.values()) this.idByPath.set(node.file.path, node.id);
  }

  getChildren(parentId) {
    return [...(this.childrenByParentId.get(parentId || null) || [])];
  }

  getEndOrder(parentId) {
    const children = this.getChildren(parentId);
    if (children.length === 0) return ORDER_STEP;
    return children[children.length - 1].order + ORDER_STEP;
  }

  async syncFile(file, suppliedCache) {
    if (!(file instanceof TFile) || file.extension !== "md") return;

    const previousId = this.idByPath.get(file.path);
    if (previousId) {
      this.nodesById.delete(previousId);
      this.idByPath.delete(file.path);
    }

    const cache = suppliedCache || this.app.metadataCache.getFileCache(file);
    let node = parsePageMetadata(file, cache?.frontmatter);
    if (node) {
      const duplicate = this.nodesById.get(node.id);
      if (duplicate && duplicate.file.path !== file.path) {
        const newId = createPageId();
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          frontmatter[META_MARKER] = true;
          frontmatter[META_ID] = newId;
        });
        node = { ...node, id: newId };
        new Notice("复制的页面已获得新的页面 ID");
      }

      this.nodesById.set(node.id, node);
      this.idByPath.set(file.path, node.id);
    }

    this.rebuildChildrenIndex();
    this.emit();
    this.requestPhysicalSync();
  }

  async handleRename(file, oldPath) {
    if (file instanceof TFolder) {
      this.rebuildPathIndex();
      if (!this.isReconcilingPhysical) await this.syncPhysicalTree();
      return;
    }
    if (!(file instanceof TFile)) return;
    const id = this.idByPath.get(oldPath);
    if (!id) return;

    this.idByPath.delete(oldPath);
    this.idByPath.set(file.path, id);
    const node = this.nodesById.get(id);
    if (node) node.file = file;

    if (this.isReconcilingPhysical) {
      this.emit();
      return;
    }

    const oldFileName = oldPath.split("/").pop() || "";
    const oldBaseName = oldFileName.toLocaleLowerCase().endsWith(".md") ? oldFileName.slice(0, -3) : oldFileName;
    const titleChangedThroughFileName = oldBaseName !== file.basename;
    if (node && titleChangedThroughFileName) {
      await this.writeNode(node, { title: file.basename });
    }
    await this.syncPhysicalTree();
  }

  handleDelete(file) {
    if (!(file instanceof TFile)) return;
    const id = this.idByPath.get(file.path);
    if (!id) return;

    this.idByPath.delete(file.path);
    this.nodesById.delete(id);
    this.rebuildChildrenIndex();
    this.pruneExpandedIds();
    this.emit();
    this.requestPhysicalSync();
  }

  async getAvailablePath(title, excludePath = null) {
    await this.ensureManagedFolder();
    const folder = normalizePath(textValue(this.plugin.settings.managedFolder) || DEFAULT_SETTINGS.managedFolder);
    const baseName = sanitizeFileName(title);
    let suffix = 1;

    while (true) {
      const fileName = suffix === 1 ? `${baseName}.md` : `${baseName} ${suffix}.md`;
      const candidate = normalizePath(`${folder}/${fileName}`);
      const existing = this.app.vault.getAbstractFileByPath(candidate);
      if (!existing || candidate === excludePath) return candidate;
      suffix += 1;
    }
  }

  async createPage(title, parentId = null) {
    const normalizedTitle = textValue(title) || "未命名页面";
    if (parentId && !this.nodesById.has(parentId)) {
      throw new Error("父页面不存在");
    }

    const id = createPageId();
    const order = this.getEndOrder(parentId);
    const path = await this.getAvailablePath(normalizedTitle);
    const parentLine = parentId ? `${META_PARENT}: ${JSON.stringify(parentId)}\n` : "";
    const content = [
      "---",
      `${META_MARKER}: true`,
      `${META_ID}: ${JSON.stringify(id)}`,
      parentLine.trimEnd(),
      `${META_ORDER}: ${order}`,
      `${META_TITLE}: ${JSON.stringify(normalizedTitle)}`,
      "---",
      "",
      "",
    ]
      .filter((line, index) => line || index >= 6)
      .join("\n");

    const file = await this.app.vault.create(path, content);
    const node = { id, parentId, order, title: normalizedTitle, file };
    this.nodesById.set(id, node);
    this.idByPath.set(file.path, id);
    this.rebuildChildrenIndex();
    this.emit();
    await this.syncPhysicalTree();
    return node;
  }

  async adoptFile(file, parentId = null) {
    if (!(file instanceof TFile) || file.extension !== "md") {
      throw new Error("只能将 Markdown 文件加入页面树");
    }

    const existing = this.getNodeForFile(file);
    if (existing) return existing;

    const node = {
      id: createPageId(),
      parentId,
      order: this.getEndOrder(parentId),
      title: file.basename,
      file,
    };
    await this.writeNode(node, {}, false);
    this.nodesById.set(node.id, node);
    this.idByPath.set(file.path, node.id);
    this.rebuildChildrenIndex();
    this.emit();
    await this.syncPhysicalTree();
    return node;
  }

  async writeNode(node, changes, shouldEmit = true) {
    const nextNode = { ...node, ...changes };
    await this.app.fileManager.processFrontMatter(node.file, (frontmatter) => {
      frontmatter[META_MARKER] = true;
      frontmatter[META_ID] = nextNode.id;
      if (nextNode.parentId) frontmatter[META_PARENT] = nextNode.parentId;
      else delete frontmatter[META_PARENT];
      frontmatter[META_ORDER] = nextNode.order;
      frontmatter[META_TITLE] = nextNode.title;
    });

    Object.assign(node, changes);
    this.nodesById.set(node.id, node);
    this.idByPath.set(node.file.path, node.id);
    this.rebuildChildrenIndex();
    if (shouldEmit) this.emit();
    return node;
  }

  async renamePage(id, title) {
    const node = this.getNode(id);
    if (!node) throw new Error("页面不存在");

    const normalizedTitle = textValue(title);
    if (!normalizedTitle) throw new Error("页面名称不能为空");

    await this.writeNode(node, { title: normalizedTitle });
    await this.syncPhysicalTree();
    return node;
  }

  async rebalance(parentId, excludingId = null) {
    const siblings = this.getChildren(parentId).filter((node) => node.id !== excludingId);
    for (let index = 0; index < siblings.length; index += 1) {
      await this.writeNode(siblings[index], { order: (index + 1) * ORDER_STEP }, false);
    }
    this.rebuildChildrenIndex();
  }

  async movePage(id, targetId, mode) {
    const node = this.getNode(id);
    const target = this.getNode(targetId);
    if (!node || !target) throw new Error("拖拽目标不存在");
    if (node.id === target.id) return;

    let parentId;
    let requestedIndex;
    if (mode === "inside") {
      parentId = target.id;
      requestedIndex = this.getChildren(parentId).filter((item) => item.id !== id).length;
    } else {
      parentId = target.parentId;
      const siblings = this.getChildren(parentId).filter((item) => item.id !== id);
      const targetIndex = siblings.findIndex((item) => item.id === target.id);
      if (targetIndex < 0) throw new Error("无法确定目标位置");
      requestedIndex = mode === "before" ? targetIndex : targetIndex + 1;
    }

    if (wouldCreateCycle(this.nodesById, id, parentId)) {
      throw new Error("不能把页面移动到它自己或它的后代之下");
    }

    let siblings = this.getChildren(parentId).filter((item) => item.id !== id);
    let order = computeOrderAt(siblings, requestedIndex);
    if (order === null) {
      await this.rebalance(parentId, id);
      siblings = this.getChildren(parentId).filter((item) => item.id !== id);
      order = computeOrderAt(siblings, requestedIndex);
    }

    await this.writeNode(node, { parentId, order });
    await this.syncPhysicalTree();
  }

  async moveToRoot(id) {
    const node = this.getNode(id);
    if (!node) throw new Error("页面不存在");
    const siblings = this.getChildren(null).filter((item) => item.id !== id);
    let order = computeOrderAt(siblings, siblings.length);
    if (order === null) {
      await this.rebalance(null, id);
      order = computeOrderAt(this.getChildren(null).filter((item) => item.id !== id), siblings.length);
    }
    await this.writeNode(node, { parentId: null, order });
    await this.syncPhysicalTree();
  }

  async deletePage(id) {
    const node = this.getNode(id);
    if (!node) return;

    const children = this.getChildren(id);
    let nextOrder = this.getEndOrder(node.parentId);
    for (const child of children) {
      await this.writeNode(child, { parentId: node.parentId, order: nextOrder }, false);
      nextOrder += ORDER_STEP;
    }

    await this.app.fileManager.trashFile(node.file);
    this.idByPath.delete(node.file.path);
    this.nodesById.delete(node.id);
    this.rebuildChildrenIndex();
    this.pruneExpandedIds();
    this.emit();
    await this.syncPhysicalTree();
  }
}

class TextPromptModal extends Modal {
  constructor(app, title, initialValue, placeholder, resolve) {
    super(app);
    this.promptTitle = title;
    this.initialValue = initialValue;
    this.placeholder = placeholder;
    this.resolvePrompt = resolve;
    this.resolved = false;
  }

  onOpen() {
    this.titleEl.setText(this.promptTitle);
    this.contentEl.empty();
    const form = this.contentEl.createEl("form");
    let input;

    new Setting(form).setName("页面名称").addText((text) => {
      input = text.inputEl;
      text.setValue(this.initialValue).setPlaceholder(this.placeholder);
    });

    const actions = form.createDiv({ cls: "npt-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    const submitButton = actions.createEl("button", {
      text: "确定",
      cls: "mod-cta",
      attr: { type: "submit" },
    });
    cancelButton.addEventListener("click", () => this.close());
    submitButton.disabled = !textValue(this.initialValue);
    input.addEventListener("input", () => {
      submitButton.disabled = !textValue(input.value);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = textValue(input.value);
      if (!value) return;
      this.resolved = true;
      this.resolvePrompt(value);
      this.close();
    });

    this.contentEl.win.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.resolvePrompt(null);
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, message, confirmLabel, resolve) {
    super(app);
    this.confirmTitle = title;
    this.message = message;
    this.confirmLabel = confirmLabel;
    this.resolveConfirm = resolve;
    this.resolved = false;
  }

  onOpen() {
    this.titleEl.setText(this.confirmTitle);
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.message, cls: "npt-modal-message" });
    const actions = this.contentEl.createDiv({ cls: "npt-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "取消" });
    const confirmButton = actions.createEl("button", {
      text: this.confirmLabel,
      cls: "npt-danger-button",
    });
    cancelButton.addEventListener("click", () => this.close());
    confirmButton.addEventListener("click", () => {
      this.resolved = true;
      this.resolveConfirm(true);
      this.close();
    });
    this.contentEl.win.setTimeout(() => confirmButton.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.resolved) this.resolveConfirm(false);
  }
}

function promptForText(app, title, initialValue = "", placeholder = "未命名页面") {
  return new Promise((resolve) => {
    new TextPromptModal(app, title, initialValue, placeholder, resolve).open();
  });
}

function confirmAction(app, title, message, confirmLabel) {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, message, confirmLabel, resolve).open();
  });
}

class PageTreeView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.repository = plugin.repository;
    this.navigation = false;
    this.query = "";
    this.activeId = null;
    this.draggedId = null;
    this.renderFrame = null;
    this.rowElements = new Map();
    this.visibleRows = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "页面树";
  }

  getIcon() {
    return "list-tree";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("nested-page-tree-view");

    const toolbar = this.contentEl.createDiv({ cls: "npt-toolbar" });
    toolbar.createDiv({ text: "页面树", cls: "npt-toolbar-title" });
    this.createIconButton(toolbar, "plus", "新建顶层页面", () => this.plugin.createPageFromPrompt(null));
    this.createIconButton(toolbar, "locate-fixed", "定位当前页面", () => this.revealActivePage());
    this.createIconButton(toolbar, "chevrons-down-up", "全部折叠", () => {
      this.plugin.setExpandedIds(new Set());
      this.scheduleRender();
    });
    this.createIconButton(toolbar, "refresh-cw", "重建页面索引", () => {
      this.plugin.runAction(async () => {
        await this.repository.rebuild();
        await this.repository.syncPhysicalTree();
      });
    });

    const search = this.contentEl.createDiv({ cls: "npt-search" });
    const searchIcon = search.createSpan({ cls: "npt-search-icon" });
    setIcon(searchIcon, "search");
    this.searchInput = search.createEl("input", {
      attr: { type: "search", placeholder: "筛选页面", "aria-label": "筛选页面" },
    });
    this.registerDomEvent(this.searchInput, "input", () => {
      this.query = this.searchInput.value;
      this.scheduleRender();
    });

    this.rootDropZone = this.contentEl.createDiv({ text: "移至顶层", cls: "npt-root-drop-zone" });
    this.registerDomEvent(this.rootDropZone, "dragover", (event) => {
      if (!this.draggedId) return;
      event.preventDefault();
      this.rootDropZone.addClass("is-drag-over");
    });
    this.registerDomEvent(this.rootDropZone, "dragleave", () => {
      this.rootDropZone.removeClass("is-drag-over");
    });
    this.registerDomEvent(this.rootDropZone, "drop", (event) => {
      event.preventDefault();
      const id = this.draggedId;
      this.finishDragging();
      if (id) this.plugin.runAction(() => this.repository.moveToRoot(id));
    });

    this.listEl = this.contentEl.createDiv({ cls: "npt-tree-list" });
    const unsubscribe = this.repository.subscribe(() => this.scheduleRender());
    this.register(unsubscribe);
    this.setActiveFile(this.app.workspace.getActiveFile());
    this.renderNow();
  }

  async onClose() {
    if (this.renderFrame !== null) {
      this.contentEl.win.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
  }

  createIconButton(container, icon, label, callback) {
    const button = container.createEl("button", {
      cls: "clickable-icon",
      attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(button, icon);
    this.registerDomEvent(button, "click", callback);
    return button;
  }

  setActiveFile(file) {
    this.activeId = this.repository.getNodeForFile(file)?.id || null;
    this.scheduleRender();
  }

  scheduleRender() {
    if (!this.listEl || this.renderFrame !== null) return;
    this.renderFrame = this.contentEl.win.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.renderNow();
    });
  }

  renderNow() {
    if (!this.listEl) return;
    const previousScroll = this.listEl.scrollTop;
    this.listEl.empty();
    this.rowElements.clear();

    if (!this.repository.ready) {
      this.listEl.createDiv({ text: "正在建立页面索引…", cls: "npt-loading" });
      return;
    }

    const expandedIds = this.plugin.getExpandedIds();
    this.visibleRows = buildVisibleRows(
      this.repository.nodesById,
      this.repository.childrenByParentId,
      expandedIds,
      this.query,
    );

    if (this.visibleRows.length === 0) {
      const empty = this.listEl.createDiv({ cls: "npt-empty" });
      empty.createDiv({ text: this.query ? "没有匹配的页面" : "还没有页面" });
      if (!this.query) {
        const button = empty.createEl("button", { cls: "npt-empty-action" });
        const icon = button.createSpan();
        setIcon(icon, "plus");
        button.createSpan({ text: "新建页面" });
        button.addEventListener("click", () => this.plugin.createPageFromPrompt(null));
      }
      return;
    }

    for (const rowData of this.visibleRows) {
      const node = this.repository.getNode(rowData.id);
      if (node) this.renderRow(node, rowData, expandedIds);
    }
    this.listEl.scrollTop = previousScroll;
  }

  renderRow(node, rowData, expandedIds) {
    const hasChildren = this.repository.getChildren(node.id).length > 0;
    const row = this.listEl.createDiv({ cls: "npt-tree-row", attr: { "data-page-id": node.id } });
    row.tabIndex = node.id === this.activeId ? 0 : -1;
    row.draggable = true;
    if (node.id === this.activeId) row.addClass("is-active");
    if (rowData.invalid) row.addClass("is-invalid");
    this.rowElements.set(node.id, row);

    for (let depth = 0; depth < rowData.depth; depth += 1) {
      row.createSpan({ cls: "npt-indent-step" });
    }

    if (hasChildren) {
      const toggle = row.createEl("button", {
        cls: "npt-row-toggle",
        attr: { type: "button", "aria-label": expandedIds.has(node.id) ? "折叠" : "展开" },
      });
      setIcon(toggle, expandedIds.has(node.id) || this.query ? "chevron-down" : "chevron-right");
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleExpanded(node.id);
      });
      toggle.addEventListener("dblclick", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
    } else {
      row.createSpan({ cls: "npt-row-toggle-placeholder" });
    }

    const pageIcon = row.createSpan({ cls: "npt-row-icon" });
    setIcon(pageIcon, "file-text");
    row.createSpan({ text: node.title, cls: "npt-row-title", attr: { title: node.title } });
    if (rowData.invalid) {
      const warning = row.createSpan({
        cls: "npt-row-status",
        attr: { title: "父页面缺失或层级存在循环" },
      });
      setIcon(warning, "circle-alert");
    }

    row.addEventListener("click", (event) => this.plugin.openPage(node, event));
    row.addEventListener("dblclick", (event) => {
      if (typeof event.target?.closest === "function" && event.target.closest("button")) return;
      event.preventDefault();
      this.plugin.renamePageFromPrompt(node.id);
    });
    row.addEventListener("contextmenu", (event) => this.showContextMenu(event, node));
    row.addEventListener("keydown", (event) => this.handleRowKeydown(event, node));
    row.addEventListener("dragstart", (event) => this.startDragging(event, node.id));
    row.addEventListener("dragend", () => this.finishDragging());
    row.addEventListener("dragover", (event) => this.handleDragOver(event, row));
    row.addEventListener("dragleave", () => this.clearDropClasses(row));
    row.addEventListener("drop", (event) => this.handleDrop(event, node.id, row));
  }

  toggleExpanded(id) {
    if (this.query) return;
    const expandedIds = this.plugin.getExpandedIds();
    if (expandedIds.has(id)) expandedIds.delete(id);
    else expandedIds.add(id);
    this.plugin.setExpandedIds(expandedIds);
    this.scheduleRender();
  }

  showContextMenu(event, node) {
    event.preventDefault();
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("新建子页面").setIcon("file-plus-2").onClick(() => this.plugin.createPageFromPrompt(node.id)),
    );
    menu.addItem((item) =>
      item.setTitle("在新标签页打开").setIcon("panel-top-open").onClick(() => this.plugin.openPage(node, true)),
    );
    menu.addItem((item) =>
      item.setTitle("重命名").setIcon("pencil").onClick(() => this.plugin.renamePageFromPrompt(node.id)),
    );
    if (node.parentId) {
      menu.addItem((item) =>
        item.setTitle("移至顶层").setIcon("corner-left-up").onClick(() => {
          this.plugin.runAction(() => this.repository.moveToRoot(node.id));
        }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("删除页面")
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => this.plugin.deletePageFromPrompt(node.id)),
    );
    menu.showAtMouseEvent(event);
  }

  handleRowKeydown(event, node) {
    const currentIndex = this.visibleRows.findIndex((row) => row.id === node.id);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = this.visibleRows[currentIndex + offset];
      if (next) this.rowElements.get(next.id)?.focus();
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      const children = this.repository.getChildren(node.id);
      const expandedIds = this.plugin.getExpandedIds();
      if (children.length > 0 && !expandedIds.has(node.id)) {
        expandedIds.add(node.id);
        this.plugin.setExpandedIds(expandedIds);
        this.scheduleRender();
      } else if (children.length > 0) {
        this.rowElements.get(children[0].id)?.focus();
      }
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      const expandedIds = this.plugin.getExpandedIds();
      if (expandedIds.has(node.id)) {
        expandedIds.delete(node.id);
        this.plugin.setExpandedIds(expandedIds);
        this.scheduleRender();
      } else if (node.parentId) {
        this.rowElements.get(node.parentId)?.focus();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      this.plugin.openPage(node, event);
    } else if (event.key === "F2") {
      event.preventDefault();
      this.plugin.renamePageFromPrompt(node.id);
    } else if (event.key === "Delete") {
      event.preventDefault();
      this.plugin.deletePageFromPrompt(node.id);
    }
  }

  startDragging(event, id) {
    this.draggedId = id;
    this.contentEl.addClass("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", id);
    }
  }

  finishDragging() {
    this.draggedId = null;
    this.contentEl.removeClass("is-dragging");
    this.rootDropZone?.removeClass("is-drag-over");
    for (const row of this.rowElements.values()) this.clearDropClasses(row);
  }

  clearDropClasses(row) {
    row.removeClass("is-drop-before", "is-drop-inside", "is-drop-after");
  }

  getDropMode(event, row) {
    const rect = row.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    if (ratio < 0.25) return "before";
    if (ratio > 0.75) return "after";
    return "inside";
  }

  handleDragOver(event, row) {
    if (!this.draggedId) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    this.clearDropClasses(row);
    row.addClass(`is-drop-${this.getDropMode(event, row)}`);
  }

  handleDrop(event, targetId, row) {
    event.preventDefault();
    event.stopPropagation();
    const draggedId = this.draggedId || event.dataTransfer?.getData("text/plain");
    const mode = this.getDropMode(event, row);
    this.finishDragging();
    if (draggedId) this.plugin.runAction(() => this.repository.movePage(draggedId, targetId, mode));
  }

  async revealPage(id) {
    const node = this.repository.getNode(id);
    if (!node) return;

    this.query = "";
    if (this.searchInput) this.searchInput.value = "";
    const expandedIds = this.plugin.getExpandedIds();
    const guard = new Set();
    let cursor = node;
    while (cursor?.parentId && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      expandedIds.add(cursor.parentId);
      cursor = this.repository.getNode(cursor.parentId);
    }
    this.plugin.setExpandedIds(expandedIds);
    this.renderNow();
    this.contentEl.win.requestAnimationFrame(() => {
      const row = this.rowElements.get(id);
      row?.scrollIntoView({ block: "nearest" });
      row?.focus();
    });
  }

  revealActivePage() {
    if (this.activeId) this.revealPage(this.activeId);
    else new Notice("当前文件不在页面树中");
  }
}

class NestedPageTreeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("受控文件目录")
      .setDesc("页面树会自动维护 main 下的文件夹和 Markdown 文件。")
      .addText((text) => text.setValue(DEFAULT_SETTINGS.managedFolder).setDisabled(true));

    new Setting(containerEl)
      .setName("启动时打开页面树")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.openOnStartup).onChange((value) => {
          this.plugin.settings.openOnStartup = value;
          this.plugin.scheduleSaveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("隐藏受管页面属性")
      .setDesc("隐藏页面正文顶部的插件元数据；YAML 仍保留在 Markdown 文件中。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.hideManagedProperties).onChange((value) => {
          this.plugin.settings.hideManagedProperties = value;
          this.plugin.updatePropertyVisibility();
          this.plugin.scheduleSaveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("重置折叠状态")
      .addButton((button) =>
        button.setButtonText("全部折叠").onClick(() => {
          this.plugin.setExpandedIds(new Set());
        }),
      );
  }
}

class NestedPageTreePlugin extends Plugin {
  async onload() {
    const loaded = (await this.loadData()) || {};
    const previousManagedFolder = textValue(loaded.managedFolder);
    this.legacyManagedFolders = new Set();
    if (
      previousManagedFolder &&
      normalizePath(previousManagedFolder) !== DEFAULT_SETTINGS.managedFolder
    ) {
      this.legacyManagedFolders.add(normalizePath(previousManagedFolder));
    }
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      managedFolder: DEFAULT_SETTINGS.managedFolder,
      syncFileNames: true,
      storageLayoutVersion: DEFAULT_SETTINGS.storageLayoutVersion,
      expandedIds: Array.isArray(loaded.expandedIds) ? loaded.expandedIds.filter((id) => typeof id === "string") : [],
    };
    await this.saveData(this.settings);
    this.repository = new PageRepository(this);
    this.saveTimer = null;
    this.started = false;
    this.lastActivePageId = null;
    this.propertyDocuments = new Set();
    this.setPropertyVisibilityForDocument(document);

    this.registerView(VIEW_TYPE, (leaf) => new PageTreeView(leaf, this));
    this.addRibbonIcon("list-tree", "打开页面树", () => this.activateView());
    this.addSettingTab(new NestedPageTreeSettingTab(this.app, this));

    this.addCommand({
      id: "open-page-tree",
      name: "打开页面树",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "create-root-page",
      name: "新建顶层页面",
      callback: () => this.createPageFromPrompt(null),
    });
    this.addCommand({
      id: "create-child-page",
      name: "为当前页面新建子页面",
      checkCallback: (checking) => {
        const node = this.getContextPage();
        if (!node) return false;
        if (!checking) this.createPageFromPrompt(node.id);
        return true;
      },
    });
    this.addCommand({
      id: "reveal-active-page",
      name: "在页面树中显示当前页面",
      checkCallback: (checking) => {
        const node = this.getContextPage();
        if (!node) return false;
        if (!checking) this.revealPage(node.id);
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        const node = this.repository.getNodeForFile(file);
        menu.addItem((item) => {
          item
            .setTitle(node ? "在页面树中显示" : "加入页面树")
            .setIcon(node ? "locate-fixed" : "file-plus-2")
            .setSection("action")
            .onClick(() => {
              this.runAction(async () => {
                await this.ensureStarted();
                const target = node || (await this.repository.adoptFile(file));
                await this.revealPage(target.id);
              });
            });
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        const node = this.repository.getNodeForFile(file);
        if (node) this.lastActivePageId = node.id;
        for (const view of this.getTreeViews()) view.setActiveFile(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, openedWindow) => {
        this.setPropertyVisibilityForDocument(openedWindow.document);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (_workspaceWindow, closedWindow) => {
        this.propertyDocuments.delete(closedWindow.document);
      }),
    );

    this.app.workspace.onLayoutReady(() => {
      this.runAction(async () => {
        await this.ensureStarted();
        if (this.settings.openOnStartup) await this.activateView();
      });
    });
  }

  onunload() {
    this.repository?.dispose();
    for (const workspaceDocument of this.propertyDocuments) {
      workspaceDocument.body?.classList.remove("npt-hide-managed-properties");
    }
    this.propertyDocuments.clear();
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      void this.saveData(this.settings);
    }
  }

  async ensureStarted() {
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      await this.repository.initialize();
      this.registerEvent(
        this.app.metadataCache.on("changed", (file, _data, cache) => {
          void this.runAction(() => this.repository.syncFile(file, cache));
        }),
      );
      this.registerEvent(
        this.app.vault.on("rename", (file, oldPath) => {
          void this.runAction(() => this.repository.handleRename(file, oldPath));
        }),
      );
      this.registerEvent(this.app.vault.on("delete", (file) => this.repository.handleDelete(file)));
      this.started = true;
    })();

    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  getExpandedIds() {
    return new Set(this.settings.expandedIds);
  }

  setPropertyVisibilityForDocument(workspaceDocument) {
    if (!workspaceDocument?.body) return;
    this.propertyDocuments.add(workspaceDocument);
    workspaceDocument.body.classList.toggle(
      "npt-hide-managed-properties",
      Boolean(this.settings.hideManagedProperties),
    );
  }

  updatePropertyVisibility() {
    for (const workspaceDocument of this.propertyDocuments) {
      this.setPropertyVisibilityForDocument(workspaceDocument);
    }
  }

  setExpandedIds(expandedIds) {
    this.settings.expandedIds = [...expandedIds];
    this.scheduleSaveSettings();
  }

  scheduleSaveSettings() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.saveData(this.settings);
    }, 250);
  }

  async runAction(action) {
    try {
      return await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("Nested Page Tree:", error);
      new Notice(`页面树操作失败：${message}`);
      return null;
    }
  }

  getTreeViews() {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof PageTreeView);
  }

  getContextPage() {
    const activeNode = this.repository.getNodeForFile(this.app.workspace.getActiveFile());
    if (activeNode) {
      this.lastActivePageId = activeNode.id;
      return activeNode;
    }
    return this.repository.getNode(this.lastActivePageId);
  }

  async activateView() {
    await this.ensureStarted();
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeftLeaf(false);
      if (!leaf) throw new Error("无法创建左侧页面树");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (leaf.isDeferred) await leaf.loadIfDeferred();
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  async revealPage(id) {
    const leaf = await this.activateView();
    if (leaf.view instanceof PageTreeView) await leaf.view.revealPage(id);
  }

  async createPageFromPrompt(parentId) {
    await this.runAction(async () => {
      await this.ensureStarted();
      const title = await promptForText(this.app, parentId ? "新建子页面" : "新建顶层页面");
      if (!title) return;
      const node = await this.repository.createPage(title, parentId);
      this.lastActivePageId = node.id;
      if (parentId) {
        const expandedIds = this.getExpandedIds();
        expandedIds.add(parentId);
        this.setExpandedIds(expandedIds);
      }
      await this.openPage(node);
      await this.revealPage(node.id);
    });
  }

  async renamePageFromPrompt(id) {
    await this.runAction(async () => {
      const node = this.repository.getNode(id);
      if (!node) return;
      const title = await promptForText(this.app, "重命名页面", node.title);
      if (!title || title === node.title) return;
      await this.repository.renamePage(id, title);
    });
  }

  async deletePageFromPrompt(id) {
    await this.runAction(async () => {
      const node = this.repository.getNode(id);
      if (!node) return;
      const childCount = this.repository.getChildren(id).length;
      const childMessage = childCount > 0 ? ` ${childCount} 个直接子页面将提升到当前层级。` : "";
      const confirmed = await confirmAction(
        this.app,
        "删除页面",
        `“${node.title}”将按照 Obsidian 的回收站设置被移除。${childMessage}`,
        "删除",
      );
      if (confirmed) await this.repository.deletePage(id);
    });
  }

  async openPage(node, eventOrNewLeaf = false) {
    if (!node) return;
    this.lastActivePageId = node.id;
    const newLeaf =
      eventOrNewLeaf === true ||
      (eventOrNewLeaf && typeof eventOrNewLeaf === "object" && (eventOrNewLeaf.ctrlKey || eventOrNewLeaf.metaKey));
    const leaf = this.app.workspace.getLeaf(Boolean(newLeaf));
    await leaf.openFile(node.file);
  }
}

module.exports = NestedPageTreePlugin;
module.exports.__test = {
  buildPhysicalLayoutPlan,
  buildVisibleRows,
  compareNodes,
  computeOrderAt,
  parsePageMetadata,
  sanitizeFileName,
  wouldCreateCycle,
};
