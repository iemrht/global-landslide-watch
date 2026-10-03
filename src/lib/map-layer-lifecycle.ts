import type L from 'leaflet';

/** Leaflet's remove event detaches map listeners; never erase it before removal. */
export function detachMapLayer(map: Pick<L.Map, 'removeLayer'>, layer: L.Layer) {
  map.removeLayer(layer);
  layer.off();
}
