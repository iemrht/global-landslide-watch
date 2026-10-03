export type ScreenPoint = { x: number; y: number };
export type ScreenBox = ScreenPoint & { width: number; height: number };
export type SelectionHandle = 'draw' | 'move' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export function boxFromPoints(a: ScreenPoint, b: ScreenPoint): ScreenBox {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

// Work in projected screen coordinates: movement preserves the map-frame shape.
// Crossing the opposite edge is allowed; normalization keeps a valid rectangle.
export function editSelection(box: ScreenBox, handle: SelectionHandle, start: ScreenPoint, point: ScreenPoint): ScreenBox {
  if (handle === 'draw') return boxFromPoints(start, point);
  const dx = point.x - start.x, dy = point.y - start.y;
  if (handle === 'move') return { ...box, x: box.x + dx, y: box.y + dy };
  let left = box.x, right = box.x + box.width, top = box.y, bottom = box.y + box.height;
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  return boxFromPoints({ x: left, y: top }, { x: right, y: bottom });
}
