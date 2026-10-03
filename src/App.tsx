import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { writeArrayBuffer } from 'geotiff';
import {
  Activity,
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleHelp,
  Crop,
  Database,
  Download,
  Earth,
  FileImage,
  Filter,
  Layers3,
  LocateFixed,
  MapPinned,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Mountain,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EventBrief } from '@/components/event-brief';
import { fetchUsgs, verifiedImageUrl, liveBasemapSources, type LiveBasemap } from '@/lib/data-access';
import { readRemoteRaster, clearRemoteRasterCache } from '@/lib/remote-raster';
import { applyVerifiedEventName, eventNameLabel, type EventNameKind } from '@/lib/event-names';
import { detachMapLayer } from '@/lib/map-layer-lifecycle';
import { focusZoom, markerPresentation, revealCountForEvent, type EventSelectionSource } from '@/lib/event-selection';
import { RegionSelection } from '@/lib/region-selection';
import { posterPdf } from '@/lib/report-download';
import { satelliteLayout, satelliteGeoTiff } from '@/lib/satellite-geotiff';
import { renderRiskPoster, renderRasterView, mercatorLatitude, mapCoordinate, type DisplayMode, type Rgba } from '@/lib/map-presentation';

const USGS_QUERY = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const USGS_DETAIL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail';
const AUTO_REFRESH_MS = 60_000;
const INITIAL_VISIBLE_EVENTS = 500;
// USGS Ground Failure 主滑坡模型：Nowicki Jessee et al. (2018)。
// 按前缀匹配而不写死完整文件名，排除不确定度等附属文件。
const OFFICIAL_MODEL_PREFIX = 'jessee_2018';
const AUXILIARY_KEY = /std|sd_|_sd|beta|unc|sigma|hazard_alert|population/i;
function officialContentKey(contents: Record<string, UsgsContent> | undefined, extension: '.tif' | '.png') {
  if (!contents) return undefined;
  const preferred = `${OFFICIAL_MODEL_PREFIX}_model${extension}`;
  if (contents[preferred]) return preferred;
  return Object.keys(contents)
    .filter((key) => key.startsWith(OFFICIAL_MODEL_PREFIX) && key.endsWith(extension) && !AUXILIARY_KEY.test(key))
    .sort((a, b) => a.length - b.length)[0];
}
function officialContent(product: UsgsProduct | undefined, extension: '.tif' | '.png') {
  const key = officialContentKey(product?.contents, extension);
  return key ? product!.contents[key] : undefined;
}
const SATELLITE_ATTRIBUTION = 'Esri, Vantor/Maxar, Earthstar Geographics, and the GIS User Community';
type ExportBasemap = 'satellite' | 'standard';
const EXPORT_BASEMAPS: Record<ExportBasemap, { label: string; tileUrl: (zoom: number, y: number, x: number) => string; attribution: string; filename: string }> = {
  satellite: {
    label: '卫星影像',
    tileUrl: (zoom, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`,
    attribution: `卫星影像：Esri World Imagery | ${SATELLITE_ATTRIBUTION}`,
    filename: 'satellite',
  },
  standard: {
    label: '标准地图',
    tileUrl: (zoom, y, x) => `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`,
    attribution: '标准地图：© OpenStreetMap contributors | 道路、地名与行政边界',
    filename: 'standard_map',
  },
};

type WebMcpContext = {
  registerTool: (
    tool: {
      name: string;
      title?: string;
      description: string;
      inputSchema: object;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
      execute: (input: unknown) => unknown | Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

declare global {
  interface Document {
    readonly modelContext?: WebMcpContext;
  }
}

type EarthquakeFeature = {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number, number] };
  properties: {
    mag: number;
    place: string;
    time: number;
    updated: number;
    status: string;
    title: string;
    alert: string | null;
    tsunami: number;
    sig: number;
    type: string;
    types?: string;
    url: string;
    magType?: string;
    net?: string;
    catalogAgency?: string;
    catalogNote?: string;
    catalogSourceUrl?: string;
    originalPlace?: string;
    eventAliases?: string;
    eventNameSourceUrl?: string;
    eventNameKind?: EventNameKind;
    ids?: string;
  };
};

type UsgsContent = {
  url: string;
  contentType: string;
  length: number;
  lastModified: number;
};

type UsgsProduct = {
  source: string;
  updateTime: number;
  status: string;
  preferredWeight?: number;
  properties: Record<string, string>;
  contents: Record<string, UsgsContent>;
};

type EventDetail = EarthquakeFeature & {
  properties: EarthquakeFeature['properties'] & {
    products?: Record<string, UsgsProduct[]>;
    mmi?: number;
    felt?: number;
  };
};

type RasterData = {
  data: ArrayLike<number>;
  width: number;
  height: number;
  bbox: [number, number, number, number];
  noData: number | null;
  name: string;
};

type RegionKey = 'global' | 'eastAsia' | 'oceania' | 'americas' | 'europe';

const REGIONS: Record<RegionKey, { label: string; bounds?: [number, number, number, number] }> = {
  global: { label: '全球' },
  eastAsia: { label: '东亚与东南亚', bounds: [90, -12, 155, 55] },
  oceania: { label: '大洋洲', bounds: [105, -52, 180, 5] },
  americas: { label: '美洲', bounds: [-180, -60, -30, 75] },
  europe: { label: '欧洲与地中海', bounds: [-25, 25, 50, 72] },
};

// 分档与液化站一致，便于两站对照；如需与 USGS 滑坡图例完全一致，只需改这里和 probabilityRgba。
const PROBABILITY_FLOOR = 0.001;
const PROBABILITY_FLOOR_LABEL = '0.1%';
const PROBABILITY_STOPS = [
  { min: 0.3, color: '#9c1537', label: '≥ 30%' },
  { min: 0.1, color: '#dc3e45', label: '10–30%' },
  { min: 0.03, color: '#f47b55', label: '3–10%' },
  { min: 0.01, color: '#f8bd72', label: '1–3%' },
  { min: 0.001, color: '#fff0ad', label: '0.1–1%' },
];

type VerifiedEventOverride = {
  magnitude: number;
  magnitudeType: string;
  place: string;
  coordinates: [number, number, number];
  agency: string;
  note: string;
  sourceUrl: string;
};

// Events whose regional authoritative magnitude crosses the M6 collection threshold
// even when the USGS preferred magnitude does not. Values remain source-labelled in the UI.
const VERIFIED_EVENT_OVERRIDES: Record<string, VerifiedEventOverride> = {
  us7000ljvg: {
    magnitude: 6.2,
    magnitudeType: 'M',
    place: '甘肃临夏州积石山县',
    coordinates: [102.79, 35.70, 10],
    agency: '中国地震台网',
    note: '中国地震台网 M6.2；USGS 产品目录 Mw5.9（us7000ljvg）',
    sourceUrl: 'https://www.ahdzj.gov.cn/content/detail/65806f15dcface7ea3d8b6e3.html',
  },
};

function toDateInput(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateYearsAgo(years: number) {
  const value = new Date();
  value.setUTCFullYear(value.getUTCFullYear() - years);
  return toDateInput(value);
}

function normalizeCatalogEvent(event: EarthquakeFeature): EarthquakeFeature {
  event = applyVerifiedEventName(event);
  const override = VERIFIED_EVENT_OVERRIDES[event.id];
  if (!override) {
    return {
      ...event,
      properties: {
        ...event.properties,
        catalogAgency: 'USGS ComCat',
        catalogNote: `${event.properties.magType?.toUpperCase() ?? 'M'} ${event.properties.mag.toFixed(1)} · ${event.properties.status === 'reviewed' ? '已复核' : '自动解算'}`,
      },
    };
  }
  return {
    ...event,
    geometry: { ...event.geometry, coordinates: override.coordinates },
    properties: {
      ...event.properties,
      mag: override.magnitude,
      magType: override.magnitudeType,
      place: event.properties.place,
      title: `M ${override.magnitude.toFixed(1)} - ${event.properties.place}`,
      catalogAgency: override.agency,
      catalogNote: override.note,
      catalogSourceUrl: override.sourceUrl,
    },
  };
}

function chooseProduct(products?: UsgsProduct[]) {
  return products
    ?.filter((product) => product.status !== 'DELETE')
    .sort((a, b) => (b.preferredWeight ?? 0) - (a.preferredWeight ?? 0))[0];
}

function isGroundFailureEvent(event: EarthquakeFeature) {
  return event.properties.types?.includes('ground-failure') ?? false;
}

function eventColor(event: EarthquakeFeature) {
  if (isGroundFailureEvent(event)) return '#f05b57';
  if (event.properties.mag >= 7.5) return '#ffb84d';
  return '#79c9ba';
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value));
}

function probabilityRgba(value: number): [number, number, number, number] {
  if (!Number.isFinite(value) || value < PROBABILITY_FLOOR || value > 1) return [0, 0, 0, 0];
  if (value >= 0.3) return [156, 21, 55, 235];
  if (value >= 0.1) return [220, 62, 69, 225];
  if (value >= 0.03) return [244, 123, 85, 215];
  if (value >= 0.01) return [248, 189, 114, 205];
  return [255, 240, 173, 185];
}

function canvasForRaster(
  raster: RasterData,
  transform: (value: number, x: number, y: number) => number,
  color: (value: number) => [number, number, number, number],
) {
  const canvas = document.createElement('canvas');
  canvas.width = raster.width;
  canvas.height = raster.height;
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) throw new Error('浏览器无法创建地图画布。');
  const image = context.createImageData(raster.width, raster.height);
  const values = new Float32Array(raster.width * raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const source = Number(raster.data[y * raster.width + x]);
      const invalid = raster.noData !== null && source === raster.noData;
      const transformed = invalid ? Number.NaN : transform(source, x, y);
      values[y * raster.width + x] = transformed;
      const [red, green, blue, alpha] = invalid ? [0, 0, 0, 0] : color(transformed);
      const offset = (y * raster.width + x) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = alpha;
    }
  }
  context.putImageData(image, 0, 0);
  return {
    canvas,
    raster: { ...raster, data: values, noData: Number.NaN },
  };
}

function cropRaster(raster: RasterData, bounds: L.LatLngBounds): RasterData {
  const [xmin, ymin, xmax, ymax] = raster.bbox;
  const west = Math.max(xmin, bounds.getWest());
  const east = Math.min(xmax, bounds.getEast());
  const south = Math.max(ymin, bounds.getSouth());
  const north = Math.min(ymax, bounds.getNorth());
  if (!(west < east && south < north)) throw new Error('框选范围与当前栅格没有重叠。');

  const pixelWidth = (xmax - xmin) / raster.width;
  const pixelHeight = (ymax - ymin) / raster.height;
  const x0 = clamp(Math.floor((west - xmin) / pixelWidth), 0, raster.width - 1);
  const x1 = clamp(Math.ceil((east - xmin) / pixelWidth), x0 + 1, raster.width);
  const y0 = clamp(Math.floor((ymax - north) / pixelHeight), 0, raster.height - 1);
  const y1 = clamp(Math.ceil((ymax - south) / pixelHeight), y0 + 1, raster.height);
  const width = x1 - x0;
  const height = y1 - y0;
  if (width * height > 50_000_000) throw new Error('所选区域超过 5000 万像元，请缩小范围后导出。');

  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const source = Number(raster.data[(y0 + y) * raster.width + x0 + x]);
      data[y * width + x] = raster.noData !== null && source === raster.noData ? Number.NaN : source;
    }
  }
  return {
    data,
    width,
    height,
    bbox: [
      xmin + x0 * pixelWidth,
      ymax - y1 * pixelHeight,
      xmin + x1 * pixelWidth,
      ymax - y0 * pixelHeight,
    ],
    noData: Number.NaN,
    name: raster.name,
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportStem(eventId: string | null) {
  return `landslide_${eventId ?? 'event'}_official_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
}

function mercatorX(longitude: number) {
  return (longitude + 180) / 360;
}

function mercatorY(latitude: number) {
  const limited = clamp(latitude, -85.05112878, 85.05112878);
  const radians = limited * Math.PI / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}

function inverseMercatorY(value: number) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * value))) * 180 / Math.PI;
}

