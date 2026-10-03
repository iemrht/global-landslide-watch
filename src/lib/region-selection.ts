import L from 'leaflet';
import { editSelection, type ScreenBox, type ScreenPoint, type SelectionHandle } from './selection-geometry';

type Callbacks = {
  onChange: (bounds: L.LatLngBounds | null) => void;
  onDrawing: (drawing: boolean) => void;
  onStatus: (status: string) => void;
};
type Gesture = { id: number; start: ScreenPoint; box: ScreenBox; handle: SelectionHandle; original: L.LatLngBounds | null };

/** Pointer capture keeps an edit alive outside the map. No data layer is modified. */
export class RegionSelection {
  private map: L.Map;
  private callbacks: Callbacks;
  private container: HTMLElement;
  private overlay: HTMLDivElement;
  private bounds: L.LatLngBounds | null = null;
  private drawing = false;
  private gesture: Gesture | null = null;
  private suspended: Array<{ enable: () => void }> = [];
  private interactionsSuspended = false;
  private oldTouchAction = '';
  private suppressClick = false;
  private clickTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(map: L.Map, callbacks: Callbacks) {
    this.map = map; this.callbacks = callbacks; this.container = map.getContainer();
    this.overlay = document.createElement('div');
    this.overlay.className = 'region-selection'; this.overlay.hidden = true;
    this.overlay.setAttribute('data-selection-handle', 'move');
    this.overlay.title = '拖动选框内部移动；拖动边角调整大小';
    for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `region-handle region-handle-${handle}`;
      button.dataset.selectionHandle = handle;
      button.setAttribute('aria-label', `调整选区 ${handle.toUpperCase()} 边角（方向键微调）`);
      this.overlay.append(button);
    }
    const label = document.createElement('span'); label.className = 'region-selection-label';
    label.textContent = '拖动移动 · 边角调整'; this.overlay.append(label);
    this.container.append(this.overlay);
    this.container.addEventListener('pointerdown', this.down, true);
    this.container.addEventListener('pointermove', this.move, true);
    this.container.addEventListener('pointerup', this.up, true);
    this.container.addEventListener('pointercancel', this.cancelPointer, true);
    this.container.addEventListener('lostpointercapture', this.cancelPointer, true);
    this.container.addEventListener('click', this.click, true);
    window.addEventListener('keydown', this.key);
    window.addEventListener('blur', this.blur);
    map.on('move zoom resize', this.render);
  }

  toggleDrawing() {
    if (this.drawing) { this.cancel(); return; }
    this.drawing = true; this.callbacks.onDrawing(true);
    this.container.classList.add('is-selecting-export'); this.suspend();
    this.callbacks.onStatus('按住鼠标左键拖出矩形，松开完成；Esc 取消。已有选框会在新框完成后替换。');
  }
  setBounds(bounds: L.LatLngBounds | null) {
    this.cancel(false); this.bounds = bounds; this.render(); this.callbacks.onChange(bounds);
  }
  private suspend() {
    if (this.interactionsSuspended) return;
    this.interactionsSuspended = true;
    this.oldTouchAction = this.container.style.touchAction; this.container.style.touchAction = 'none';
    for (const handler of [this.map.dragging, this.map.boxZoom, this.map.doubleClickZoom, this.map.scrollWheelZoom, this.map.touchZoom, this.map.keyboard]) {
      if (handler?.enabled()) { handler.disable(); this.suspended.push(handler); }
    }
  }
  private restore() {
    if (!this.interactionsSuspended) return;
    this.interactionsSuspended = false;
    this.suspended.forEach((handler) => handler.enable()); this.suspended = [];
    this.container.style.touchAction = this.oldTouchAction;
  }
  private stopDrawing() {
    this.drawing = false; this.callbacks.onDrawing(false);
    this.container.classList.remove('is-selecting-export'); this.restore();
  }
  private point(event: PointerEvent) { return this.map.mouseEventToContainerPoint(event); }
  private box(): ScreenBox {
    if (!this.bounds) return { x: 0, y: 0, width: 0, height: 0 };
    const nw = this.map.latLngToContainerPoint(this.bounds.getNorthWest());
    const se = this.map.latLngToContainerPoint(this.bounds.getSouthEast());
    return { x: nw.x, y: nw.y, width: se.x - nw.x, height: se.y - nw.y };
  }
  private fromBox(box: ScreenBox) {
    const a = this.map.containerPointToLatLng([box.x, box.y]);
    const b = this.map.containerPointToLatLng([box.x + box.width, box.y + box.height]);
    // Mercator is undefined beyond this latitude; do not emit invalid export bounds.
    a.lat = Math.max(-85, Math.min(85, a.lat)); b.lat = Math.max(-85, Math.min(85, b.lat));
    return L.latLngBounds(a, b);
  }
  private consume(event: Event) { event.preventDefault(); event.stopImmediatePropagation(); }
  private down = (event: PointerEvent) => {
    if (!event.isPrimary || event.button !== 0 || this.gesture) return;
    const target = event.target as HTMLElement;
    const handle = target.closest<HTMLElement>('[data-selection-handle]')?.dataset.selectionHandle as SelectionHandle | undefined;
    if (!this.drawing && !handle) return;
    if (this.drawing && target.closest('.leaflet-control')) return;
    this.consume(event); this.suspend();
    this.gesture = { id: event.pointerId, start: this.point(event), box: this.box(), handle: this.drawing ? 'draw' : handle!, original: this.bounds };
    this.container.setPointerCapture(event.pointerId);
  };
  private move = (event: PointerEvent) => {
    const g = this.gesture; if (!g || g.id !== event.pointerId) return;
    this.consume(event);
    this.bounds = this.fromBox(editSelection(g.box, g.handle, g.start, this.point(event)));
    this.render();
  };
  private up = (event: PointerEvent) => {
    const g = this.gesture; if (!g || g.id !== event.pointerId) return;
    this.move(event);
    const box = this.box(), valid = box.width >= 12 && box.height >= 12;
    if (!valid) this.bounds = g.original;
    this.gesture = null;
    if (this.container.hasPointerCapture(g.id)) this.container.releasePointerCapture(g.id);
    this.suppressClick = true; clearTimeout(this.clickTimer);
    this.clickTimer = setTimeout(() => { this.suppressClick = false; }, 400);
    if (valid) {
      this.stopDrawing(); this.callbacks.onChange(this.bounds);
      this.callbacks.onStatus('范围已选定：拖动内部移动，拖动八个边角调整；选框外仍可平移地图。');
    } else {
      if (!this.drawing) this.restore();
      this.callbacks.onStatus('选框太小，原范围已保留。请拖出至少 12 × 12 屏幕像素的矩形。');
    }
    this.render();
  };
  private click = (event: MouseEvent) => {
    if (this.suppressClick || this.drawing || (event.target as HTMLElement).closest('.region-selection')) this.consume(event);
  };
  private cancelPointer = (event: PointerEvent) => { if (this.gesture?.id === event.pointerId) this.cancel(); };
  private blur = () => { if (this.gesture || this.drawing) this.cancel(); };
  private key = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && (this.gesture || this.drawing)) { this.consume(event); this.cancel(); return; }
    const handle = (event.target as HTMLElement)?.dataset?.selectionHandle as SelectionHandle | undefined;
    if (!handle || !this.bounds || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    this.consume(event);
    const step = event.shiftKey ? 10 : 1, box = this.box();
    const p = { x: event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, y: event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0 };
    const edited = editSelection(box, handle, { x: 0, y: 0 }, p);
    if (edited.width >= 12 && edited.height >= 12) { this.bounds = this.fromBox(edited); this.render(); this.callbacks.onChange(this.bounds); }
  };
  cancel(report = true) {
    const g = this.gesture;
    if (g) { this.bounds = g.original; this.gesture = null; if (this.container.hasPointerCapture(g.id)) this.container.releasePointerCapture(g.id); }
    this.stopDrawing(); this.render();
    if (report) this.callbacks.onStatus('操作已取消，原导出范围保留。');
  }
  private render = () => {
    this.overlay.hidden = !this.bounds;
    if (!this.bounds) return;
    const box = this.box();
    Object.assign(this.overlay.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
  };
  destroy() {
    this.cancel(false); clearTimeout(this.clickTimer);
    this.container.removeEventListener('pointerdown', this.down, true);
    this.container.removeEventListener('pointermove', this.move, true);
    this.container.removeEventListener('pointerup', this.up, true);
    this.container.removeEventListener('pointercancel', this.cancelPointer, true);
    this.container.removeEventListener('lostpointercapture', this.cancelPointer, true);
    this.container.removeEventListener('click', this.click, true);
    window.removeEventListener('keydown', this.key); window.removeEventListener('blur', this.blur);
    this.map.off('move zoom resize', this.render); this.overlay.remove();
  }
}
