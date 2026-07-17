/**
 * Atlassian Document Format (ADF) helpers.
 *
 * ADF is the JSON tree that Jira REST v3 returns for rich-text fields such as
 * `description`. Top level shape is `{ type: 'doc', version: 1, content: [...] }`.
 * Nested nodes carry a `type` discriminator (`paragraph`, `heading`,
 * `bulletList`, `taskList`, `text`, `codeBlock`, etc.) plus optional `content`,
 * `text`, and `attrs` fields.
 *
 * This module is intentionally pure:
 *   - No `vscode` import.
 *   - No Node-only deps (`fs`, `path`, `Buffer`, `process`, ...).
 *   - Every `unknown` input is narrowed defensively; malformed trees return an
 *     empty string or `{ items: [], source: 'none' }` rather than throwing.
 *
 * Two public functions:
 *   - `adfToPlainText(adf)` — best-effort flattening for diffing / previewing.
 *   - `adfExtractAcceptanceCriteria(adf, headingMarker)` — heuristic AC list
 *     extractor used by `tool.ac-to-testing` and `mode.ticket-work` to pull
 *     acceptance criteria out of a ticket's description.
 */

/** Narrow internal view of an ADF node. ADF is loosely typed in the wire
 *  format, so we keep this pragmatic rather than enumerating every variant. */
interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
}

/** One extracted acceptance-criterion item. */
export interface AcItem {
  /** Flattened plain-text content of the list item. */
  text: string;
  /** `'done'` only when the source was an ADF `taskItem` whose
   *  `attrs.state === 'DONE'`; plain bullets/numbers map to `'todo'`. */
  initialState: 'todo' | 'done';
}

/** Result of an AC-extraction attempt. `source` records which branch of the
 *  heuristic produced `items` so callers can surface that provenance. */
export interface AcExtractResult {
  items: AcItem[];
  source: 'taskList' | 'ac-heading-list' | 'first-list' | 'none';
}

/* ------------------------------------------------------------------ */
/* Defensive narrowing                                                 */
/* ------------------------------------------------------------------ */

/** Type guard — true when `value` is a plain object with a string `type`. */
function isAdfNode(value: unknown): value is AdfNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/** Return `node.content` as an `AdfNode[]` or an empty array. */
function childrenOf(node: AdfNode): AdfNode[] {
  const raw = node.content;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: AdfNode[] = [];
  for (const child of raw) {
    if (isAdfNode(child)) {
      out.push(child);
    }
  }
  return out;
}

/** Flatten the inline text of a node (recursively concatenating every
 *  descendant `text` leaf). Used for headings, list items, task items. */
