import {fromArrayBuffer, fromCustomClient, type GeoTIFFImage} from 'geotiff';
import {fetchUsgs} from './data-access';

export type Bounds = [number, number, number, number];
export type RemoteRaster = {data: ArrayLike<number>; width: number; height: number; bbox: Bounds; noData: number | null; name: string;
  preview?: boolean; nativeWidth?: number; nativeHeight?: number};
type ReadOptions = {signal?: AbortSignal; bounds?: Bounds; native?: boolean; onProgress?: (message: string) => void};
const images = new Map<string, Promise<GeoTIFFImage>>();
const previews = new Map<string, RemoteRaster>();
let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(operation: () => Promise<T>): Promise<T> {
  if (active >= 2) await new Promise<void>(resolve => queue.push(resolve));
  else active++;
  try {return await operation();} finally {const next = queue.shift(); if(next) next(); else active--;}
}
function abortIfNeeded(signal?: AbortSignal) {if(signal?.aborted) throw new DOMException('Cancelled', 'AbortError');}
export function clearRemoteRasterCache() {images.clear(); previews.clear();}
async function openImage(url: string, size: number) {
  let pending = images.get(url);
  if (!pending) {
    pending = (async () => {
      const blockOptions = {blockSize: 1024 * 1024, cacheSize: 16, allowFullFile: false};
      const tiff = size > 0 && size <= 12 * 1024 * 1024
        ? await fromArrayBuffer(await (await fetchUsgs(url)).arrayBuffer())
        : await fromCustomClient({url, request: (options = {}) => limited(async () => {
          const range = new Headers(options.headers).get('range')?.match(/^bytes=(\d+)-(\d+)$/);
          if(!range) throw new Error('栅格读取必须使用有界分块。');
          const response = await fetchUsgs(url, {signal: options.signal ?? undefined, range: [Number(range[1]), Number(range[2])], totalBytes: size});
          return {ok: response.ok, status: response.status, getHeader: (name: string) => response.headers.get(name) ?? undefined, getData: () => response.arrayBuffer()};
        })}, blockOptions);
      const image = await tiff.getImage();
      const box = image.getBoundingBox(), keys = image.getGeoKeys() ?? {};
      if (keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey !== 4326 || image.getSamplesPerPixel() !== 1
        || !box.every(Number.isFinite) || box[0] < -360 || box[2] > 360 || box[2]-box[0] > 360 || box[1] < -90 || box[3] > 90
        || box[0] >= box[2] || box[1] >= box[3]) throw new Error('官方栅格坐标系、波段或范围不符合 WGS84 概率栅格要求，已停止叠加。');
      if (image.getTileWidth() * image.getTileHeight() * image.getBytesPerPixel() > 64 * 1024 * 1024) throw new Error('该文件单个存储块过大，不能安全在线解码，请使用原始文件离线处理。');
      return image;
    })();
    images.set(url, pending);
    while(images.size > 2) images.delete(images.keys().next().value!);
    pending.catch(() => {if(images.get(url) === pending) images.delete(url);});
  }
  return pending;
}

export function alignedWindow(box: Bounds, width: number, height: number, requested?: Bounds) {
  if (!requested) return {window: [0,0,width,height], bbox: box};
  const west=Math.max(box[0],requested[0]), south=Math.max(box[1],requested[1]), east=Math.min(box[2],requested[2]), north=Math.min(box[3],requested[3]);
  if(!(west<east&&south<north)) throw new Error('框选范围与当前概率栅格没有重叠。');
  const dx=(box[2]-box[0])/width,dy=(box[3]-box[1])/height;
  const x0=Math.max(0,Math.floor((west-box[0])/dx+1e-8)), x1=Math.min(width,Math.ceil((east-box[0])/dx-1e-8));
  const y0=Math.max(0,Math.floor((box[3]-north)/dy+1e-8)), y1=Math.min(height,Math.ceil((box[3]-south)/dy-1e-8));
  return {window:[x0,y0,x1,y1],bbox:[box[0]+x0*dx,box[3]-y1*dy,box[0]+x1*dx,box[3]-y0*dy] as Bounds};
}

// Windowed strips avoid GeoTIFF.js allocating a full native image before resampling.
// Display samples use nearest original values; export uses every native cell in the requested window.
export async function readRemoteRaster(url: string, name: string, size = 0, options: ReadOptions = {}): Promise<RemoteRaster> {
  abortIfNeeded(options.signal);
  if(!options.native && !options.bounds && previews.has(url)) return previews.get(url)!;
  options.onProgress?.('正在读取栅格元数据…');
  const image=await openImage(url,size), nativeWidth=image.getWidth(), nativeHeight=image.getHeight();
  const selected=alignedWindow(image.getBoundingBox() as Bounds,nativeWidth,nativeHeight,options.bounds);
  const [x0,y0,x1,y1]=selected.window, sw=x1-x0, sh=y1-y0;
  if(options.native && sw*sh>16_000_000) throw new Error('所选区域超过 1600 万原生像元，请缩小选区后导出；不会用预览像元替代原始数据。');
  const factor=options.native?1:Math.min(1,2200/sw,2200/sh,Math.sqrt(4_000_000/(sw*sh)));
  const width=Math.max(1,Math.floor(sw*factor)), height=Math.max(1,Math.floor(sh*factor));
  const values=new Float32Array(width*height), noData=image.getGDALNoData();
  const rowsPerBatch=Math.max(1,Math.min(128,Math.floor(2_000_000/sw)));
  let destinationY=0, hasValid=false;
  for(let start=y0;start<y1;start+=rowsPerBatch) {
    abortIfNeeded(options.signal);
    const stop=Math.min(y1,start+rowsPerBatch);
    const data=await image.readRasters({window:[x0,start,x1,stop],samples:[0],interleave:true,signal:options.signal});
    for(const v of data) {
      if(!Number.isFinite(v)||v===noData||Math.abs(v)>1e30) continue;
      if(v<0||v>1) throw new Error('概率栅格包含 0–1 范围外的有效值，已停止加载以避免错误制图。');
      hasValid=true;
    }
    while(destinationY<height) {
      const sy=y0+Math.min(sh-1,Math.floor((destinationY+.5)*sh/height));
      if(sy>=stop) break;
      for(let x=0;x<width;x++) values[destinationY*width+x]=Number(data[(sy-start)*sw+Math.min(sw-1,Math.floor((x+.5)*sw/width))]);
      destinationY++;
    }
    options.onProgress?.(`${options.native?'读取原生选区':'分块生成预览'} ${Math.round((stop-y0)/sh*100)}%`);
  }
  if(!hasValid) throw new Error('官方栅格在此范围内没有有效概率像元（可能为海域或模型掩膜）；不能据此判断无风险。');
  const result={data:values,width,height,bbox:selected.bbox,noData,name,preview:factor<1,nativeWidth,nativeHeight};
  if(!options.native&&!options.bounds) {previews.set(url,result);while(previews.size>2) previews.delete(previews.keys().next().value!);}
  return result;
}
