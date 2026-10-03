// Presentation resampling only. Never use the display values as analytical output.
export type RasterView = {
  data: ArrayLike<number>; width: number; height: number;
  bbox: [number, number, number, number]; noData: number | null; name: string;
};
export type DisplayMode = 'smooth' | 'native';
export type Rgba = [number, number, number, number];
type Box = { x: number; y: number; width: number; height: number };
type TextBlock = Box & { lines: string[]; font: string; lineHeight: number };
export type PosterOptions = {
  raster: RasterView; bounds: [number, number, number, number]; width: number;
  title: string; place: string; subtitle: string; legendTitle: string;
  legend: Array<{ color: string; label: string }>;
  eventLines: string[]; methodLines: string[]; attribution: string;
  description?: string; notes?: string;
  epicentre: [number, number]; opacity: number; displayMode: DisplayMode;
  color: (value: number) => Rgba;
  paintBasemap: (context: CanvasRenderingContext2D, box: Box) => Promise<number>;
  onProgress: (message: string) => void;
};

const limit = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));
const fontFamily = '"Microsoft YaHei", "Noto Sans SC", Arial, sans-serif';
export function mercatorLatitude(lat: number) {
  const radians = limit(lat, -85.05112878, 85.05112878) * Math.PI / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
}
export function geographicLatitude(y: number) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}
export function mapCoordinate(value: number, axis: 'lon' | 'lat', digits = 2) {
  return `${Math.abs(value).toFixed(digits)}°${axis === 'lon' ? (value < 0 ? 'W' : 'E') : (value < 0 ? 'S' : 'N')}`;
}
function valid(r: RasterView, v: number) {
  return Number.isFinite(v) && Math.abs(v) < 1e30 && (r.noData === null || v !== r.noData);
}

