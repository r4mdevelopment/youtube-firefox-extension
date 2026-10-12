export function placeQualityMenu(anchor, menu, viewport) {
  const below = Math.max(0, viewport.height - anchor.bottom - 20);
  const above = Math.max(0, anchor.top - 20);
  const upward = below < menu.height && above > below;
  const maxHeight = Math.max(40, upward ? above : below);
  const height = Math.min(menu.height, maxHeight);
  return { left: Math.max(12, Math.min(anchor.left, viewport.width - menu.width - 12)),
    top: Math.max(12, upward ? anchor.top - height - 8 : anchor.bottom + 8), maxHeight };
}
