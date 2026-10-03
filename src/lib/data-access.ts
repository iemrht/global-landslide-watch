let retryAllowedAt = 0;

// 纯静态站：只直连 USGS 官方站点，不依赖任何中转服务器。
export function resourceRoutes(url: string) {
  const upstream = new URL(url);
  if (upstream.origin !== 'https://earthquake.usgs.gov') throw new Error('数据来源必须为 USGS 官方站点。');
  return [url];
}

/** Read the entire bounded response before ending its deadline (not just headers). */
export async function fetchUsgs(url: string, options: { signal?: AbortSignal; range?: [number, number]; totalBytes?: number } = {}) {
  if (Date.now() < retryAllowedAt) throw new Error(`官方服务请求过密，请约 ${Math.ceil((retryAllowedAt - Date.now()) / 60000)} 分钟后重试。`);
  const routes = resourceRoutes(url);
  let lastError = '';
  for (const route of [...routes, routes[0]]) {
    if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const controller = new AbortController();
    const abort = () => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 35_000);
    try {
      const isRelay = route.includes('/api/public-usgs?');
      const rangedRoute = options.range && isRelay ? `${route}&range=${options.range.join('-')}` : route;
      const response = await fetch(rangedRoute, { signal: controller.signal, credentials: route.startsWith('/') ? 'same-origin' : 'omit',
        headers: options.range && !isRelay ? { Range: `bytes=${options.range.join('-')}` } : undefined });
      if (response.status === 429) {
        retryAllowedAt = Date.now() + Math.max(300, Number(response.headers.get('retry-after')) || 300) * 1000;
        throw new Error('官方服务请求过密，已暂停请求，请 5 分钟后重试。');
      }
      if (!response.ok) {
        // Not-published resources are not transient transport failures.
        if ([404, 409, 410].includes(response.status)) throw new Error(`官方事件或文件未发布或已撤回（${response.status}）；不能生成该产品。`);
        throw new Error(`HTTP ${response.status}`);
      }
      if ((response.headers.get('content-type') ?? '').includes('text/html')) throw new Error('数据线路返回了网页而不是数据文件');
      const resultHeaders = new Headers(response.headers);
      if (options.range) {
        // USGS permits cross-origin bodies but may not expose Content-Range to browsers.
        // For a direct 206 only, validate the body against the exact versioned product's
        // declared byte length. This keeps Pages independent of the main-site relay.
        if (!isRelay && response.status === 206 && !resultHeaders.has('content-range')
          && Number.isSafeInteger(options.totalBytes) && options.totalBytes! > options.range[0]) {
          resultHeaders.set('content-range', `bytes ${options.range[0]}-${Math.min(options.range[1], options.totalBytes! - 1)}/${options.totalBytes}`);
        }
        const match = resultHeaders.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
        if (response.status !== 206 || !match || Number(match[1]) !== options.range[0]
          || Number(match[2]) !== Math.min(options.range[1], Number(match[3]) - 1)) {
          await response.body?.cancel(); throw new Error('数据线路未正确返回所需分块');
        }
      }
      if (Number(response.headers.get('content-length') ?? 0) > 64 * 1024 * 1024) throw new Error('文件超过在线读取大小限制（64 MB）');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('文件超过在线读取大小限制（64 MB）');
      if (options.range && bytes.byteLength !== Number(resultHeaders.get('content-range')!.match(/^bytes \d+-(\d+)\//)![1]) - options.range[0] + 1) {
        throw new Error('分块文件不完整');
      }
      return new Response(bytes, { status: response.status, headers: resultHeaders });
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      lastError = error instanceof Error ? error.message : String(error);
      if (/未发布或已撤回|大小限制|请求过密/.test(lastError)) break;
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  }
  throw new Error(`数据加载失败，两次尝试均未成功：${lastError}。请点击“重新加载”；空白不代表无风险。`);
}

export async function verifiedImageUrl(source: string) {
  const response = await fetchUsgs(source);
  const url = URL.createObjectURL(await response.blob());
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      const timer = setTimeout(() => { image.src = ''; reject(new Error('预览图解码超时')); }, 15_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('官方预览图解码失败')); };
      image.src = url;
    });
    return url;
  } catch (error) { URL.revokeObjectURL(url); throw error; }
}

export const LIVE_BASEMAPS = [
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap contributors', label: 'OpenStreetMap' },
  { url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', attribution: 'Tiles © Esri — Esri, HERE, Garmin, USGS, OpenStreetMap contributors', label: 'Esri 街道底图' },
];

export type LiveBasemap = 'street' | 'satellite';
export function liveBasemapSources(mode: LiveBasemap) {
  if (mode === 'street') return LIVE_BASEMAPS;
  const attribution = '卫星影像 © Esri — Esri, Vantor/Maxar, Earthstar Geographics, and the GIS User Community';
  return [{url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', attribution, label: 'Esri 卫星影像'}];
}