// Coordinates refer to pixel centres; nearest NoData remains transparent, and a
// missing neighbour prevents interpolation across a data gap or coastline.
export function sampleDisplayValue(r: RasterView, longitude: number, latitude: number, mode: DisplayMode) {
  const [west, south, east, north] = r.bbox;
  if (longitude < west || longitude > east || latitude < south || latitude > north) return Number.NaN;
  const fx = limit((longitude - west) / (east - west) * r.width - 0.5, 0, r.width - 1);
  const fy = limit((north - latitude) / (north - south) * r.height - 0.5, 0, r.height - 1);
  const nearest = Number(r.data[Math.round(fy) * r.width + Math.round(fx)]);
  if (!valid(r, nearest)) return Number.NaN;
  if (mode === 'native') return nearest;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, r.width - 1), y1 = Math.min(y0 + 1, r.height - 1);
  const a = Number(r.data[y0 * r.width + x0]), b = Number(r.data[y0 * r.width + x1]);
  const c = Number(r.data[y1 * r.width + x0]), d = Number(r.data[y1 * r.width + x1]);
  if (!valid(r, a) || !valid(r, b) || !valid(r, c) || !valid(r, d)) return nearest;
  const tx = fx - x0, ty = fy - y0;
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export function renderRasterView(raster: RasterView, bounds: [number, number, number, number], width: number, height: number, mode: DisplayMode, color: (value: number) => Rgba) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建栅格显示画布。');
  const pixels = context.createImageData(width, height);
  const [west, south, east, north] = bounds;
  const top = mercatorLatitude(north), bottom = mercatorLatitude(south);
  for (let y = 0; y < height; y += 1) {
    const lat = geographicLatitude(top + (y + 0.5) / height * (bottom - top));
    for (let x = 0; x < width; x += 1) {
      const lon = west + (x + 0.5) / width * (east - west);
      const value = sampleDisplayValue(raster, lon, lat, mode);
      if (!Number.isFinite(value)) continue;
      const rgba = color(value), offset = (y * width + x) * 4;
      pixels.data.set(rgba, offset);
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

function wrap(context: CanvasRenderingContext2D, value: string, width: number) {
  const lines: string[] = [];
  let parts: string[] = [];
  // Keep coordinates, dates and Latin words together. Fall back to characters
  // only for a single identifier longer than the entire text column.
  const units = value.match(/[A-Za-z0-9][A-Za-z0-9°.%:+/_−–—-]*|[^\r]/gu) ?? [];
  const add = (unit: string) => {
    if (unit === '\n') { lines.push(parts.join('').trimEnd()); parts = []; return; }
    if (!parts.length && !unit.trim()) return;
    if (context.measureText(unit).width > width) { for (const ch of unit) add(ch); return; }
    if (parts.length && context.measureText(parts.join('') + unit).width > width) {
      const carry = /^[，。；：、！？）》】]/u.test(unit) ? parts.pop() ?? '' : '';
      lines.push(parts.join('').trimEnd()); parts = carry ? [carry] : [];
    }
    if (parts.length || unit.trim()) parts.push(unit);
  };
  units.forEach(add);
  if (parts.length || !lines.length) lines.push(parts.join('').trimEnd());
  return lines;
}
function textBlock(context: CanvasRenderingContext2D, values: string[], x: number, y: number, width: number, font: string, lineHeight: number): TextBlock {
  context.font = font;
  const lines = values.flatMap((v) => wrap(context, v, width));
  return { x, y, width, height: lines.length * lineHeight, lines, font, lineHeight };
}


/** Cartographic intervals are rounded, not arbitrary fractions of the frame. */
export function coordinateTicks(low: number, high: number, target = 5) {
  const ideal = (high - low) / target;
  const base = 10 ** Math.floor(Math.log10(ideal));
  const step = ([1, 2, 2.5, 5, 10].find((v) => v * base >= ideal) ?? 10) * base;
  const digits = Math.min(6, Math.max(0, -Math.floor(Math.log10(step)) + (String(step / base).includes('.') ? 1 : 0)));
  const values: number[] = [];
  for (let v = Math.ceil((low - step * 1e-8) / step) * step; v <= high + step * 1e-8; v += step) values.push(Math.abs(v) < step * 1e-8 ? 0 : v);
  return { values, digits, step };
}

export function posterLayout(context: CanvasRenderingContext2D, o: PosterOptions) {
  const u=o.width/2400,margin=100*u,inner=o.width-2*margin;
  const heading=textBlock(context,[o.title],margin,42*u,inner,`700 ${51*u}px SimSun, "Noto Serif SC", ${fontFamily}`,69*u);
  const place=textBlock(context,[o.place],margin,heading.y+heading.height+10*u,inner,`500 ${30*u}px ${fontFamily}`,42*u);
  const subtitle=textBlock(context,[o.subtitle],margin,place.y+place.height+8*u,inner,`400 ${23*u}px ${fontFamily}`,33*u);
  const [west,south,east,north]=o.bounds;
  const aspect=(mercatorLatitude(south)-mercatorLatitude(north))/((east-west)/360);
  if (!(aspect>=.22&&aspect<=2)) throw new Error('综合成图要求框选区域宽高比在 1:4.5 至 2:1 之间，请调整选框边角。');
  const railWidth=420*u,gutter=100*u,mapWidth=inner-railWidth-gutter;
  const map={x:margin,y:subtitle.y+subtitle.height+65*u,width:mapWidth,height:Math.round(mapWidth*aspect)};
  const railX=map.x+map.width+gutter;
  const northBox={x:railX+railWidth-190*u,y:map.y,width:190*u,height:86*u};
  const legend={x:railX,y:map.y+110*u,width:railWidth,height:95*u+(o.legend.length+1)*45*u};
  const legendNote=textBlock(context,[o.legendTitle.includes('MMI')?'修订麦加利烈度 MMI，不等同于中国烈度表；缺测区透明。':o.legendTitle.includes('PGA')?'PGA 单位 g；不等同于滑坡概率。':'概率按区间着色；低于 0.1% 透明，缺测区不作判定。'],railX,legend.y+legend.height+8*u,railWidth,`400 ${23*u}px ${fontFamily}`,36*u);
  const notesTitleY=legendNote.y+legendNote.height+35*u;
  const hasNotes=Boolean(o.notes?.trim());
  const notes=textBlock(context,hasNotes?[(o.notes??'').trim()]:[],railX,notesTitleY+48*u,railWidth,`400 ${25*u}px ${fontFamily}`,39*u);
  const scale={x:railX,y:(hasNotes?notes.y+notes.height:legendNote.y+legendNote.height)+75*u,width:railWidth,height:86*u};
  const colorbar={x:map.x,y:map.y+map.height+75*u,width:map.width,height:90*u};
  const infoY=Math.max(colorbar.y+colorbar.height,scale.y+scale.height)+50*u;
  const narrative=textBlock(context,[o.description||o.eventLines.join('；')],margin,infoY+55*u,inner,`400 ${27*u}px ${fontFamily}`,43*u);
  const detailsY=narrative.y+narrative.height+35*u;
  const columnWidth=(inner-65*u)/2;
  const event=textBlock(context,o.eventLines,margin,detailsY+44*u,columnWidth,`400 ${23*u}px ${fontFamily}`,35*u);
  const method=textBlock(context,o.methodLines,margin+columnWidth+65*u,event.y,columnWidth,event.font,event.lineHeight);
  const source=textBlock(context,[o.attribution],margin,event.y+Math.max(event.height,method.height)+28*u,inner,`400 ${21*u}px ${fontFamily}`,31*u);
  const warning=textBlock(context,['使用说明：仅用于区域尺度震后筛查与研究，不替代现场调查、斜坡稳定性评价或政府应急结论。'],margin,source.y+source.height+18*u,inner,`400 ${22*u}px ${fontFamily}`,33*u);
  const height=Math.ceil(warning.y+warning.height+48*u);
  if(o.width*height>60_000_000)throw new Error('图件超过6000万像素，请降低宽度或缩短说明。');
  return {u,margin,inner,height,heading,place,subtitle,map,legend,legendNote,northBox,scale,colorbar,infoY,narrative,notes,hasNotes,notesTitleY,detailsY,event,method,source,warning};
}

function drawText(context: CanvasRenderingContext2D, block: TextBlock, color: string, centered = false) {
  context.font = block.font; context.fillStyle = color; context.textBaseline = 'top';
  context.textAlign = centered ? 'center' : 'left';
  block.lines.forEach((line, index) => context.fillText(line, centered ? block.x + block.width / 2 : block.x, block.y + index * block.lineHeight));
  context.textAlign = 'left';
}
function drawStar(context: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  context.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 ? radius * 0.44 : radius, angle = -Math.PI / 2 + i * Math.PI / 5;
    const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
    if (i === 0) context.moveTo(px, py); else context.lineTo(px, py);
  }
  context.closePath(); context.fillStyle = '#c81e37'; context.fill();
  context.strokeStyle = '#fff'; context.lineWidth = radius * 0.15; context.stroke();
}
function groundDistance(west: number, east: number, latitude: number) {
  const d = (east - west) * Math.PI / 180, lat = latitude * Math.PI / 180;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.abs(Math.cos(lat) * Math.sin(d / 2))));
}
function niceDistance(value: number) {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(value, 0.0001)));
  return (value / magnitude >= 5 ? 5 : value / magnitude >= 2 ? 2 : 1) * magnitude;
}

