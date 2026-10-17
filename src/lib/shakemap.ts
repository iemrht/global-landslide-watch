import { fetchUsgs } from './data-access';
import { alignedWindow, type RemoteRaster, type Bounds } from './remote-raster';
export type ShakingMetric = 'pga' | 'mmi';
const cache = new Map<string, Record<ShakingMetric, RemoteRaster>>();
export function clearShakeMapCache() { cache.clear(); }
export async function readShakeMap(url: string, metric: ShakingMetric, signal?: AbortSignal, bounds?: Bounds): Promise<RemoteRaster> {
  let grids = cache.get(url);
  if (!grids) {
    const xml = new DOMParser().parseFromString(await (await fetchUsgs(url, {signal})).text(), 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('ShakeMap XML 格式无效。');
    const spec = xml.getElementsByTagName('grid_specification')[0];
    if (!spec) throw new Error('ShakeMap 缺少网格定义。');
    const number = (key: string) => Number(spec.getAttribute(key));
    const width=number('nlon'), height=number('nlat');
    // USGS nominal spacing is rounded; derive exact spacing from endpoints.
    const dx=(number('lon_max')-number('lon_min'))/(width-1), dy=(number('lat_max')-number('lat_min'))/(height-1);
    const west=number('lon_min'), north=number('lat_max');
    if (![width,height,dx,dy,west,north].every(Number.isFinite) || !Number.isInteger(width) || !Number.isInteger(height) || width<2 || height<2 || width*height>4_000_000 || dx<=0 || dy<=0) throw new Error('ShakeMap 网格尺寸或坐标无效，或超出在线读取限制。');
    const fields=Array.from(xml.getElementsByTagName('grid_field'));
    const field=(name: string)=>fields.find(f=>f.getAttribute('name')?.toUpperCase()===name);
    const index=(name: string)=>Number(field(name)?.getAttribute('index'))-1;
    const lon=index('LON'),lat=index('LAT'),pga=index('PGA'),mmi=index('MMI');
    const units=field('PGA')?.getAttribute('units')?.toLowerCase();
    const scale=units==='%g'?0.01:units==='g'?1:NaN;
    if ([lon,lat,pga,mmi].some(i=>!Number.isInteger(i)||i<0||i>=fields.length) || !Number.isFinite(scale)) throw new Error('ShakeMap 缺少 PGA/MMI 字段或 PGA 单位无法识别。');
    const a=new Float32Array(width*height).fill(NaN),b=new Float32Array(width*height).fill(NaN);
    const lines=(xml.getElementsByTagName('grid_data')[0]?.textContent ?? '').trim().split(/\r?\n/);
    let count=0; const seen=new Uint8Array(width*height);
    for(const line of lines) {
      if(signal?.aborted) throw new DOMException('Cancelled','AbortError');
      const row=line.trim().split(/\s+/).map(Number);
      if(row.length!==fields.length) throw new Error('ShakeMap 网格记录不完整。');
      const x=Math.round((row[lon]-west)/dx), y=Math.round((north-row[lat])/dy);
      if(x<0||x>=width||y<0||y>=height) throw new Error('ShakeMap 网格坐标超出范围。');
      const i=y*width+x;
      if(seen[i]) throw new Error('ShakeMap 包含重复网格坐标。');
      seen[i]=1;
      if(Number.isFinite(row[pga])&&row[pga]>=0) a[i]=row[pga]*scale;
      if(Number.isFinite(row[mmi])&&row[mmi]>=1&&row[mmi]<=12) b[i]=row[mmi];
      count++;
    }
    if(count!==width*height) throw new Error('ShakeMap 网格像元数量不完整。');
    const bbox: Bounds=[west-dx/2,number('lat_min')-dy/2,number('lon_max')+dx/2,north+dy/2];
    const base={width,height,bbox,noData:null};
    grids={pga:{...base,data:a,name:'USGS ShakeMap PGA（g）'},mmi:{...base,data:b,name:'USGS ShakeMap 烈度 MMI'}};
    cache.set(url,grids); while(cache.size>2) cache.delete(cache.keys().next().value!);
  }
  const raster=grids[metric];
  if(!bounds) return raster;
  const selected=alignedWindow(raster.bbox,raster.width,raster.height,bounds);
  const [x0,y0,x1,y1]=selected.window, width=x1-x0,height=y1-y0,data=new Float32Array(width*height);
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) data[y*width+x]=raster.data[(y+y0)*raster.width+x+x0];
  return {...raster,data,width,height,bbox:selected.bbox};
}