function flattenInlineText(node: AdfNode): string {
  if (node.type === 'text') {
    return typeof node.text === 'string' ? node.text : '';
  }
  let out = '';
  for (const child of childrenOf(node)) {
    out += flattenInlineText(child);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* adfToPlainText                                                      */
/* ------------------------------------------------------------------ */

/**
 * Walk an ADF document tree and emit a flat plain-text rendering.
 *
 * Block semantics:
 *   - `paragraph`            → children inline, trailing `\n`.
 *   - `heading`              → children wrapped with `\n` on each side.
 *   - `bulletList`           → each `listItem` becomes `- <text>\n`.
 *   - `orderedList`          → each `listItem` becomes `<n>. <text>\n` (1-indexed).
 *   - `listItem`             → children inline (typically a paragraph).
 *   - `taskList`             → emit each task item on its own line.
 *   - `taskItem`             → `[x] <text>` if `attrs.state === 'DONE'` else `[ ] <text>`.
 *   - `codeBlock`            → fenced ```lang\n...\n``` (`attrs.language` if present).
 *   - `rule`                 → `\n---\n`.
 *   - `text`                 → `node.text`.
 *   - Anything else          → walk children if any, otherwise skip silently.
 *
 * Output is trimmed and runs of three or more newlines are collapsed to two.
 * Returns `''` on malformed input — never throws.
 */
export function adfToPlainText(adf: unknown): string {
  if (!isAdfNode(adf)) {
    return '';
  }
  const raw = renderNode(adf);
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}

/** Recursive walker for `adfToPlainText`. */
function renderNode(node: AdfNode): string {
  switch (node.type) {
    case 'text':
      return typeof node.text === 'string' ? node.text : '';

    case 'paragraph': {
      let out = '';
      for (const child of childrenOf(node)) {
        out += renderNode(child);
      }
      return out + '\n';
    }

    case 'heading': {
      let out = '';
      for (const child of childrenOf(node)) {
        out += renderNode(child);
      }
      return '\n' + out + '\n';
    }

    case 'bulletList': {
      let out = '';
      for (const child of childrenOf(node)) {
        if (child.type === 'listItem') {
          const inner = renderListItemInline(child);
          out += '- ' + inner + '\n';
        }
      }
      return out;
    }

    case 'orderedList': {
      let out = '';
      let n = 1;
      for (const child of childrenOf(node)) {
        if (child.type === 'listItem') {
          const inner = renderListItemInline(child);
          out += n + '. ' + inner + '\n';
          n++;
        }
      }
      return out;
    }

    case 'listItem': {
      // When reached directly (not via the list cases above) inline its
      // children so we degrade gracefully.
      return renderListItemInline(node);
    }

    case 'taskList': {
      let out = '';
      for (const child of childrenOf(node)) {
        if (child.type === 'taskItem') {
          out += renderNode(child) + '\n';
        }
      }
      return out;
    }

    case 'taskItem': {
      const state = node.attrs && typeof node.attrs.state === 'string'
        ? node.attrs.state
        : '';
      const checkbox = state === 'DONE' ? '[x] ' : '[ ] ';
      let inner = '';
      for (const child of childrenOf(node)) {
        inner += renderNode(child);
      }
      return checkbox + inner.replace(/\n+$/g, '');
    }

    case 'codeBlock': {
      const lang = node.attrs && typeof node.attrs.language === 'string'
        ? node.attrs.language
        : '';
      let inner = '';
      for (const child of childrenOf(node)) {
        inner += renderNode(child);
      }
      const fenceOpen = lang ? '```' + lang : '```';
      return '\n' + fenceOpen + '\n' + inner.replace(/\n+$/g, '') + '\n```\n';
    }

    case 'rule':
      return '\n---\n';

    default: {
      // Unknown / unsupported types — walk children if any, otherwise skip.
      const kids = childrenOf(node);
      if (kids.length === 0) {
        return '';
      }
      let out = '';
      for (const child of kids) {
        out += renderNode(child);
      }
      return out;
    }
  }
}

/** Inline rendering of a `listItem`'s children — strips the trailing newline
 *  added by paragraph blocks so the caller can append its own line break. */
function renderListItemInline(node: AdfNode): string {
  let out = '';
  for (const child of childrenOf(node)) {
    out += renderNode(child);
  }
  return out.replace(/\n+$/g, '');
}

/* ------------------------------------------------------------------ */
/* adfExtractAcceptanceCriteria                                        */
/* ------------------------------------------------------------------ */

/**
 * Extract a candidate acceptance-criteria list from an ADF document.
 *
 * Heuristic, applied in order:
 *
 *   1. **taskList** — if any `taskList` exists, take the first one. Each
 *      `taskItem` becomes an `AcItem` with `initialState` mapped from
 *      `attrs.state` (`'DONE'` → `'done'`, anything else → `'todo'`).
 *
 *   2. **ac-heading-list** — otherwise, locate the first `heading` whose
 *      flattened text (case-insensitive) `includes` the supplied
 *      `headingMarker`. Collect every `bulletList` / `orderedList` that
 *      appears after that heading and before the next heading at the same
 *      depth — children become `AcItem`s with `initialState: 'todo'`.
 *
 *   3. **first-list** — otherwise, walk the tree for the first `bulletList`
 *      or `orderedList` anywhere and extract its children.
 *
 *   4. Empty fallback — `{ items: [], source: 'none' }`.
 *
 * Never throws; returns the empty fallback for any malformed input.
 */
export function adfExtractAcceptanceCriteria(
  adf: unknown,
  headingMarker: string,
): AcExtractResult {
  if (!isAdfNode(adf)) {
    return { items: [], source: 'none' };
  }

  // Branch 1 — first taskList found anywhere in the tree.
  const firstTaskList = findFirst(adf, (n) => n.type === 'taskList');
  if (firstTaskList) {
    const items: AcItem[] = [];
    for (const child of childrenOf(firstTaskList)) {
      if (child.type !== 'taskItem') {
        continue;
      }
      const state = child.attrs && typeof child.attrs.state === 'string'
        ? child.attrs.state
        : '';
      items.push({
        text: flattenInlineText(child).trim(),
        initialState: state === 'DONE' ? 'done' : 'todo',
      });
    }
    return { items, source: 'taskList' };
  }

  // Branch 2 — AC heading followed by one or more lists.
  // Only meaningful when the document's top-level `content` is an array we
  // can scan in order (ADF lists live as siblings of headings at the same
  // depth). We sweep every container in the tree to be flexible.
  const marker = headingMarker.toLowerCase();
  const headingItems = collectListsAfterHeading(adf, marker);
  if (headingItems !== null) {
    return { items: headingItems, source: 'ac-heading-list' };
  }

  // Branch 3 — first list anywhere.
  const firstList = findFirst(
    adf,
    (n) => n.type === 'bulletList' || n.type === 'orderedList',
  );
  if (firstList) {
    return {
      items: listItemsToAcItems(firstList),
      source: 'first-list',
    };
  }

  return { items: [], source: 'none' };
}

/** Depth-first search for the first node matching `pred`. */
function findFirst(
  node: AdfNode,
  pred: (n: AdfNode) => boolean,
): AdfNode | undefined {
  if (pred(node)) {
    return node;
  }
  for (const child of childrenOf(node)) {
    const hit = findFirst(child, pred);
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

/**
 * Walk every container in the tree looking for a sibling sequence:
 *   `[heading matching marker]  ...lists...  [next heading | end]`
 *
 * Returns the collected `AcItem`s or `null` if no matching heading exists.
 * An empty array (matching heading found but no following lists) is a
 * positive result — the caller should still report `source: 'ac-heading-list'`.
 */
function collectListsAfterHeading(
  root: AdfNode,
  markerLower: string,
): AcItem[] | null {
  // Stack of containers to scan; we look at each container's direct
  // children as a flat sibling sequence.
  const stack: AdfNode[] = [root];
  while (stack.length > 0) {
    const container = stack.pop();
    if (!container) {
      break;
    }
    const kids = childrenOf(container);

    // Pass 1 — find a matching heading at this depth.
    for (let i = 0; i < kids.length; i++) {
      const candidate = kids[i];
      if (
        candidate.type === 'heading' &&
        flattenInlineText(candidate).toLowerCase().includes(markerLower)
      ) {
        // Pass 2 — accumulate lists until the next heading (any level).
        const items: AcItem[] = [];
        for (let j = i + 1; j < kids.length; j++) {
          const sibling = kids[j];
          if (sibling.type === 'heading') {
            break;
          }
          if (
            sibling.type === 'bulletList' ||
            sibling.type === 'orderedList'
          ) {
            for (const item of listItemsToAcItems(sibling)) {
              items.push(item);
            }
          }
        }
        return items;
      }
    }

    // Descend into each child container so headings nested inside, e.g., a
    // `panel` node are still considered.
    for (const child of kids) {
      stack.push(child);
    }
  }
  return null;
}

/** Convert a `bulletList` / `orderedList` node into `AcItem`s. Every
 *  `listItem` child contributes one item with `initialState: 'todo'`. */
function listItemsToAcItems(listNode: AdfNode): AcItem[] {
  const out: AcItem[] = [];
  for (const child of childrenOf(listNode)) {
    if (child.type !== 'listItem') {
      continue;
    }
    out.push({
      text: flattenInlineText(child).trim(),
      initialState: 'todo',
    });
  }
  return out;
}
