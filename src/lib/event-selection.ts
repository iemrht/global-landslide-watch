export type EventSelectionSource = 'map' | 'list' | 'system';

export function revealCountForEvent(currentCount: number, eventIndex: number) {
  if (!Number.isInteger(eventIndex) || eventIndex < 0) return currentCount;
  return Math.max(currentCount, eventIndex + 1);
}

export function focusZoom(currentZoom: number, minimumZoom = 6) {
  return Number.isFinite(currentZoom) ? Math.max(currentZoom, minimumZoom) : minimumZoom;
}

export function markerPresentation(magnitude: number, selected: boolean) {
  const baseRadius = Math.max(4, Math.min(11, 4 + (magnitude - 6) * 2.5));
  return {
    radius: selected ? baseRadius + 2 : baseRadius,
    haloRadius: baseRadius + 8,
    fillOpacity: selected ? 1 : 0.78,
    weight: selected ? 3 : 1,
  };
}
