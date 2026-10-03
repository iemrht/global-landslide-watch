import { Activity, ArrowUpRight, LocateFixed } from 'lucide-react';

export type EventBriefProps = {
  event: { id: string; properties: { place: string; time: number; mag: number; magType?: string; url: string; catalogAgency?: string }; geometry: { coordinates: number[] } };
  availability: 'loading' | 'unverified' | 'checked';
  official: boolean;
  shakeMap: boolean;
  onLocate: () => void;
};

export function EventBrief({ event, availability, official, shakeMap, onLocate }: EventBriefProps) {
  const [lon, lat, depth] = event.geometry.coordinates;
  const coordinate = (value: number, positive: string, negative: string) => Number.isFinite(value)
    ? `${Math.abs(value).toFixed(3)}°${value >= 0 ? positive : negative}` : '待核实';
  const time = Number.isFinite(event.properties.time) ? new Date(event.properties.time).toISOString().slice(0, 16).replace('T', ' ') : '时间待核实';
  const ready = availability === 'checked';
  const products = [{ label: '官方滑坡概率', available: official }, { label: 'ShakeMap', available: shakeMap }];
  return <section className="event-brief" aria-labelledby="event-brief-heading">
    <div className="brief-heading"><Activity aria-hidden="true" /><h3 id="event-brief-heading">本次地震速览</h3></div>
    <p className="brief-place">{event.properties.place}</p>
    <div className="brief-metrics">
      <div><span>震级 · {event.properties.magType?.toUpperCase() ?? 'M'}</span><strong>{event.properties.mag.toFixed(1)}</strong></div>
      <div><span>震源深度</span><strong>{Number.isFinite(depth) ? depth.toFixed(1) : '—'}<small> km</small></strong></div>
    </div>
    <p className="brief-summary">发震时间：{time} UTC。震中位于 {coordinate(lat, 'N', 'S')}、{coordinate(lon, 'E', 'W')}。</p>
    <div className="brief-products" aria-live="polite">
      <h4>数据产品</h4>
      {products.map(product => <div key={product.label}><span>{product.label}</span><b className={ready && product.available ? 'is-ready' : 'is-pending'}>{!ready ? availability === 'loading' ? '正在核验' : '未能核验' : product.available ? '已发布' : '暂无产品'}</b></div>)}
    </div>
    <p className="brief-caution">{!ready ? '详情尚未核验完成，暂不能判断产品是否可用。' : !official ? shakeMap ? '暂无滑坡概率产品；USGS 通常在 ShakeMap 发布后生成，可稍后重新加载。缺少产品不代表没有滑坡风险。' : '暂无滑坡概率与 ShakeMap 产品，可查阅官方事件资料。缺少产品不代表没有滑坡风险。' : '“已发布”表示来源提供了产品；能否显示以地图加载结果为准。概率不等同于实际受灾范围。'}</p>
    <div className="brief-actions">
      <button type="button" onClick={onLocate}><LocateFixed aria-hidden="true" />定位震中</button>
    </div>
    <a className="brief-source" href={event.properties.url} target="_blank" rel="noreferrer">USGS 官方事件资料<ArrowUpRight aria-hidden="true" /></a>
    <p className="brief-provenance">震级来源：{event.properties.catalogAgency ?? 'USGS ComCat'}<br /><span>事件编号：{event.id}</span></p>
  </section>;
}
