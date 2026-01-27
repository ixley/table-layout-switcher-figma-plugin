// Table Layout Switcher — runs in the Figma plugin sandbox
// This plugin helps switch a table-like structure between two layout
// strategies used in Figma designs:
// - "column-first": an outer horizontal layout where each child is a
//   column (vertical stacks of cells)
// - "row-first": an outer vertical layout where each child is a
//   row (horizontal stacks of cells)
// The code below parses a selected frame/instance/component that is
// organized as nested containers (rows or columns), determines the
// layout orientation, computes consistent sizes for cells, and rebuilds
// the layout in the alternate orientation while attempting to preserve
// sizing, spacing, and which containers should fill available space.

type LayoutKind = "column-first" | "row-first";

type TableRootNode = FrameNode | InstanceNode | ComponentNode;

interface TableParse {
  kind: LayoutKind;
  rows: number;
  cols: number;
  /** cells[row][col] */
  cells: SceneNode[][];
  root: TableRootNode;
  /** First-level containers (column or row containers) */
  containers: TableRootNode[];
  /** layoutGrow per container (1 = fill, 0 = fixed/hug). Order matches containers. */
  containerLayoutGrow: number[];
}

function isTableRoot(node: SceneNode): node is TableRootNode {
  return (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && "children" in node && node.children.length > 0;
}

function isContainer(node: SceneNode): node is TableRootNode {
  return (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") && "children" in node;
}

/** Infer layout from axis: HORIZONTAL outer + VERTICAL inner = column-first; VERTICAL outer + HORIZONTAL inner = row-first. */
function inferLayoutFromAxes(root: TableRootNode): LayoutKind | null {
  const layoutMode = "layoutMode" in root ? root.layoutMode : "NONE";
  const firstChild = root.children[0];
  if (!isContainer(firstChild)) return null;
  const innerMode = "layoutMode" in firstChild ? firstChild.layoutMode : "NONE";
  if (layoutMode === "HORIZONTAL" && (innerMode === "VERTICAL" || innerMode === "NONE")) return "column-first";
  if (layoutMode === "VERTICAL" && (innerMode === "HORIZONTAL" || innerMode === "NONE")) return "row-first";
  return null;
}

/** Parse selection into a table grid. Returns null if selection is not a valid table. */
function parseTable(rootNode: TableRootNode): TableParse | null {
  // Validate root is a frame-like node with children
  if (!isTableRoot(rootNode)) return null;
  const root = rootNode;

  // First-level children are containers (either rows or columns depending on layout)
  const containers = root.children.filter(isContainer) as TableRootNode[];
  if (containers.length === 0) return null; // nothing to work with

  // All containers should have the same number of children (a rectangular grid)
  const firstLen = containers[0].children.length;
  const allSameLength = containers.every((c) => c.children.length === firstLen);
  if (!allSameLength) return null; // not a uniform grid

  // Try to guess orientation from Figma's layoutMode axes; fallback to row-first
  const inferred = inferLayoutFromAxes(root);
  const kind: LayoutKind = inferred != null ? inferred : "row-first"; // default to row-first when ambiguous

  // Determine rows/cols counts depending on which axis is outer
  const rows = kind === "row-first" ? containers.length : firstLen;
  const cols = kind === "row-first" ? firstLen : containers.length;

  // Build a 2D array of cell references indexed by [row][col]
  const cells: SceneNode[][] = [];
  for (let r = 0; r < rows; r++) {
    cells[r] = [];
    for (let c = 0; c < cols; c++) {
      // When row-first: containers[r].children[c]
      // When column-first: containers[c].children[r]
      const node = kind === "row-first" ? (containers[r] as FrameNode).children[c] : (containers[c] as FrameNode).children[r];
      cells[r][c] = node;
    }
  }

  // Remember which top-level containers were set to fill (layoutGrow === 1)
  // so we can reapply that behavior after rebuilding the layout.
  const containerLayoutGrow = containers.map((cont) => {
    const n = cont as SceneNode & { layoutGrow?: number };
    return typeof n.layoutGrow === "number" && n.layoutGrow === 1 ? 1 : 0;
  });

  return { kind, rows, cols, cells, root, containers, containerLayoutGrow };
}

/** Compute consistent column widths and row heights from current cells. Prefer first cell or max in that row/column. */
function computeConsistentSizes(cells: SceneNode[][], rows: number, cols: number): { colWidths: number[]; rowHeights: number[] } {
  const colWidths: number[] = [];
  const rowHeights: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = 0;
    for (let r = 0; r < rows; r++) {
      const node = cells[r][c];
      const v = "width" in node ? node.width : 0;
      // Use the first cell's width as a baseline, but if any other cell
      // in the column is wider, take the max so content doesn't overflow.
      if (r === 0) w = typeof v === "number" ? v : 0;
      else if (typeof v === "number" && v > w) w = v;
    }
    colWidths.push(w);
  }
  for (let r = 0; r < rows; r++) {
    let h = 0;
    for (let c = 0; c < cols; c++) {
      const node = cells[r][c];
      const v = "height" in node ? node.height : 0;
      // Same idea for row heights: prefer the first cell in the row,
      // but use the max if another cell is taller.
      if (c === 0) h = typeof v === "number" ? v : 0;
      else if (typeof v === "number" && v > h) h = v;
    }
    rowHeights.push(h);
  }
  return { colWidths, rowHeights };
}

/** Read layoutAlign and layoutGrow from a node if it supports them (for fixed/hug/fill). */
function getCellLayout(node: SceneNode): { layoutAlign: "STRETCH" | "INHERIT" | "MIN" | "CENTER" | "MAX"; layoutGrow: number } {
  const n = node as SceneNode & { layoutAlign?: string; layoutGrow?: number };
  return {
    layoutAlign: (n.layoutAlign === "STRETCH" || n.layoutAlign === "MIN" || n.layoutAlign === "CENTER" || n.layoutAlign === "MAX"
      ? n.layoutAlign
      : "INHERIT") as "STRETCH" | "INHERIT" | "MIN" | "CENTER" | "MAX",
    layoutGrow: typeof n.layoutGrow === "number" ? (n.layoutGrow === 1 ? 1 : 0) : 0,
  };
}

/** Set layoutAlign and layoutGrow on a node if it supports them. */
function setCellLayout(node: SceneNode, layoutAlign: "STRETCH" | "INHERIT", layoutGrow: number): void {
  const n = node as SceneNode & { layoutAlign?: string; layoutGrow?: number };
  if ("layoutAlign" in n) n.layoutAlign = layoutAlign;
  if ("layoutGrow" in n) n.layoutGrow = layoutGrow;
}

function getLayoutProps(node: TableRootNode): {
  itemSpacing: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
} {
  const base = "itemSpacing" in node ? node : { itemSpacing: 0, paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 };
  return {
    itemSpacing: typeof (base as any).itemSpacing === "number" ? (base as any).itemSpacing : 0,
    paddingLeft: typeof (base as any).paddingLeft === "number" ? (base as any).paddingLeft : 0,
    paddingRight: typeof (base as any).paddingRight === "number" ? (base as any).paddingRight : 0,
    paddingTop: typeof (base as any).paddingTop === "number" ? (base as any).paddingTop : 0,
    paddingBottom: typeof (base as any).paddingBottom === "number" ? (base as any).paddingBottom : 0,
  };
}

function applyResize(node: SceneNode, width: number, height: number): void {
  if ("resize" in node && typeof (node as any).resize === "function") {
    (node as any).resize(width, height);
  }
}

/** Create a new auto-layout container frame. Do not set size here — set counter-axis after children are appended. */
function createContainerFrame(
  name: string,
  layoutMode: "HORIZONTAL" | "VERTICAL",
  sourceProps: { itemSpacing: number; paddingLeft: number; paddingRight: number; paddingTop: number; paddingBottom: number },
): FrameNode {
  const frame = figma.createFrame();
  frame.name = name;
  frame.layoutMode = layoutMode;
  frame.primaryAxisSizingMode = "AUTO"; // primary axis hugs content (height for column, width for row)
  frame.counterAxisSizingMode = "FIXED"; // counter axis fixed at container (width for column, height for row)
  frame.itemSpacing = sourceProps.itemSpacing;
  frame.paddingLeft = sourceProps.paddingLeft;
  frame.paddingRight = sourceProps.paddingRight;
  frame.paddingTop = sourceProps.paddingTop;
  frame.paddingBottom = sourceProps.paddingBottom;
  frame.primaryAxisAlignItems = "MIN";
  frame.counterAxisAlignItems = "MIN";
  return frame;
}


/** Switch the table to the other layout (column-first ↔ row-first). */
function switchLayout(parse: TableParse): void {
  const { kind, rows, cols, cells, root, containers, containerLayoutGrow } = parse;
  const inner = containers[0];
  const rootProps = getLayoutProps(root);
  const innerProps = getLayoutProps(inner);

  const { colWidths, rowHeights } = computeConsistentSizes(cells, rows, cols);

  const newKind: LayoutKind = kind === "column-first" ? "row-first" : "column-first";

  // Pre-scan cells (before moving them) to determine which NEW containers should fill
  // the root's primary axis.
  //   Col→Row: a row fills HEIGHT if any of its cells had fill height (layoutGrow=1 in a vertical column).
  //   Row→Col: a column fills WIDTH if any of its cells had fill width (layoutGrow=1 in a horizontal row).
  const newContainerShouldFill: boolean[] = [];
  if (newKind === "row-first") {
    for (let r = 0; r < rows; r++) {
      newContainerShouldFill[r] = false;
      for (let c = 0; c < cols; c++) {
        if (getCellLayout(cells[r][c]).layoutGrow === 1) { newContainerShouldFill[r] = true; break; }
      }
    }
  } else {
    for (let c = 0; c < cols; c++) {
      newContainerShouldFill[c] = false;
      for (let r = 0; r < rows; r++) {
        if (getCellLayout(cells[r][c]).layoutGrow === 1) { newContainerShouldFill[c] = true; break; }
      }
    }
  }

  // Cache all cell dimensions before any modifications. Reading dimensions during the loop risks
  // reading stale values after layout state has been partially mutated.
  const cachedWidths: number[][] = cells.map(row =>
    row.map(cell => ("width" in cell ? (cell as any).width : 0))
  );
  const cachedHeights: number[][] = cells.map(row =>
    row.map(cell => ("height" in cell ? (cell as any).height : 0))
  );

  // If any new container will have fill-primary children (layoutGrow=1), it must be FIXED on that
  // axis — not HUG — so cells have a concrete dimension to fill into. Detect this now, before
  // creating containers, so we can set FIXED at creation time rather than after cells are placed.
  const hasFillPrimaryChildren = containerLayoutGrow.some(g => g === 1);

  // Create new containers. layoutAlign="STRETCH" makes each container span the root's counter axis:
  // rows fill root width (counter axis of VERTICAL root); columns fill root height (counter axis of HORIZONTAL root).
  const newContainers: FrameNode[] = [];
  if (newKind === "row-first") {
    for (let r = 0; r < rows; r++) {
      const f = createContainerFrame(`Row ${r + 1}`, "HORIZONTAL", innerProps);
      f.layoutAlign = "STRETCH";
      if (hasFillPrimaryChildren) f.primaryAxisSizingMode = "FIXED";
      newContainers.push(f);
    }
  } else {
    for (let c = 0; c < cols; c++) {
      const f = createContainerFrame(`Column ${c + 1}`, "VERTICAL", innerProps);
      f.layoutAlign = "STRETCH";
      if (hasFillPrimaryChildren) f.primaryAxisSizingMode = "FIXED";
      newContainers.push(f);
    }
  }

  // Move cells into new containers, applying the correct fill properties for the new layout axis.
  //
  // Col→Row rules:
  //   Cell WIDTH  = from original column container (layoutGrow=1 if column was fill, else colWidths[c])
  //   Cell HEIGHT = always FILL via layoutAlign="STRETCH" (cells uniformly fill their row's height)
  //
  // Row→Col rules:
  //   Cell HEIGHT = from original row container (layoutGrow=1 if row was fill, else rowHeights[r])
  //   Cell WIDTH  = always FILL via layoutAlign="STRETCH" (cells uniformly fill their column's width)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];

      if (newKind === "row-first") {
        const shouldFillWidth = containerLayoutGrow[c] === 1;
        // Clear old fill state first (while cell is still in its original container). This prevents
        // stale layoutGrow/layoutAlign from the source axis causing circular dependencies in the
        // new container (e.g. old layoutGrow=1 would try to fill the new row's primary axis).
        setCellLayout(cell, "INHERIT", 0);
        if (!shouldFillWidth) {
          applyResize(cell, colWidths[c], cachedHeights[r][c]);
        }
        newContainers[r].appendChild(cell);
        // Set new fill state in the correct container context. STRETCH fills HEIGHT (counter axis
        // of HORIZONTAL row); layoutGrow=1 fills WIDTH (primary axis) for fill-column cells.
        setCellLayout(cell, "STRETCH", shouldFillWidth ? 1 : 0);
      } else {
        const shouldFillHeight = containerLayoutGrow[r] === 1;
        // Same: clear old fill state before moving so the cell enters the new column neutrally.
        setCellLayout(cell, "INHERIT", 0);
        if (!shouldFillHeight) {
          applyResize(cell, cachedWidths[r][c], rowHeights[r]);
        }
        newContainers[c].appendChild(cell);
        // STRETCH fills WIDTH (counter axis of VERTICAL column); layoutGrow=1 fills HEIGHT
        // (primary axis) for fill-row cells.
        setCellLayout(cell, "STRETCH", shouldFillHeight ? 1 : 0);
      }
    }
  }

  // Remove old containers, update root layout mode, then append new containers.
  // Appending is done BEFORE sizing so that layoutAlign="STRETCH" is active when we read/set dimensions.
  for (const old of containers) {
    old.remove();
  }
  if (root.type !== "INSTANCE") {
    const frame = root as FrameNode;
    // Read sizing modes BEFORE flipping layoutMode. When the axis flips, primaryAxisSizingMode
    // and counterAxisSizingMode swap which physical dimension (width vs height) they control.
    // Swapping them preserves the original HUG/FIXED behavior on each physical dimension.
    const oldPrimary = frame.primaryAxisSizingMode;
    const oldCounter = frame.counterAxisSizingMode;
    frame.layoutMode = newKind === "row-first" ? "VERTICAL" : "HORIZONTAL";
    frame.primaryAxisSizingMode = oldCounter;
    frame.counterAxisSizingMode = oldPrimary;
    frame.itemSpacing = rootProps.itemSpacing;
    frame.paddingLeft = rootProps.paddingLeft;
    frame.paddingRight = rootProps.paddingRight;
    frame.paddingTop = rootProps.paddingTop;
    frame.paddingBottom = rootProps.paddingBottom;
  }
  for (const nc of newContainers) {
    root.appendChild(nc);
  }

  // Size containers now that STRETCH is active (the root's cross-axis dimension is available).
  // Fill containers get layoutGrow=1 (fills root's primary axis). Fixed containers are explicitly sized
  // on the non-STRETCH dimension; the STRETCH dimension is already set by the root.
  if (newKind === "row-first") {
    for (let r = 0; r < rows; r++) {
      const rowFrame = newContainers[r];
      if (newContainerShouldFill[r]) {
        (rowFrame as SceneNode & { layoutGrow: number }).layoutGrow = 1; // fills root HEIGHT
      } else {
        rowFrame.resize(rowFrame.width, rowHeights[r]); // STRETCH sets width; we set explicit height
      }
    }
  } else {
    for (let c = 0; c < cols; c++) {
      const colFrame = newContainers[c];
      if (newContainerShouldFill[c]) {
        (colFrame as SceneNode & { layoutGrow: number }).layoutGrow = 1; // fills root WIDTH
      } else {
        colFrame.resize(colWidths[c], colFrame.height); // STRETCH sets height; we set explicit width
      }
    }
  }

  figma.currentPage.selection = [root];
}

