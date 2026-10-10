/**
 * Text for the closed tag filter control (pure, so it is unit-testable).
 * The control is always ONE row: "All tags", the single tag name, or "N tags".
 */
export function tagFilterSummary(selectedNames: string[]): string {
  if (selectedNames.length === 0) return "All tags";
  if (selectedNames.length === 1) return selectedNames[0];
  return `${selectedNames.length} tags`;
}

/**
 * How many chips to show before collapsing the rest behind "+N more".
 * Returns the visible count and how many are hidden.
 */
export function splitChipsForDisplay(total: number, max: number, expanded: boolean): { visible: number; hidden: number } {
  if (expanded || total <= max) return { visible: total, hidden: 0 };
  return { visible: max, hidden: total - max };
}