export async function renderRiskPoster(o: PosterOptions) {
  if (document.fonts?.ready) await document.fonts.ready;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法创建综合成图画布。');
  const l = posterLayout(context, o), { u, map } = l;
  canvas.width = o.width; canvas.height = l.height;
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  drawText(context, l.heading, '#1c292c', true);
  drawText(context, l.place, '#303d40', true);
  drawText(context, l.subtitle, '#617074', true);

  context.save(); context.beginPath(); context.rect(map.x, map.y, map.width, map.height); context.clip();
  const zoom = await o.paintBasemap(context, map);
  o.onProgress('正在叠加风险栅格与排版地震说明…');
  const overlayScale = Math.min(1, Math.sqrt(12_000_000 / (map.width * map.height)));
  const overlay = renderRasterView(o.raster, o.bounds, Math.max(1, Math.round(map.width * overlayScale)), Math.max(1, Math.round(map.height * overlayScale)), o.displayMode, o.color);
  context.globalAlpha = o.opacity; context.imageSmoothingEnabled = o.displayMode === 'smooth'; context.imageSmoothingQuality = 'high';
  context.drawImage(overlay, map.x, map.y, map.width, map.height); context.globalAlpha = 1;
  const [west, south, east, north] = o.bounds, [lon, lat] = o.epicentre;
  const top = mercatorLatitude(north), bottom = mercatorLatitude(south);
  const epicentreInside = lon >= west && lon <= east && lat >= south && lat <= north;
  if (epicentreInside) drawStar(context, map.x + (lon - west) / (east - west) * map.width, map.y + (mercatorLatitude(lat) - top) / (bottom - top) * map.height, 26 * u);
  context.restore();

  context.strokeStyle = '#253336'; context.lineWidth = 2 * u; context.strokeRect(map.x, map.y, map.width, map.height);
  context.font = `500 ${25 * u}px ${fontFamily}`; context.fillStyle = '#27373b'; context.textBaseline = 'middle';
  const tick = 12 * u, longitudes = coordinateTicks(west, east), latitudes = coordinateTicks(south, north, Math.max(2, Math.min(6, Math.round(map.height / (350 * u)))));
  for (const longitude of longitudes.values) {
    const x = map.x + (longitude - west) / (east - west) * map.width;
    context.beginPath(); context.moveTo(x, map.y); context.lineTo(x, map.y - tick);
    context.moveTo(x, map.y + map.height); context.lineTo(x, map.y + map.height + tick); context.stroke();
    context.textAlign = 'center';
    const label = mapCoordinate(longitude, 'lon', longitudes.digits);
    context.fillText(label, x, map.y - 34 * u); context.fillText(label, x, map.y + map.height + 34 * u);
  }
  for (const latitude of latitudes.values) {
    const y = map.y + (mercatorLatitude(latitude) - top) / (bottom - top) * map.height;
    if (y - map.y < 80 * u || map.y + map.height - y < 80 * u) continue;
    context.beginPath(); context.moveTo(map.x, y); context.lineTo(map.x - tick, y);
    context.moveTo(map.x + map.width, y); context.lineTo(map.x + map.width + tick, y); context.stroke();
    for (const side of [-1, 1]) {
      context.save(); context.translate(side < 0 ? map.x - 35 * u : map.x + map.width + 35 * u, y);
      context.rotate(side * Math.PI / 2); context.textAlign = 'center'; context.fillText(mapCoordinate(latitude, 'lat', latitudes.digits), 0, 0); context.restore();
    }
  }
  context.textBaseline = 'top'; context.textAlign = 'left';

  // One restrained marginal strip: scale left, CRS centre, north right.
  const groundWidth = groundDistance(west, east, geographicLatitude((top + bottom) / 2));
  const distance = niceDistance(groundWidth * (l.scale.width-30*u) / map.width), length = distance / groundWidth * map.width;
  const sx = l.scale.x + 4 * u, sy = l.scale.y + 38 * u;
  context.fillStyle = '#253336'; context.fillRect(sx, sy, length / 2, 11 * u);
  context.fillStyle = '#fff'; context.fillRect(sx + length / 2, sy, length / 2, 11 * u);
  context.strokeStyle = '#253336'; context.lineWidth = 1.6 * u; context.strokeRect(sx, sy, length, 11 * u);
  const divisor = distance >= 1000 ? 1000 : 1, unit = divisor === 1000 ? 'km' : 'm';
  context.fillStyle = '#334348'; context.font = `400 ${23 * u}px ${fontFamily}`;
  [0, 0.5, 1].forEach((f) => {
    context.textAlign = f === 0 ? 'left' : f === 1 ? 'right' : 'center';
    context.fillText(`${Number((distance * f / divisor).toPrecision(4))}${f === 1 ? ` ${unit}` : ''}`, sx + length * f, sy - 33 * u);
  });
  context.textAlign = 'center'; context.font = `400 ${22 * u}px ${fontFamily}`; context.fillStyle = '#647075';
  context.fillText('比例尺按图幅中心纬度', l.scale.x+l.scale.width/2, sy+30*u);
  const nx = l.northBox.x + 80 * u, ny = l.northBox.y + 7 * u;
  context.fillStyle = '#253336'; context.font = `700 ${28 * u}px ${fontFamily}`; context.fillText('N', nx + 56 * u, ny + 20 * u);
  context.beginPath(); context.moveTo(nx, ny); context.lineTo(nx - 17 * u, ny + 60 * u); context.lineTo(nx, ny + 44 * u); context.closePath(); context.fill();
  context.beginPath(); context.moveTo(nx, ny); context.lineTo(nx + 17 * u, ny + 60 * u); context.lineTo(nx, ny + 44 * u); context.closePath(); context.stroke();
  context.textAlign = 'left';

  const rule = (y: number, color = '#bcc7c9') => { context.strokeStyle = color; context.lineWidth = 1.4 * u; context.beginPath(); context.moveTo(l.margin, y); context.lineTo(o.width - l.margin, y); context.stroke(); };
  const heading = (text: string, x: number, y: number, size = 32) => {
    context.fillStyle = '#243d45'; context.font = `700 ${size * u}px ${fontFamily}`; context.fillText(text, x, y);
  };
  rule(l.infoY - 20 * u, '#334b52');
  heading('地震概况与图件说明', l.narrative.x, l.infoY);
  drawText(context, l.narrative, '#303d42');
  if (l.hasNotes) { heading('补充说明（用户提供）', l.notes.x, l.notesTitleY, 28); drawText(context, l.notes, '#303d42'); }
  context.strokeStyle = '#dae0e1'; context.beginPath();
  context.moveTo(l.legend.x - 35 * u, map.y); context.lineTo(l.legend.x - 35 * u, l.scale.y+l.scale.height); context.stroke();
  heading(o.legendTitle, l.legend.x, l.legend.y);
  o.legend.forEach((item, index) => {
    const y = l.legend.y + 65 * u + index * 45 * u;
    context.fillStyle = item.color; context.fillRect(l.legend.x, y + 2 * u, 58 * u, 29 * u);
    context.fillStyle = '#303d42'; context.font = `400 ${29 * u}px ${fontFamily}`;
    context.fillText(item.label, l.legend.x + 82 * u, y);
  });
  const starY = l.legend.y + 65 * u + o.legend.length * 45 * u;
  if (epicentreInside) {
    drawStar(context, l.legend.x + 29 * u, starY + 17 * u, 20 * u);
    context.fillStyle = '#303d42'; context.font = `400 ${27 * u}px ${fontFamily}`;
    context.fillText('震中', l.legend.x + 82 * u, starY);
  } else {
    context.fillStyle = '#5c6b70'; context.font = `400 ${24 * u}px ${fontFamily}`;
    context.fillText('震中位于当前图幅之外', l.legend.x, starY);
  }
  drawText(context, l.legendNote, '#5c6b70');
  // A compact horizontal class key beneath the map, outside its geographic frame.
  const classes=[...o.legend].reverse(),cell=l.colorbar.width/Math.max(1,classes.length);
  context.font=`400 ${22*u}px ${fontFamily}`;
  classes.forEach((item,index)=>{
    const x=l.colorbar.x+index*cell,y=l.colorbar.y;
    context.fillStyle=item.color;context.fillRect(x,y,cell,27*u);
    context.strokeStyle='#34464b';context.lineWidth=u;context.strokeRect(x,y,cell,27*u);
    context.fillStyle='#24383f';context.textAlign='center';context.fillText(item.label,x+cell/2,y+36*u);
  });
  context.textAlign='left';
  rule(l.detailsY - 12 * u);
  heading('事件与范围', l.event.x, l.detailsY, 26); heading('数据与方法', l.method.x, l.detailsY, 26);
  drawText(context, l.event, '#3f5158'); drawText(context, l.method, '#3f5158');
  drawText(context, l.source, '#49595e'); drawText(context, l.warning, '#536369');
  return { canvas, layout: l, zoom };
}