// —— Plugin entry and UI ——

figma.showUI(__html__, { width: 320, height: 200, themeColors: true });

function getTargetNode(): TableRootNode | null {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) return null;
  const node = sel[0];
  if (node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE") {
    return node as TableRootNode;
  }
  return null;
}

function detectAndSend(): void {
  const node = getTargetNode();
  if (!node) {
    figma.ui.postMessage({ type: "layoutStatus", kind: null, error: "Select a single frame or instance (the table root)." });
    return;
  }
  const parse = parseTable(node);
  if (!parse) {
    figma.ui.postMessage({ type: "layoutStatus", kind: null, error: "Not a valid table: need container frames with equal cell counts." });
    return;
  }
  figma.ui.postMessage({
    type: "layoutStatus",
    kind: parse.kind,
    rows: parse.rows,
    cols: parse.cols,
    error: null,
  });
}

figma.ui.onmessage = (msg: { type: string }) => {
  if (msg.type === "switchLayout") {
    const node = getTargetNode();
    if (!node) {
      figma.notify("Select a single table frame or instance.", { error: true });
      return;
    }
    const parse = parseTable(node);
    if (!parse) {
      figma.notify("Not a valid table. Use container frames with the same number of cells per container.", { error: true });
      return;
    }
    switchLayout(parse);
    figma.notify(`Switched to ${parse.kind === "column-first" ? "column-first" : "row-first"} layout.`);
    detectAndSend();
  } else if (msg.type === "detect") {
    detectAndSend();
  }
};

// Run detection when selection changes
figma.on("selectionchange", () => detectAndSend());
// Initial detection
detectAndSend();
