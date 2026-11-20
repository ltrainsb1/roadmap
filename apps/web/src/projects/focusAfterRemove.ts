/**
 * After a control removes itself, keeps keyboard focus in its list: on the remove button that took its place
 * (the next entry), else the one before it, else on `fallbackId` (the list's add field). Remove buttons carry
 * `data-list="{list}"`, in entry order.
 */
export function focusRemaining(root: ParentNode, list: string, index: number, fallbackId: string): void {
  const buttons = root.querySelectorAll<HTMLElement>(`[data-list="${list}"]`);
  const target = buttons[Math.min(index, buttons.length - 1)] ?? document.getElementById(fallbackId);
  target?.focus();
}
