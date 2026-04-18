export type SizeUnit = 'px' | 'dpx' | 'auto';

export interface Size {
  value: number;
  unit: SizeUnit;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NodeType = 'row' | 'column';

export interface LayoutNode {
  children: LayoutNode[];
  parent: LayoutNode | null;
  computedLayout: Rect;
  deviceLayout: Rect;
  width: Size;
  height: Size;
  type: NodeType;
  tag?: string;
}

export interface LayoutNodeOptions {
  width?: Size;
  height?: Size;
  children?: LayoutNode[];
  tag?: string;
}

/**
 * Creates a Size object representing a dimension in logical pixels.
 *
 * @param value - The size value in logical pixels, or 'auto' for automatic sizing
 * @returns A Size object representing the dimension
 *
 * @example
 * ```typescript
 * // Fixed dimensions in logical pixels
 * const node = row({
 *   width: px(100),
 *   height: px(50)
 * });
 * ```
 */
export function px(value: number | 'auto' = 'auto'): Size {
  return {
    value: value === 'auto' ? 0 : value,
    unit: value === 'auto' ? 'auto' : 'px',
  };
}

/**
 * Creates a Size object representing a dimension in device pixels.
 * Device pixels will be converted to logical pixels based on the device pixel ratio.
 *
 * @param value - The size value in device pixels
 * @returns A Size object representing the dimension
 *
 * @example
 * ```typescript
 * // Fixed dimensions in device pixels (will be scaled by devicePixelRatio)
 * const node = row({
 *   width: dpx(200),  // 100px on a 2x display
 *   height: dpx(100)  // 50px on a 2x display
 * });
 * ```
 */
export function dpx(value: number): Size {
  return {
    value,
    unit: 'dpx',
  };
}

/**
 * Creates a Size object representing an automatic dimension.
 * Auto-sized dimensions will be calculated based on available space
 * and the node's type (row/column).
 *
 * @returns A Size object representing an automatic dimension
 *
 * @example
 * ```typescript
 * // Auto dimensions
 * const node = row({
 *   width: auto(),   // Will share available width in a row
 *   height: auto()   // Will take full height in a row
 * });
 * ```
 */
export function auto(): Size {
  return {
    value: 0,
    unit: 'auto',
  };
}

/**
 * Creates a row layout node that arranges its children horizontally.
 *
 * @param options - Optional configuration for the row's dimensions and children
 * @param children - Optional array of child nodes
 * @returns A LayoutNode configured as a row
 *
 * @example
 * ```typescript
 * // Simple row with auto dimensions
 * const autoRow = row();
 *
 * // Row with fixed dimensions
 * const fixedRow = row({
 *   width: width(300),
 *   height: height(100)
 * });
 *
 * // Row with children
 * const rowWithChildren = row(
 *   { width: width(400) },
 *   [
 *     row({ width: width(100) }),
 *     row({ width: width(100) })
 *   ]
 * );
 * ```
 */
export function row(options: LayoutNodeOptions = {}, children: LayoutNode[] = []): LayoutNode {
  const newNode: LayoutNode = {
    children,
    parent: null,
    computedLayout: { x: 0, y: 0, width: 0, height: 0 },
    deviceLayout: { x: 0, y: 0, width: 0, height: 0 },
    width: options.width || auto(),
    height: options.height || auto(),
    type: 'row',
  };

  if (options.tag) {
    newNode.tag = options.tag;
  }

  // Add children and set their parent to this node
  for (const child of children) {
    child.parent = newNode;
  }

  return newNode;
}

/**
 * Creates a column layout node that arranges its children vertically.
 *
 * @param options - Optional configuration for the column's dimensions and children
 * @param children - Optional array of child nodes
 * @returns A LayoutNode configured as a column
 *
 * @example
 * ```typescript
 * // Simple column with auto dimensions
 * const autoColumn = column();
 *
 * // Column with fixed dimensions
 * const fixedColumn = column({
 *   width: width(300),
 *   height: height(100)
 * });
 *
 * // Column with children
 * const columnWithChildren = column(
 *   { height: height(400) },
 *   [
 *     row({ height: height(100) }),
 *     row({ height: height(100) })
 *   ]
 * );
 * ```
 */
export function column(options: LayoutNodeOptions = {}, children: LayoutNode[] = []): LayoutNode {
  const node = row(options, children);
  node.type = 'column';
  return node;
}

export interface LayoutContainer {
  root: LayoutNode;
  devicePixelRatio: number;
  logicalWidth: number;
  logicalHeight: number;
}

// Cache for tag lookups
const tagCache = new WeakMap<LayoutContainer, Map<string, LayoutNode>>();

/**
 * Finds a node by its tag within a layout container.
 * If there are multiple nodes with the same tag, returns the first one found.
 * Results are cached for performance.
 *
 * @param container - The layout container to search in
 * @param tag - The tag to search for
 * @returns The first node with the matching tag, or undefined if not found
 *
 * @example
 * ```typescript
 * const container = layout(800, 600);
 * const header = row({ tag: 'header' });
 * const content = row({ tag: 'content' });
 * calculateLayout(container, [header, content]);
 *
 * const headerNode = findByTag(container, 'header');
 * ```
 */
export function findByTag(container: LayoutContainer, tag: string): LayoutNode | undefined {
  if (!tag) return undefined;

  // Check cache first
  let containerCache = tagCache.get(container);
  if (containerCache) {
    const cached = containerCache.get(tag);
    if (cached) return cached;
  }

  // Cache miss - build new cache for this container
  containerCache = new Map();
  tagCache.set(container, containerCache);

  // Helper function to recursively traverse nodes and build cache
  function traverse(node: LayoutNode) {
    if (node.tag && !containerCache?.has(node.tag)) {
      containerCache?.set(node.tag, node);
    }
    for (const child of node.children) {
      traverse(child);
    }
  }

  // Build cache by traversing from root
  traverse(container.root);

  // Return from newly built cache
  return containerCache.get(tag);
}

/**
 * Creates a layout container with specified dimensions in device pixels.
 * The container serves as the root for a layout hierarchy.
 *
 * @param deviceWidth - The width of the container in device pixels
 * @param deviceHeight - The height of the container in device pixels
 * @param devicePixelRatio - The ratio of device pixels to logical pixels (default: 1.0)
 * @returns A LayoutContainer initialized with the specified dimensions
 *
 * @example
 * ```typescript
 * // Create a container with device pixel dimensions
 * const container = layout(1600, 1200, 2.0);
 * // Results in a container with logical size 800x600
 *
 * // Create and layout a simple hierarchy
 * const container = layout(300, 200);
 * const children = [
 *   row({ width: px(100) }),
 *   row({ width: auto() })
 * ];
 * calculateLayout(container, children);
 * ```
 */
export function layout(
  deviceWidth: number,
  deviceHeight: number,
  devicePixelRatio = 1.0,
): LayoutContainer {
  const logicalWidth = deviceWidth;
  const logicalHeight = deviceHeight;

  return {
    root: column({
      width: dpx(logicalWidth),
      height: dpx(logicalHeight),
    }),
    devicePixelRatio,
    logicalWidth,
    logicalHeight,
  };
}

interface LayoutTask {
  node: LayoutNode;
  x: number;
  y: number;
  availableWidth: number;
  availableHeight: number;
}

function calculateNodeAndQueueChildren(
  container: LayoutContainer,
  task: LayoutTask,
  queue: LayoutTask[],
): void {
  const { node, x, y, availableWidth, availableHeight } = task;

  // Convert node size to logical pixels
  let nodeWidth = getSizeInLogicalPixels(container, node.width);
  let nodeHeight = getSizeInLogicalPixels(container, node.height);

  const isRow = node.type === 'row';
  const isContainerRoot = node === container.root;

  // Handle auto dimensions
  if (node.width.unit === 'auto' || nodeWidth === 0) {
    nodeWidth = availableWidth;
  }
  if (node.height.unit === 'auto' || nodeHeight === 0) {
    nodeHeight = availableHeight;
  }

  // Set computed layout for this node
  node.computedLayout = {
    x,
    y,
    width: nodeWidth,
    height: nodeHeight,
  };
  node.deviceLayout = {
    x: getSizeInDevicePixels(container, x),
    y: getSizeInDevicePixels(container, y),
    width: getSizeInDevicePixels(container, nodeWidth),
    height: getSizeInDevicePixels(container, nodeHeight),
  };

  // If no children, we're done
  if (!node.children || node.children.length === 0) {
    return;
  }

  // Check if any children have their own children (nested layout)
  const hasNestedLayout = node.children.some(
    (child) => child.children && child.children.length > 0,
  );

  // For container root with nested layout, stack children vertically
  if (isContainerRoot && hasNestedLayout) {
    let currentY = y;
    let remainingHeight = nodeHeight;
    let autoHeightCount = 0;

    // First pass: count auto-height children and calculate fixed height total
    for (const child of node.children) {
      const childHeight = getSizeInLogicalPixels(container, child.height);
      if (child.height.unit === 'auto') {
        autoHeightCount++;
      } else {
        remainingHeight -= childHeight;
      }
    }

    // Second pass: queue children
    for (const child of node.children) {
      let childWidth = getSizeInLogicalPixels(container, child.width);
      let childHeight = getSizeInLogicalPixels(container, child.height);

      // Container children get full width
      if (child.width.unit === 'auto') {
        childWidth = nodeWidth;
      }

      // Auto-height children share remaining space
      if (child.height.unit === 'auto') {
        childHeight = autoHeightCount > 0 ? remainingHeight / autoHeightCount : 0;
      }

      queue.push({
        node: child,
        x,
        y: currentY,
        availableWidth: childWidth,
        availableHeight: childHeight,
      });

      currentY += childHeight;
    }
    return;
  }

  // Calculate space taken by fixed size children
  let fixedSpace = 0;
  let autoCount = 0;

  // First pass: calculate fixed space and count auto children
  for (const child of node.children) {
    const childSize = isRow
      ? getSizeInLogicalPixels(container, child.width)
      : getSizeInLogicalPixels(container, child.height);
    const childUnit = isRow ? child.width.unit : child.height.unit;

    if (childUnit === 'auto') {
      autoCount++;
    } else {
      fixedSpace += childSize;
    }
  }

  // Available space for auto children
  const mainAxisSize = isRow ? nodeWidth : nodeHeight;
  const availableAutoSpace = Math.max(0, mainAxisSize - fixedSpace);
  const autoSize = autoCount > 0 ? availableAutoSpace / autoCount : 0;

  // Position to place next child
  let currentPosition = isRow ? x : y;

  // Second pass: queue children
  for (const child of node.children) {
    let childWidth = getSizeInLogicalPixels(container, child.width);
    let childHeight = getSizeInLogicalPixels(container, child.height);

    // For row/column layouts, handle auto-sized children
    if (isRow) {
      if (child.width.unit === 'auto') {
        // In a row, auto-width children share available space
        childWidth = autoSize;
      }
      // In a row, height is always full height unless specified
      if (child.height.unit === 'auto') {
        childHeight = nodeHeight;
      }
    } else {
      // In a column, width is always full width unless specified
      if (child.width.unit === 'auto') {
        childWidth = nodeWidth;
      }
      // In a column, auto-height children share available space
      if (child.height.unit === 'auto') {
        childHeight = autoSize;
      }
    }

    // Calculate child position
    const childX = isRow ? currentPosition : x;
    const childY = isRow ? y : currentPosition;

    // Queue child for layout
    queue.push({
      node: child,
      x: childX,
      y: childY,
      availableWidth: childWidth,
      availableHeight: childHeight,
    });

    // Update position for next child
    currentPosition += isRow ? childWidth : childHeight;
  }
}

/**
 * Calculates the layout for a container and its children.
 * This function performs a breadth-first traversal of the layout tree,
 * computing positions and dimensions for each node based on its type (row/column)
 * and specified constraints.
 *
 * @param container - The layout container to calculate
 * @param rootChildren - Optional array of children to add to the container's root
 *
 * @example
 * ```typescript
 * // Create a container with a nested layout
 * const container = layout(300, 200);
 *
 * // Create a row with fixed height and two columns
 * const headerRow = row({ height: height(30) });
 * const contentRow = row(
 *   { height: height('auto') },
 *   [
 *     column(), // Left sidebar
 *     column()  // Main content
 *   ]
 * );
 *
 * // Calculate the layout
 * calculateLayout(container, [headerRow, contentRow]);
 *
 * // Access computed dimensions
 * console.log(headerRow.computedLayout);    // { x: 0, y: 0, width: 300, height: 30 }
 * console.log(contentRow.computedLayout);   // { x: 0, y: 30, width: 300, height: 170 }
 * ```
 */
export function calculateLayout(container: LayoutContainer, rootChildren: LayoutNode[] = []): void {
  // Clear tag cache for this container since layout is changing
  tagCache.delete(container);

  // Clear existing children and add new ones
  container.root.children = [...rootChildren];
  for (const child of rootChildren) {
    child.parent = container.root;
  }

  // Initialize queue with root node
  const queue: LayoutTask[] = [
    {
      node: container.root,
      x: 0,
      y: 0,
      availableWidth: container.logicalWidth,
      availableHeight: container.logicalHeight,
    },
  ];

  // Process nodes in breadth-first order
  while (queue.length > 0) {
    const task = queue.shift();
    if (!task) break; // This should never happen since we check queue.length > 0
    calculateNodeAndQueueChildren(container, task, queue);
  }
}

function getSizeInLogicalPixels(container: LayoutContainer, size: Size): number {
  if (size.unit === 'auto') {
    return 0;
  }
  if (size.unit === 'dpx') {
    return Math.floor(size.value / container.devicePixelRatio);
  }
  // logical pixels (px)
  return size.value;
}

function getSizeInDevicePixels(container: LayoutContainer, size: number): number {
  return Math.ceil(size * container.devicePixelRatio);
}