function niceScaleDistance(metres: number) {
  const exponent = 10 ** Math.floor(Math.log10(Math.max(metres, 1)));
  const fraction = metres / exponent;
  const nice = fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1;
  return nice * exponent;
}

function haversineDistance(longitudeA: number, latitudeA: number, longitudeB: number, latitudeB: number) {
  const radius = 6_371_008.8;
  const toRadians = Math.PI / 180;
  const dLat = (latitudeB - latitudeA) * toRadians;
  const dLon = (longitudeB - longitudeA) * toRadians;
  const latA = latitudeA * toRadians;
  const latB = latitudeB * toRadians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(value)));
}

function drawWrappedText(context: CanvasRenderingContext2D, textValue: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines = 3) {
  const characters = Array.from(textValue);
  const lines: string[] = [];
  let current = '';
  for (const character of characters) {
    const candidate = current + character;
    if (current && context.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = character;
      if (lines.length === maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  const consumed = lines.join('').length;
  const remainder = characters.slice(consumed).join('');
  if (remainder) lines.push(remainder);
  lines.slice(0, maxLines).forEach((line, index) => context.fillText(line, x, y + index * lineHeight, maxWidth));
  return Math.min(lines.length, maxLines);
}

async function drawBasemapTiles(
  context: CanvasRenderingContext2D,
  bounds: L.LatLngBounds,
  x: number,
  y: number,
  width: number,
  height: number,
  basemapMode: ExportBasemap,
  onProgress?: (complete: number, total: number) => void,
) {
  const basemap = EXPORT_BASEMAPS[basemapMode];
  const west = mercatorX(bounds.getWest());
  const east = mercatorX(bounds.getEast());
  const north = mercatorY(bounds.getNorth());
  const south = mercatorY(bounds.getSouth());
  const spanX = east - west;
  const spanY = south - north;
  if (!(spanX > 0 && spanY > 0)) throw new Error('当前框选范围无法转换为卫星图坐标。');
  const ideal = Math.floor(Math.log2(Math.min(width / (spanX * 256), height / (spanY * 256))));
  const zoom = clamp(ideal, 0, 18);
  const worldSize = 256 * 2 ** zoom;
  const left = west * worldSize;
  const right = east * worldSize;
  const top = north * worldSize;
  const bottom = south * worldSize;
  const firstX = Math.floor(left / 256);
  const lastX = Math.floor((right - 0.0001) / 256);
  const firstY = Math.floor(top / 256);
  const lastY = Math.floor((bottom - 0.0001) / 256);
  const tiles: Array<{ tileX: number; tileY: number }> = [];
  for (let tileY = firstY; tileY <= lastY; tileY += 1) {
    for (let tileX = firstX; tileX <= lastX; tileX += 1) tiles.push({ tileX, tileY });
  }
  if (tiles.length > 400) throw new Error('卫星影像瓦片超过 400 张，请缩小范围或降低输出分辨率。');
  // Assemble at native integer tile coordinates before one continuous crop/scale.
  // Drawing each tile at fractional destination edges leaves translucent seams.
  const mosaic=document.createElement('canvas');
  mosaic.width=(lastX-firstX+1)*256;
  mosaic.height=(lastY-firstY+1)*256;
  const mosaicContext=mosaic.getContext('2d');
  if(!mosaicContext)throw new Error('无法创建底图拼接画布');
  let completed = 0;
  for (let index = 0; index < tiles.length; index += 8) {
    const group = tiles.slice(index, index + 8);
    const images = await Promise.all(group.map(async ({ tileX, tileY }) => {
      const wrappedX = ((tileX % 2 ** zoom) + 2 ** zoom) % 2 ** zoom;
      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(basemap.tileUrl(zoom, tileY, wrappedX), { cache: 'force-cache' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await createImageBitmap(await response.blob());
        } catch (error) {
          lastError = error;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      const detail = lastError instanceof Error ? lastError.message : '未知网络错误';
      throw new Error(`${basemap.label}底图瓦片加载失败（z${zoom}/${wrappedX}/${tileY}）：${detail}`);
    }));
    images.forEach((image, imageIndex) => {
      const { tileX, tileY } = group[imageIndex];
      mosaicContext.drawImage(
        image,
        (tileX-firstX)*256,
        (tileY-firstY)*256,
        256,
        256,
      );
      image.close();
      completed += 1;
      onProgress?.(completed, tiles.length);
    });
  }
  context.drawImage(mosaic,left-firstX*256,top-firstY*256,right-left,bottom-top,x,y,width,height);
  mosaic.width=0;mosaic.height=0;
  return zoom;
}

function mapBoundsForRaster(raster: RasterData): L.LatLngBoundsExpression {
  return [
    [raster.bbox[1], raster.bbox[0]],
    [raster.bbox[3], raster.bbox[2]],
  ];
}

function formatUtc(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp) + ' UTC';
}

function formatChineseDate(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日`;
}

function renderMapRaster(raster: RasterData, mode: DisplayMode, color: (value: number) => Rgba) {
  const [west, south, east, north] = raster.bbox;
  const aspect = (mercatorLatitude(south) - mercatorLatitude(north)) / ((east - west) / 360);
  const width = Math.min(2400, Math.max(1200, raster.width * 3));
  const height = Math.max(1, Math.round(width * aspect));
  const factor = Math.min(1, Math.sqrt(4_000_000 / (width * height)));
  return renderRasterView(raster, raster.bbox, Math.max(1, Math.round(width * factor)), Math.max(1, Math.round(height * factor)), mode, color);
}

async function createRiskMapPoster(options: {
  raster: RasterData; bounds: L.LatLngBounds; posterWidth: number;
  layerLabel: string; event: EarthquakeFeature;
  overlayOpacity: number; basemapMode: ExportBasemap; displayMode: DisplayMode; reportNotes: string;
  onProgress: (message: string) => void;
}) {
  const { raster, bounds, posterWidth, layerLabel, event, overlayOpacity, basemapMode, displayMode, onProgress } = options;
  const basemap = EXPORT_BASEMAPS[basemapMode];
  const legend = PROBABILITY_STOPS.map((stop) => ({ color: stop.color, label: stop.label }));
  const result = await renderRiskPoster({
    raster, width: posterWidth, bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
    title: `${formatChineseDate(event.properties.time)}（UTC）  M${event.properties.mag.toFixed(1)} 地震滑坡概率分布图`,
    place: event.properties.place,
    subtitle: `${layerLabel} · ${basemap.label}底图 · WGS 84`,
    legendTitle: '滑坡概率图例',
    legend,
    description: `${formatUtc(event.properties.time)}，${event.properties.place} 发生 ${event.properties.magType ?? 'M'} ${event.properties.mag.toFixed(1)} 级地震，震源深度 ${event.geometry.coordinates[2].toFixed(1)} km。震中位于 ${mapCoordinate(event.geometry.coordinates[1], 'lat', 4)}、${mapCoordinate(event.geometry.coordinates[0], 'lon', 4)}。本图展示所选区域 USGS 官方模型估计的地震滑坡发生概率空间分布。颜色由浅黄至深红表示概率逐级增大；概率分级不代表实测滑坡边界或已确认灾情。`,
    notes: options.reportNotes.trim(),
    eventLines: [
      `事件：${event.properties.place}（${event.id}）`,
      `时间：${formatUtc(event.properties.time)}`,
      `震级：${event.properties.magType ?? 'M'} ${event.properties.mag.toFixed(1)}；来源：${event.properties.catalogAgency ?? 'USGS ComCat'}`,
      `震中：${mapCoordinate(event.geometry.coordinates[1], 'lat', 4)}，${mapCoordinate(event.geometry.coordinates[0], 'lon', 4)}；深度 ${event.geometry.coordinates[2].toFixed(1)} km`,
      `范围：${mapCoordinate(bounds.getWest(), 'lon', 4)}–${mapCoordinate(bounds.getEast(), 'lon', 4)}；${mapCoordinate(bounds.getSouth(), 'lat', 4)}–${mapCoordinate(bounds.getNorth(), 'lat', 4)}`,
    ],
    methodLines: [
      `当前图层：${layerLabel}`,
      `原生栅格：${raster.width} × ${raster.height} 像元；${raster.name}`,
      displayMode === 'smooth' ? '成图：双线性显示平滑；不提高数据实际分辨率，分析栅格数值及 NoData 不变。' : '成图：原生像元显示；分析栅格数值及 NoData 不变。',
      `变量：滑坡概率 0–1；低于 ${PROBABILITY_FLOOR_LABEL} 的区域透明。`,
      '模型来源：USGS Ground Failure 当前事件已发布产品，主滑坡模型 Nowicki Jessee et al. (2018)。',
      `生成时间：${formatUtc(Date.now())}`,
    ],
    attribution: `${basemap.attribution}。底图及成图投影：Web Mercator（EPSG:3857）；输入及 GeoTIFF：WGS 84（EPSG:4326）。`,
    epicentre: [event.geometry.coordinates[0], event.geometry.coordinates[1]],
    opacity: overlayOpacity, displayMode, color: probabilityRgba,
    paintBasemap: (context, box) => drawBasemapTiles(context, bounds, box.x, box.y, box.width, box.height, basemapMode, (done, total) => {
      if (done === total || done % 16 === 0) onProgress(`正在拼接${basemap.label} ${done}/${total}…`);
    }),
    onProgress,
  });
  return result.canvas;
}

function Dashboard() {
  const [displayMode, setDisplayMode] = useState<DisplayMode>('smooth');
  const [startDate, setStartDate] = useState('2000-01-01');
  const [endDate, setEndDate] = useState(toDateInput(new Date()));
  const [region, setRegion] = useState<RegionKey>('global');
  const [searchText, setSearchText] = useState('');
  const [events, setEvents] = useState<EarthquakeFeature[]>([]);
  const [visibleEventCount, setVisibleEventCount] = useState(INITIAL_VISIBLE_EVENTS);
  const [loadingEvents, setLoadingEvents] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [lastCatalogUpdate, setLastCatalogUpdate] = useState<number | null>(null);
  const [newEventCount, setNewEventCount] = useState(0);
  const [rapidEventId, setRapidEventId] = useState<string | null>(null);
  const [rapidStatus, setRapidStatus] = useState('正在建立 M≥6.0 实时监测基线');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [opacity, setOpacity] = useState(0.78);
  const [layerStatus, setLayerStatus] = useState('请选择一个地震');
  const [layerError, setLayerError] = useState('');
  const [loadRevision, setLoadRevision] = useState(0);
  const [basemapStatus, setBasemapStatus] = useState('底图加载中…');
  const [liveBasemap, setLiveBasemap] = useState<LiveBasemap>('street');
  const liveBasemapRef = useRef<LiveBasemap>('street');
  const baseRestartRef = useRef<() => void>(() => {});
  const [exportBounds, setExportBounds] = useState<L.LatLngBounds | null>(null);
  const [satelliteSize,setSatelliteSize]=useState(4096);
  async function exportSatelliteRaster(){
    if(!exportBounds||exporting)return;
    setExporting(true);setExportStatus('正在读取选区卫星底图…');
    try {
      const bounds=L.latLngBounds(exportBounds.getSouthWest(),exportBounds.getNorthEast());
      const layout=satelliteLayout([bounds.getWest(),bounds.getSouth(),bounds.getEast(),bounds.getNorth()],satelliteSize);
      const canvas=document.createElement('canvas');canvas.width=layout.width;canvas.height=layout.height;
      const context=canvas.getContext('2d');if(!context)throw new Error('无法创建卫星栅格');
      const zoom=await drawBasemapTiles(context,bounds,0,0,layout.width,layout.height,'satellite',(done,total)=>setExportStatus(`读取卫星底图 ${done}/${total}`));
      const result=satelliteGeoTiff(context.getImageData(0,0,layout.width,layout.height).data,layout,zoom,SATELLITE_ATTRIBUTION);
      downloadBlob(result,`${selectedId??'region'}_satellite_RGB_EPSG3857.tif`);
      setExportStatus(`卫星底图已导出：${layout.width}×${layout.height}，EPSG:3857；不含概率、图例或标注。影像采集年代不固定，非震后实测。`);
    }catch(error){setExportStatus(error instanceof Error?error.message:String(error));}
    finally{setExporting(false);}
  }

  const [selectingExport, setSelectingExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [reportNotes, setReportNotes] = useState('');
  const [posterWidth, setPosterWidth] = useState(3600);
  const [exportBasemap, setExportBasemap] = useState<ExportBasemap>('satellite');
  const [exportStatus, setExportStatus] = useState('先框选范围或采用当前地图视窗');
  const [activeRasterName, setActiveRasterName] = useState('');
  const [viewportOnly, setViewportOnly] = useState(false);
  const [viewportBounds, setViewportBounds] = useState<L.LatLngBounds | null>(null);
  const viewportOnlyRef = useRef(false);
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<L.LayerGroup | null>(null);
  const overlayRef = useRef<L.Layer | null>(null);
  const exportEditorRef = useRef<RegionSelection | null>(null);
  const activeExportRasterRef = useRef<RasterData | null>(null);
  const knownEventIdsRef = useRef<Set<string> | null>(null);
  const eventItemRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingListRevealRef = useRef<string | null>(null);
  const selectionSourceRef = useRef<EventSelectionSource>('system');

  const fetchEvents = useCallback(async (reason: 'range' | 'manual' | 'auto' = 'manual') => {
    if (reason !== 'auto') setLoadingEvents(true);
    setEventsError('');
    try {
      const params = new URLSearchParams({
        format: 'geojson',
        eventtype: 'earthquake',
        minmagnitude: '5.8',
        starttime: startDate,
        endtime: `${endDate}T23:59:59.999Z`,
        orderby: 'time',
        limit: '20000',
      });
      const response = await fetchUsgs(`${USGS_QUERY}?${params}`);
      if (!response.ok) throw new Error(`USGS 返回 ${response.status}`);
      const collection = await response.json() as { features: EarthquakeFeature[] };
      const normalized = collection.features
        .map(normalizeCatalogEvent)
        // Hide unresolved source-name corruption from every catalog view; keep valid names without GF products.
        .filter((event) => event.properties.mag >= 6 && event.properties.eventNameKind !== 'source-text-warning');
      const previousIds = knownEventIdsRef.current;
      const newlyArrived = reason === 'auto' && previousIds
        ? normalized.filter((event) => !previousIds.has(event.id))
        : [];
      knownEventIdsRef.current = new Set(normalized.map((event) => event.id));
      setEvents(normalized);
      setLastCatalogUpdate(Date.now());
      if (newlyArrived.length) {
        const newest = newlyArrived[0];
        setNewEventCount(newlyArrived.length);
        setRapidEventId(newest.id);
        setSelectedId(newest.id);
        setRapidStatus(`发现 ${newlyArrived.length} 个新事件，正在等待官方滑坡概率产品`);
      } else {
        if (reason !== 'auto') setNewEventCount(0);
        const preferred = normalized.find(isGroundFailureEvent) ?? normalized[0];
        setSelectedId((current) => current && normalized.some((event) => event.id === current) ? current : preferred?.id ?? null);
        if (reason === 'auto') setRapidStatus('目录已更新，未发现新的 M≥6.0 事件');
      }
    } catch (error) {
      setEventsError(error instanceof Error ? error.message : '地震目录加载失败');
      if (reason === 'auto') setRapidStatus('自动更新失败，将在下一周期重试');
    } finally {
      if (reason !== 'auto') setLoadingEvents(false);
    }
  }, [endDate, startDate]);

  useEffect(() => { void fetchEvents('range'); }, [fetchEvents]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => {
      const today = toDateInput(new Date());
      if (endDate !== today) setEndDate(today);
      else void fetchEvents('auto');
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, endDate, fetchEvents]);

  useEffect(() => {
    viewportOnlyRef.current = viewportOnly;
  }, [viewportOnly]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool || !events.length) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'configure_landslide_view',
      title: '选择滑坡地图事件',
      description: '在可见地图中选择一个 M≥6.0 地震事件，显示 USGS 官方地震滑坡概率。',
      inputSchema: {
        type: 'object',
        properties: { eventId: { type: 'string', description: 'USGS 事件编号，例如 us7000rl2n。' } },
        required: ['eventId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input) {
        const value = input as { eventId?: unknown };
        if (typeof value.eventId !== 'string' || !events.some((event) => event.id === value.eventId)) {
          throw new Error('eventId 不在当前已加载的 M≥6.0 事件目录中。');
        }
        setSelectedId(value.eventId);
        return { eventId: value.eventId };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [events]);

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;
    const map = L.map(mapElementRef.current, {
      center: [12, 15],
      zoom: 2,
      minZoom: 2,
      worldCopyJump: true,
      zoomControl: false,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
    let base: L.TileLayer | null = null, baseTimer: ReturnType<typeof setTimeout>;
    let mapDisposed = false;
    function installBase(index: number) {
      if (mapDisposed) return;
      clearTimeout(baseTimer);
      if (base) { const previous = base; base = null; detachMapLayer(map, previous); }
      const source = liveBasemapSources(liveBasemapRef.current)[index];
      if (!source) { setBasemapStatus('底图各线路暂时无法访问，请点击“重新加载”。空白不代表无风险。'); return; }
      setBasemapStatus(`正在加载 ${source.label}…`);
      const current = L.tileLayer(source.url, { attribution: source.attribution, maxZoom: 18 });
      base = current;
      let loaded = 0, failed = 0, switched = false;
      const fallback = () => { if (!switched && base === current) { switched = true; installBase(index + 1); } };
      current.on('tileload', () => {
        if (base !== current) return;
        loaded++;
        setBasemapStatus(`底图：${source.label}`);
      });
      current.on('tileerror', () => { if (++failed >= 3) fallback(); });
      current.on('loading', () => {
        clearTimeout(baseTimer);
        baseTimer = setTimeout(() => { if (!loaded || failed > loaded) fallback(); }, 18_000);
      });
      current.addTo(map);
    }
    baseRestartRef.current = () => installBase(0);
    installBase(0);
    markersRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    map.on('moveend', () => {
      if (viewportOnlyRef.current) setViewportBounds(map.getBounds());
    });
    exportEditorRef.current = new RegionSelection(map, {
      onChange: setExportBounds, onDrawing: setSelectingExport, onStatus: setExportStatus,
    });
    return () => {
      mapDisposed = true;
      clearTimeout(baseTimer);
      baseRestartRef.current = () => {};
      exportEditorRef.current?.destroy();
      exportEditorRef.current = null;
      map.remove();
      base?.off();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => { setReportNotes(''); }, [selectedId]);

  const filteredEvents = useMemo(() => {
    const query = searchText.trim().toLocaleLowerCase('zh-CN');
    const regionBounds = REGIONS[region].bounds;
    return events.filter((event) => {
      const [lon, lat] = event.geometry.coordinates;
      const inRegion = !regionBounds || (lon >= regionBounds[0] && lon <= regionBounds[2] && lat >= regionBounds[1] && lat <= regionBounds[3]);
      const inViewport = !viewportOnly || !viewportBounds || viewportBounds.contains([lat, lon]);
      const searchCorpus = [event.properties.place, event.properties.originalPlace, event.properties.eventAliases, event.id, event.properties.catalogAgency, event.properties.catalogNote]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('zh-CN');
      const matches = !query || searchCorpus.includes(query);
      return inRegion && inViewport && matches;
    });
  }, [events, region, searchText, viewportBounds, viewportOnly]);

  useEffect(() => { setVisibleEventCount(INITIAL_VISIBLE_EVENTS); }, [region, searchText, viewportBounds, viewportOnly]);

  const selectCatalogEvent = useCallback((event: EarthquakeFeature, source: Exclude<EventSelectionSource, 'system'>) => {
    selectionSourceRef.current = source;
    if (source === 'map') {
      pendingListRevealRef.current = event.id;
      const eventIndex = filteredEvents.findIndex((candidate) => candidate.id === event.id);
      setVisibleEventCount((current) => revealCountForEvent(current, eventIndex));
    } else {
      const [lon, lat] = event.geometry.coordinates;
      const map = mapRef.current;
      if (map) map.flyTo([lat, lon], focusZoom(map.getZoom()), { duration: 0.65 });
    }
    setSelectedId(event.id);
  }, [filteredEvents]);

  useEffect(() => {
    const eventId = pendingListRevealRef.current;
    if (!eventId) return;
    const eventIndex = filteredEvents.findIndex((event) => event.id === eventId);
    if (eventIndex < 0) {
      pendingListRevealRef.current = null;
      return;
    }
    if (eventIndex >= visibleEventCount) return;
    const frame = window.requestAnimationFrame(() => {
      eventItemRefs.current.get(eventId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      pendingListRevealRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filteredEvents, visibleEventCount]);

  useEffect(() => {
    const map = mapRef.current;
    const group = markersRef.current;
    if (!map || !group) return;
    group.clearLayers();
    filteredEvents.forEach((event) => {
      const [lon, lat] = event.geometry.coordinates;
      const selected = selectedId === event.id;
      const presentation = markerPresentation(event.properties.mag, selected);
      if (selected) {
        L.circleMarker([lat, lon], {
          radius: presentation.haloRadius,
          fillColor: '#ef5b58',
          fillOpacity: 0.13,
          color: '#ef5b58',
          opacity: 0.9,
          weight: 3,
          interactive: false,
          className: 'selected-earthquake-halo',
        }).addTo(group);
      }
      const marker = L.circleMarker([lat, lon], {
        radius: presentation.radius,
        fillColor: eventColor(event),
        fillOpacity: presentation.fillOpacity,
        color: selected ? '#ffffff' : '#102a3b',
        weight: presentation.weight,
        className: selected ? 'earthquake-marker is-selected' : 'earthquake-marker',
      });
      const tooltip = document.createElement('div');
      tooltip.textContent = `${event.properties.magType ?? 'M'} ${event.properties.mag.toFixed(1)} · ${event.properties.place} · ${eventNameLabel(event.properties.eventNameKind)}`;
      marker.bindTooltip(tooltip, { direction: 'top' });
      marker.on('click', () => selectCatalogEvent(event, 'map'));
      marker.addTo(group);
      if (selected) marker.bringToFront();
    });
  }, [filteredEvents, selectCatalogEvent, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    const controller = new AbortController();
    let active = true;

    async function loadDetail(initial: boolean) {
      if (initial) {
        setLoadingDetail(true);
        setDetail(null);
        activeExportRasterRef.current = null;
        if (overlayRef.current && mapRef.current) mapRef.current.removeLayer(overlayRef.current);
        overlayRef.current = null;
        setLayerStatus('正在读取所选地震详情…');
        setLayerError('');
      }
      try {
        const response = await fetchUsgs(`${USGS_DETAIL}/${selectedId}.geojson`, { signal: controller.signal });
        if (!response.ok) throw new Error(`事件详情返回 ${response.status}`);
        const value = await response.json() as EventDetail;
        if (!active) return;
        setDetail({ ...value, ...normalizeCatalogEvent(value) });
        if (initial) {
          const [lon, lat] = normalizeCatalogEvent(value).geometry.coordinates;
          const map = mapRef.current;
          const zoom = selectionSourceRef.current === 'system' ? 6 : focusZoom(map?.getZoom() ?? 6);
          map?.flyTo([lat, lon], zoom, { duration: 0.7 });
          selectionSourceRef.current = 'system';
        }
        if (rapidEventId === selectedId) {
          const hasGroundFailure = Boolean(chooseProduct(value.properties.products?.['ground-failure']));
          const hasShakeMap = Boolean(chooseProduct(value.properties.products?.shakemap));
          if (hasGroundFailure) setRapidStatus('新震官方滑坡概率产品已就绪');
          else if (hasShakeMap) setRapidStatus('新震 ShakeMap 已就绪，正在持续等待滑坡概率产品');
          else setRapidStatus('新震已进入目录，正在等待 ShakeMap 与滑坡概率产品');
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (active) setLayerError(error instanceof Error ? error.message : '事件详情加载失败');
      } finally {
        if (initial && active) setLoadingDetail(false);
      }
    }

    void loadDetail(true);
    const timer = autoRefresh && rapidEventId === selectedId
      ? window.setInterval(() => { void loadDetail(false); }, AUTO_REFRESH_MS)
      : null;
    return () => {
      active = false;
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [autoRefresh, loadRevision, rapidEventId, selectedId]);

  const groundFailure = useMemo(() => chooseProduct(detail?.properties.products?.['ground-failure']), [detail]);
  const shakeMap = useMemo(() => chooseProduct(detail?.properties.products?.shakemap), [detail]);
  const officialTifContent = officialContent(groundFailure, '.tif');
  const officialPngContent = officialContent(groundFailure, '.png');

  const replaceOverlay = useCallback((layer: L.Layer | null) => {
    const map = mapRef.current;
    if (!map) return;
    if (overlayRef.current) map.removeLayer(overlayRef.current);
    overlayRef.current = layer;
    if (layer) layer.addTo(map);
  }, []);

  useEffect(() => {
    if (!detail || detail.id !== selectedId) { replaceOverlay(null); activeExportRasterRef.current = null; setActiveRasterName(''); return; }
    let cancelled = false;
    let imageObjectUrl: string | null = null;
    const rasterController = new AbortController();
    setLayerError('');
    setLayerStatus('正在读取官方滑坡概率，请稍候…');

    async function drawLayer() {
      activeExportRasterRef.current = null;
      replaceOverlay(null);
      setActiveRasterName('');
      if (!groundFailure) throw new Error('该事件没有 USGS Ground Failure 产品，不能生成官方滑坡概率图；未发布不代表无风险。');
      const content = officialPngContent;
      const rasterContent = officialTifContent;
      if (!content && !rasterContent) throw new Error('该事件尚未发布官方滑坡概率文件；未发布不代表无风险。');
      const p = groundFailure.properties;
      const edge = (side: 'minimum' | 'maximum', axis: 'latitude' | 'longitude') =>
        Number(p[`landslide-${side}-${axis}`] ?? p[`${side}-${axis}`]);
      const bounds: L.LatLngBoundsExpression = [
        [edge('minimum', 'latitude'), edge('minimum', 'longitude')],
        [edge('maximum', 'latitude'), edge('maximum', 'longitude')],
      ];
      let raster: RasterData | null = null;
      let rasterError = '';
      if (rasterContent) {
        try { raster = await readRemoteRaster(rasterContent.url, '官方滑坡概率', rasterContent.length, {signal:rasterController.signal,onProgress:setLayerStatus}); }
        catch (error) { rasterError = error instanceof Error ? error.message : String(error); if (rasterError.includes('没有有效概率像元')) throw error; }
      }
      if (cancelled) return;
      if (!raster && !content) throw new Error(rasterError || '官方栅格暂时无法读取。');
      if (!raster) imageObjectUrl = await verifiedImageUrl(content!.url);
      if (cancelled) { if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl); return; }
      if (!raster && !bounds.flat().every(Number.isFinite)) throw new Error('官方预览图缺少有效地理范围。');
      const displayUrl = raster ? renderMapRaster(raster, displayMode, probabilityRgba).toDataURL('image/png') : imageObjectUrl!;
      const layer = L.imageOverlay(displayUrl, raster ? mapBoundsForRaster(raster) : bounds, { opacity, crossOrigin: true });
      if (!cancelled) {
        if (raster) { activeExportRasterRef.current = raster; setActiveRasterName(raster.name); }
        replaceOverlay(layer);
        if(!exportBounds) mapRef.current?.fitBounds(raster ? mapBoundsForRaster(raster) : bounds, { padding: [28, 28] });
        setLayerStatus(raster ? '官方滑坡概率已加载 · 网页预览，选区导出保留原生像元' : '官方预览图已验证加载；原生栅格暂不可用，可重新加载');
      }
    }

    void drawLayer().catch((error) => {
      if (!cancelled) {
        replaceOverlay(null);
        setLayerError(error instanceof Error ? error.message : '地图图层生成失败');
        setLayerStatus('当前图层不可用');
      }
    });

    return () => { cancelled = true; rasterController.abort(); if (imageObjectUrl) URL.revokeObjectURL(imageObjectUrl); };
  // Editing the export selection is not a request to reload the layer.
  }, [detail, displayMode, groundFailure, officialPngContent, officialTifContent, opacity, replaceOverlay, selectedId]);

  function fitRegion(value: RegionKey) {
    setRegion(value);
    const bounds = REGIONS[value].bounds;
    if (bounds && mapRef.current) mapRef.current.fitBounds([[bounds[1], bounds[0]], [bounds[3], bounds[2]]]);
    if (!bounds) mapRef.current?.setView([12, 15], 2);
  }

  function toggleViewport() {
    const enabled = !viewportOnly;
    setViewportOnly(enabled);
    setViewportBounds(enabled ? mapRef.current?.getBounds() ?? null : null);
  }

  function beginExportSelection() {
    exportEditorRef.current?.toggleDrawing();
  }

  function useViewportForExport() {
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    exportEditorRef.current?.setBounds(bounds);
    setExportStatus('已采用当前视窗，拖动选框内部移动、边角调整大小。');
  }

  function clearExportBounds() {
    exportEditorRef.current?.setBounds(null);
    setExportStatus('先拖拽框选范围或采用当前地图视窗');
  }

  async function getRasterForExport() {
    if (!detail || detail.id !== selectedId) throw new Error('请等待当前地震详情加载完成后再导出。');
    if (!exportBounds) throw new Error('请先选择导出范围。');
    const content = officialTifContent;
    if (!content) throw new Error('当前事件未发布官方滑坡概率栅格。');
    return readRemoteRaster(content.url, '官方滑坡概率', content.length, {
      native:true,bounds:[exportBounds.getWest(),exportBounds.getSouth(),exportBounds.getEast(),exportBounds.getNorth()],onProgress:setExportStatus,
    });
  }

  async function exportSelectedArea(format: 'geotiff' | 'png' | 'poster' | 'pdf') {
    if (!exportBounds) {
      setExportStatus('请先框选导出范围或采用当前地图视窗');
      return;
    }
    setExporting(true);
    setExportStatus('正在读取并裁切当前图层的原生像元…');
    try {
      const source = await getRasterForExport();
      const cropped = source;
      const stem = exportStem(selectedId);
      if (format === 'geotiff') {
        const noData = -9999;
        const values = new Float32Array(cropped.width * cropped.height);
        for (let index = 0; index < values.length; index += 1) {
          const value = Number(cropped.data[index]);
          values[index] = Number.isFinite(value) && Math.abs(value) < 1e30 && (cropped.noData === null || value !== cropped.noData) ? value : noData;
        }
        const [west, south, east, north] = cropped.bbox;
        const buffer = writeArrayBuffer(values, {
          width: cropped.width,
          height: cropped.height,
          BitsPerSample: [32],
          SampleFormat: [3],
          PhotometricInterpretation: 1,
          GeographicTypeGeoKey: 4326,
          GTModelTypeGeoKey: 2,
          GTRasterTypeGeoKey: 1,
          ModelPixelScale: [(east - west) / cropped.width, (north - south) / cropped.height, 0],
          ModelTiepoint: [0, 0, 0, west, north, 0],
          GDAL_NODATA: String(noData),
        });
        downloadBlob(new Blob([buffer], { type: 'image/tiff' }), `${stem}.tif`);
      } else if (format === 'png') {
        const rendered = canvasForRaster(cropped, (value) => value, probabilityRgba).canvas;
        const blob = await new Promise<Blob>((resolve, reject) => rendered.toBlob((value) => value ? resolve(value) : reject(new Error('PNG 编码失败')), 'image/png'));
        downloadBlob(blob, `${stem}.png`);
      } else {
        if (!selectedSummary) throw new Error('请先选择地震事件。');
        const layerLabel = 'USGS Ground Failure 官方滑坡概率';
        const poster = await createRiskMapPoster({
          raster: cropped,
          bounds: exportBounds,
          posterWidth,
          layerLabel,
          event: selectedSummary,
          overlayOpacity: opacity,
          basemapMode: exportBasemap,
          displayMode,
          reportNotes,
          onProgress: setExportStatus,
        });
        const basemap = EXPORT_BASEMAPS[exportBasemap];
        setExportStatus(`正在编码带${basemap.label}底图的综合成图…`);
        if(format==='pdf')downloadBlob(await posterPdf(poster),`${stem}_${basemap.filename}_report.pdf`);
        else {
          const blob = await new Promise<Blob>((resolve, reject) => poster.toBlob((value) => value ? resolve(value) : reject(new Error('综合成图 PNG 编码失败')), 'image/png'));
          downloadBlob(blob, `${stem}_${basemap.filename}_report.png`);
        }
      }
      const [west, south, east, north] = cropped.bbox;
      setExportStatus(`已导出 ${cropped.width} × ${cropped.height} 像元 · WGS84 · ${west.toFixed(4)}, ${south.toFixed(4)} 至 ${east.toFixed(4)}, ${north.toFixed(4)}`);
    } catch (error) {
      setExportStatus(error instanceof Error ? error.message : '区域导出失败');
    } finally {
      setExporting(false);
    }
  }

  const selectedSummary = events.find((event) => event.id === selectedId);
  const gfAlert = groundFailure?.properties['landslide-alert'];
  const officialTif = officialTifContent?.url;
  const briefAvailability = detail?.id === selectedId ? 'checked' : loadingDetail || !layerError ? 'loading' : 'unverified';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Mountain /></span>
          <div className="brand-copy"><strong>全球震后滑坡概率图</strong><small>GLOBAL LANDSLIDE WATCH</small></div>
        </div>
        <div className="topbar-status">
          <div className="catalog-status"><span><i className="status-dot" aria-hidden="true" />全球地震目录</span><small>区域权威台网交叉校核</small></div>
          <span className="model-badge" aria-label="收录震级 6.0 及以上"><small>收录震级</small><b>M ≥ 6.0</b></span>
        </div>
        <nav className="topbar-links" aria-label="外部资料">
          <a href="https://earthquake.usgs.gov/data/ground-failure/" target="_blank" rel="noreferrer">USGS Ground Failure</a>
          <a href="https://earthquake.usgs.gov/fdsnws/event/1/" target="_blank" rel="noreferrer">数据接口</a>
          <a href={`${import.meta.env.BASE_URL}?logout=1`}>退出</a>
        </nav>
      </header>

      <aside className="event-panel">
        <div className="panel-heading"><div><p className="eyebrow">EARTHQUAKE CATALOG</p><h2>地震事件</h2></div><Button variant="ghost" size="icon" onClick={() => void fetchEvents('manual')} title="刷新"><RefreshCw className={loadingEvents ? 'spin' : ''} /></Button></div>
        <div className="filter-grid">
          <label><span><CalendarDays />开始日期</span><Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label><span><CalendarDays />结束日期</span><Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label>
        </div>
        <div className="quick-ranges"><button onClick={() => setStartDate(dateYearsAgo(1))}>近 1 年</button><button onClick={() => setStartDate(dateYearsAgo(5))}>近 5 年</button><button onClick={() => setStartDate('2000-01-01')}>2000 年至今</button></div>
        <div className={`live-monitor ${autoRefresh ? 'is-live' : ''}`}>
          <div><Radio /><span><strong>新震自动监测</strong><small>{rapidStatus}</small></span></div>
          <button type="button" aria-pressed={autoRefresh} onClick={() => setAutoRefresh((current) => !current)}>{autoRefresh ? '自动 · 60 秒' : '已暂停'}</button>
          <p>{lastCatalogUpdate ? `上次校核：${formatUtc(lastCatalogUpdate)}` : '正在连接权威目录'}</p>
        </div>
        <label className="field-label"><span><MapPinned />地区</span><select value={region} onChange={(event) => fitRegion(event.target.value as RegionKey)}>{Object.entries(REGIONS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
        <label className="search-field"><Search /><Input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="搜索地震名、地名或事件编号" />{searchText && <button onClick={() => setSearchText('')} aria-label="清空"><X /></button>}</label>
        <Button variant={viewportOnly ? 'default' : 'outline'} size="sm" className="viewport-button" onClick={toggleViewport}><LocateFixed />{viewportOnly ? '已限定当前地图范围' : '限定到当前地图范围'}</Button>
        <div className="event-count"><span>{loadingEvents ? '正在读取…' : `${filteredEvents.length} 个事件`}</span><span>{events.length ? `目录共 ${events.length}${newEventCount ? ` · 新增 ${newEventCount}` : ''}` : ''}</span></div>
        {eventsError && <div className="inline-error"><AlertTriangle />{eventsError}</div>}
        <div className="event-results">
        <div className="event-list" aria-live="polite">
          {filteredEvents.slice(0, visibleEventCount).map((event) => (
            <button
              key={event.id}
              ref={(node) => { if (node) eventItemRefs.current.set(event.id, node); else eventItemRefs.current.delete(event.id); }}
              className={`event-item ${selectedId === event.id ? 'is-active' : ''} ${rapidEventId === event.id && newEventCount ? 'is-new' : ''}`}
              aria-current={selectedId === event.id ? 'true' : undefined}
              onClick={() => selectCatalogEvent(event, 'list')}
            >
              <span className="magnitude" style={{ '--event-color': eventColor(event) } as React.CSSProperties}>{event.properties.magType ?? 'M'} {event.properties.mag.toFixed(1)}</span>
              <span className="event-copy"><strong title={eventNameLabel(event.properties.eventNameKind)}>{event.properties.place}</strong><small>{formatUtc(event.properties.time)} · {event.properties.catalogAgency} · 深度 {event.geometry.coordinates[2].toFixed(1)} km</small></span>
              {selectedId === event.id ? <span className="selected-tag">已选</span> : rapidEventId === event.id && newEventCount ? <span className="new-tag">NEW</span> : isGroundFailureEvent(event) ? <span className="gf-tag">GF</span> : <ChevronRight />}
            </button>
          ))}
          {visibleEventCount < filteredEvents.length && <button className="load-more-events" onClick={() => setVisibleEventCount((count) => count + INITIAL_VISIBLE_EVENTS)}>继续加载（尚有 {filteredEvents.length - visibleEventCount} 个）</button>}
          {!loadingEvents && !filteredEvents.length && <div className="empty-state"><Filter /><p>当前条件下没有 M≥6.0 地震。</p></div>}
        </div>
        {filteredEvents.length === 1 && selectedSummary && <EventBrief
          event={selectedSummary}
          availability={briefAvailability}
          official={Boolean(officialTif || officialPngContent)}
          shakeMap={Boolean(shakeMap)}
          onLocate={() => { const [lon, lat] = selectedSummary.geometry.coordinates; mapRef.current?.flyTo([lat, lon], 7, { duration: 0.7 }); }}
        />}
        </div>
      </aside>

      <main className="map-workspace">
        <div ref={mapElementRef} className="map-canvas" aria-label="全球地震与滑坡概率地图" />
        <div className="map-status"><span className={layerError ? 'status-indicator error' : 'status-indicator'} /><span>{layerError || layerStatus}</span><button className="reload-map" onClick={() => { clearRemoteRasterCache(); setLoadRevision((v) => v + 1); baseRestartRef.current(); }}><RefreshCw />重新加载</button></div>
        <div className="basemap-status" role="status">{basemapStatus}</div>
        <div className="legend-card"><strong>滑坡概率</strong>{PROBABILITY_STOPS.map((stop) => <span key={stop.min}><i style={{ background: stop.color }} />{stop.label}</span>)}<small>低于 {PROBABILITY_FLOOR_LABEL} 透明</small></div>
        <div className="map-attribution-note">概率表示区域尺度的地震滑坡发生可能性，不等同于具体斜坡的稳定性判定。</div>
      </main>

      <aside className="detail-panel">
        <div className="detail-scroll">
          <section className="selected-event">
            <p className="eyebrow">SELECTED EVENT</p>
            {selectedSummary ? <>
              <div className="selected-title"><span>{selectedSummary.properties.magType ?? 'M'} {selectedSummary.properties.mag.toFixed(1)}</span><h2>{selectedSummary.properties.place}</h2></div>
              <p className="event-origin-name">{eventNameLabel(selectedSummary.properties.eventNameKind)}。{selectedSummary.properties.originalPlace && <>原始地名：{selectedSummary.properties.originalPlace}。</>} <a href={selectedSummary.properties.eventNameSourceUrl} target="_blank" rel="noreferrer">名称来源</a> · 震级保留标注来源值。</p>
              <div className="event-meta"><span><CalendarDays />{formatUtc(selectedSummary.properties.time)}</span><span><Earth />{selectedSummary.geometry.coordinates[1].toFixed(3)}°, {selectedSummary.geometry.coordinates[0].toFixed(3)}°</span><span><Activity />深度 {selectedSummary.geometry.coordinates[2].toFixed(1)} km</span><span><Database />震级来源：{selectedSummary.properties.catalogAgency}</span></div>
              {selectedSummary.properties.catalogNote && <div className="catalog-note"><ShieldCheck /><span>{selectedSummary.properties.catalogNote}</span>{selectedSummary.properties.catalogSourceUrl && <a href={selectedSummary.properties.catalogSourceUrl} target="_blank" rel="noreferrer">核验来源</a>}</div>}
            </> : <div className="empty-state compact"><CircleHelp /><p>请在地图或列表中选择地震。</p></div>}
          </section>

          <section className="quality-strip">
            <div className={groundFailure ? 'quality-item ok' : 'quality-item'}><span>{groundFailure ? <CheckCircle2 /> : <AlertTriangle />}</span><div><strong>滑坡产品</strong><small>{groundFailure ? `USGS v${groundFailure.properties['groundfailure-version'] ?? '—'}` : '未生成'}</small></div></div>
            <div className={shakeMap ? 'quality-item ok' : 'quality-item'}><span>{shakeMap ? <CheckCircle2 /> : <AlertTriangle />}</span><div><strong>ShakeMap</strong><small>{shakeMap ? `v${shakeMap.properties.version ?? '—'}` : '不可用'}</small></div></div>
            <div className={detail?.properties.status === 'reviewed' ? 'quality-item ok' : 'quality-item'}><span>{detail?.properties.status === 'reviewed' ? <CheckCircle2 /> : <CircleHelp />}</span><div><strong>震源状态</strong><small>{detail?.properties.status === 'reviewed' ? '已复核' : '自动'}</small></div></div>
          </section>

          <details name="detail-tools" className="sidebar-group" open>
            <summary><Layers3 /><span><strong>地图与显示</strong><small>底图 · 显示方式 · 透明度</small></span></summary>
          <section className="control-section live-basemap-control">
            <h3>地图底图</h3>
            <select aria-label="地图展示底图" value={liveBasemap} onChange={(e) => {const mode=e.target.value as LiveBasemap;setLiveBasemap(mode);liveBasemapRef.current=mode;baseRestartRef.current();}}>
              <option value="street">标准地图</option><option value="satellite">卫星影像</option>
            </select>
            <small>滑坡概率图层保持叠加；卫星影像不是实时震后影像。导出底图可在导出设置中单独选择。</small>
          </section>
          <section className="control-section">
            <div className="section-heading"><div><ShieldCheck /><h3>官方滑坡概率</h3></div><span className={`alert-pill ${gfAlert ?? 'none'}`}>{gfAlert ? `GF ${gfAlert.toUpperCase()}` : 'NO GF'}</span></div>
            <p>USGS Ground Failure 产品中的主滑坡模型（Nowicki Jessee et al., 2018），基于 ShakeMap PGV、坡度、岩性、土地覆盖与地形湿度指数，由历史地震滑坡编目通过逻辑回归建立，网格约 250 m。</p>
            <a href="https://earthquake.usgs.gov/data/ground-failure/background.php" target="_blank" rel="noreferrer">USGS 模型说明</a>
          </section>

          <section className="control-section">
            <div className="section-heading"><div><Layers3 /><h3>栅格显示与成图</h3></div></div>
            <label className="poster-resolution"><span>显示方式</span><select value={displayMode} onChange={(event) => setDisplayMode(event.target.value as DisplayMode)}><option value="smooth">显示平滑（双线性）</option><option value="native">原生像元（核验）</option></select></label>
            <div className="science-note"><CircleHelp /><p>平滑仅改善可视化，不提高数据实际分辨率；GeoTIFF 与原生透明 PNG 的数据值、像元和 NoData 保持不变。</p></div>
          </section>

          <section className="control-section"><div className="section-heading"><div><Layers3 /><h3>透明度</h3></div><span className="mini-value">{Math.round(opacity * 100)}%</span></div><label className="range-control"><input type="range" min="0.2" max="1" step="0.02" value={opacity} onChange={(event) => setOpacity(Number(event.target.value))} /></label></section>
          </details>

          <details name="detail-tools" className="sidebar-group">
            <summary><Download /><span><strong>选区与成果导出</strong><small>GIS 栅格 · 报告地图</small></span></summary>
          <section className="export-section">
            <div className="section-heading"><div><Crop /><h3>区域导出</h3></div><span>NATIVE GRID</span></div>
            <div className="selection-actions">
              <button className={selectingExport ? 'is-active' : ''} onClick={beginExportSelection}><Crop />{selectingExport ? '取消框选' : '拖拽框选'}</button>
              <button onClick={useViewportForExport}><LocateFixed />采用当前视窗</button>
              {exportBounds && <button className="clear-selection" onClick={clearExportBounds}><X />清除</button>}
            </div>
            <p className="selection-help">{selectingExport ? '在地图上按住左键拖动，松开完成；Esc 取消。' : '拖动内部移动、八个边角缩放；只改变选区，不刷新地图。'}</p>
            {exportBounds && <dl className="export-bounds"><div><dt>经度</dt><dd>{exportBounds.getWest().toFixed(4)} ～ {exportBounds.getEast().toFixed(4)}</dd></div><div><dt>纬度</dt><dd>{exportBounds.getSouth().toFixed(4)} ～ {exportBounds.getNorth().toFixed(4)}</dd></div></dl>}
            <details className="sidebar-subgroup"><summary>报告版式设置 · 底图 / 尺寸 / 文字</summary>
            <label className="poster-resolution"><span>综合成图底图</span><select value={exportBasemap} onChange={(event) => setExportBasemap(event.target.value as ExportBasemap)}><option value="satellite">卫星影像 · Esri World Imagery</option><option value="standard">标准地图 · 道路 / 地名 / 行政边界</option></select></label>
            <label className="poster-resolution"><span>综合成图宽度</span><select value={posterWidth} onChange={(event) => setPosterWidth(Number(event.target.value))}><option value={2400}>2400 px · 标准</option><option value={3600}>3600 px · 高分辨率</option><option value={4800}>4800 px · 出版级</option></select></label>
            <label className="report-notes"><span>图下补充说明 <small>可选 · 仅用于本次成图</small></span><textarea value={reportNotes} maxLength={600} rows={4} placeholder="地震概况会自动填写。可在此补充调查情况、研究说明或数据来源；请核实事实后填写。" onChange={(event) => setReportNotes(event.target.value)} /><small>{reportNotes.length} / 600 字 · 切换地震会清空</small></label>
            </details>
            <div className="export-buttons">
              <button disabled={!exportBounds || exporting} onClick={() => void exportSelectedArea('geotiff')}><Download /><span><strong>GeoTIFF</strong><small>Float32 · EPSG:4326 · 原生像元</small></span></button>
              <button disabled={!exportBounds || exporting} onClick={() => void exportSelectedArea('png')}><FileImage /><span><strong>透明专题 PNG</strong><small>原生像元 · 不含底图</small></span></button>
              <button className="poster-export" disabled={!exportBounds || exporting} onClick={()=>void exportSelectedArea('pdf')}><FileImage /><span><strong>报告地图 PDF</strong><small>A3 · 含底图、图例与地震说明 · 高分辨率图像嵌入，非矢量PDF</small></span></button>
              <button className="poster-export" disabled={!exportBounds || exporting} onClick={() => void exportSelectedArea('poster')}><MapPinned /><span><strong>{EXPORT_BASEMAPS[exportBasemap].label}底图综合成图 PNG</strong><small>{exportBasemap === 'standard' ? '道路与地名地图' : '卫星影像'} · 专业报告版式 · 图下地震说明 · 经纬度刻度 · 震中 · 图例 · 比例尺 · 指北针</small></span></button>
            </div>
            <details className="sidebar-subgroup"><summary>通用附件 · 卫星底图栅格</summary>
            <p className="selection-help">仅导出影像底图，与滑坡概率结果独立；像元尺寸取决于选区和导出长边。</p>
            <label className="poster-resolution"><span>卫星栅格长边</span><select value={satelliteSize} onChange={e=>setSatelliteSize(Number(e.target.value))}><option value={2048}>2048 像素</option><option value={4096}>4096 像素</option></select></label>
            <div className="export-buttons"><button disabled={!exportBounds||exporting} onClick={()=>void exportSatelliteRaster()}><Download /><span><strong>卫星底图 GeoTIFF</strong><small>RGB · EPSG:3857 · 有地理坐标 · 不含滑坡图层</small></span></button></div>
            </details>
            <div role="status" className={`export-status ${exporting ? 'is-working' : ''}`}>{exporting && <RefreshCw className="spin" />}<span>{exportStatus}</span></div>
            <div className="science-note"><CircleHelp /><p>GeoTIFF 与透明 PNG 使用官方原生栅格，不做插值放大；概率值为 0–1。综合成图含图外图例、指北针、比例尺、经纬度刻度和完整来源说明。{activeRasterName ? ` 当前数据：${activeRasterName}。` : ''}</p></div>
          </section>
          </details>

          <details name="detail-tools" className="sidebar-group">
            <summary><Database /><span><strong>官方原始成果</strong><small>USGS 产品与事件来源</small></span></summary>
          <section className="download-section">
            <div className="section-heading"><div><Download /><h3>原始成果</h3></div></div>
            <div className="download-links">
              {officialTif && <a href={officialTif} target="_blank" rel="noreferrer"><Download />官方滑坡概率 GeoTIFF</a>}
              {selectedSummary && <a href={selectedSummary.properties.url} target="_blank" rel="noreferrer"><Earth />USGS 事件页面</a>}
            </div>
          </section>
          </details>
          <footer className="panel-footer"><p>仅用于震后快速筛查与研究，不替代现场调查、斜坡稳定性评价或应急结论。</p></footer>
        </div>
      </aside>
      {loadingDetail && <div className="global-loader"><RefreshCw className="spin" />正在加载事件产品…</div>}
    </div>
  );

}

export default function App() {
  return <Dashboard />;
}
