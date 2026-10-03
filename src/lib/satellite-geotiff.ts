import { writeArrayBuffer } from 'geotiff';
export function satelliteLayout(bounds:[number,number,number,number],maxSide=4096){
  const [w,s,e,n]=bounds;
  if(!bounds.every(Number.isFinite)||w>=e||s>=n||w< -180||e>180||s< -85||n>85)throw new Error('卫星栅格仅支持不跨日期变更线、纬度±85°内的有效选区。');
  if(![2048,4096].includes(maxSide))throw new Error('卫星栅格尺寸无效');
  const R=6378137,merc=(lat:number)=>R*Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
  const box=[w*Math.PI/180*R,merc(s),e*Math.PI/180*R,merc(n)] as const;
  const ratio=(box[3]-box[1])/(box[2]-box[0]);
  const width=Math.max(1,Math.round(ratio>1?maxSide/ratio:maxSide)),height=Math.max(1,Math.round(ratio>1?maxSide:maxSide*ratio));
  return {box,width,height,pixelX:(box[2]-box[0])/width,pixelY:(box[3]-box[1])/height};
}
export function satelliteGeoTiff(rgba:Uint8ClampedArray,layout:ReturnType<typeof satelliteLayout>,zoom:number,attribution:string){
  const {width,height,box,pixelX,pixelY}=layout;
  if(rgba.length!==width*height*4)throw new Error('卫星影像像素尺寸不一致');
  const rgb=new Uint8Array(width*height*3);
  for(let i=0;i<width*height;i++){if(rgba[i*4+3]!==255)throw new Error('卫星影像存在缺失像元，已停止导出，避免把空白视为有效底图。');rgb.set(rgba.subarray(i*4,i*4+3),i*3);}
  return new Blob([writeArrayBuffer(rgb,{width,height,BitsPerSample:[8,8,8],SampleFormat:[1,1,1],PhotometricInterpretation:2,PlanarConfiguration:1,GTModelTypeGeoKey:1,ProjectedCSTypeGeoKey:3857,GTRasterTypeGeoKey:1,ModelPixelScale:[pixelX,pixelY,0],ModelTiepoint:[0,0,0,box[0],box[3],0],GTCitationGeoKey:`Esri World Imagery rendered basemap, RGB (not multispectral observations). ${attribution}. Copyright Esri and licensors. Tile zoom ${zoom}. EPSG3857 projection metres, not ground resolution; source acquisition dates vary. Export ${new Date().toISOString()}. Include this attribution on or near displayed map. https://doc.arcgis.com/en/arcgis-online/reference/static-maps.htm`})],{type:'image/tiff'});
}
