/**
 * In-transcript find highlighting.
 *
 * Content search tells us which message holds the Nth hit; this module finds
 * that text in the rendered DOM so the hit itself can be scrolled to and
 * marked. Marks use the CSS Custom Highlight API, which paints ranges without
 * touching the DOM React owns. Browsers without it still get range-precise
 * scrolling; the caller falls back to flashing the message row.
 */

const ALL_MATCHES_HIGHLIGHT = "yep-search-match";
const CURRENT_MATCH_HIGHLIGHT = "yep-search-current";

/** Bound the work done per paint on very long transcripts. */
const MAX_RANGES = 2_000;

const SKIPPED_CONTAINERS =
  "script,style,noscript,textarea,input,select,[data-search-skip]";

export function supportsSearchHighlights(): boolean {
  return (
    typeof CSS !== "undefined" &&
    "highlights" in CSS &&
    typeof Highlight !== "undefined"
  );
}

/**
 * Case-insensitive occurrences of `query` in the visible text under `root`,
 * in document order. Matches may span inline elements (bold, links, code).
 */
export function findTextRanges(
  root: Node,
  query: string,
  limit = MAX_RANGES,
): Range[] {
  const doc = root.ownerDocument ?? document;
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_SKIP;
      return node.parentElement?.closest(SKIPPED_CONTAINERS)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push(textNode);
    starts.push(text.length);
    text += textNode.data;
  }
  if (!text || !query) return [];

  // Lowercasing can change length for a few code points; offsets must stay
  // aligned with the DOM, so fall back to an exact-case search then.
  const lowered = text.toLowerCase();
  const caseFolded = lowered.length === text.length;
  const haystack = caseFolded ? lowered : text;
  const needle = caseFolded ? query.toLowerCase() : query;

  const locate = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  const ranges: Range[] = [];
  let from = 0;
  while (ranges.length < limit) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) break;
    const end = index + needle.length;
    const startNode = locate(index);
    const endNode = locate(end - 1);
    const startText = nodes[startNode];
    const endText = nodes[endNode];
    if (startText && endText) {
      const range = doc.createRange();
      range.setStart(startText, index - (starts[startNode] ?? 0));
      range.setEnd(endText, end - (starts[endNode] ?? 0));
      ranges.push(range);
    }
    from = end;
  }
  return ranges;
}

export function clearSearchHighlights(): void {
  if (!supportsSearchHighlights()) return;
  CSS.highlights.delete(ALL_MATCHES_HIGHLIGHT);
  CSS.highlights.delete(CURRENT_MATCH_HIGHLIGHT);
}

/**
 * Mark every hit under `root` and the current one inside `currentElement`.
 * Returns the current hit's range (clamped to the last hit in that element)
 * even when the browser cannot paint highlights.
 */
export function paintSearchHighlights(
  root: Element,
  query: string,
  current: { element: Element; occurrence: number } | null,
): Range | null {
  const currentRanges = current ? findTextRanges(current.element, query) : [];
  const currentRange =
    currentRanges[
      Math.min(Math.max(0, current?.occurrence ?? 0), currentRanges.length - 1)
    ] ?? null;
  if (!supportsSearchHighlights()) return currentRange;

  const all = findTextRanges(root, query);
  CSS.highlights.set(ALL_MATCHES_HIGHLIGHT, new Highlight(...all));
  if (currentRange) {
    const highlight = new Highlight(currentRange);
    highlight.priority = 1;
    CSS.highlights.set(CURRENT_MATCH_HIGHLIGHT, highlight);
  } else {
    CSS.highlights.delete(CURRENT_MATCH_HIGHLIGHT);
  }
  return currentRange;
}

/**
 * Center `range` in the scroll `container`. Returns false when the range has
 * no layout box (e.g. inside a collapsed block) so callers can fall back.
 */
export function scrollRangeIntoView(
  container: HTMLElement,
  range: Range,
): boolean {
  if (typeof range.getBoundingClientRect !== "function") return false;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const box = container.getBoundingClientRect();
  const delta = rect.top + rect.height / 2 - (box.top + box.height / 2);
  container.scrollTop += delta;
  return true;
}
