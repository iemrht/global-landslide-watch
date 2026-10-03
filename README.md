# 全球震后滑坡概率图

全球震后地震滑坡概率交互网站，纯静态部署在 GitHub Pages，不需要服务器。浏览器直接读取 USGS ComCat 地震目录与 USGS Ground Failure 产品中的官方滑坡概率栅格（主滑坡模型 Nowicki Jessee et al., 2018）。

本项目由课题组“全球震后液化概率图”（MrDou01/global-liquefaction-map）改写而来：保留地震目录、地图、自动监测与成果导出框架，去掉课题组液化模型及 PGA / 烈度图层，官方图层改为滑坡概率。

## 功能

- 按日期、地区、地图范围和关键词筛选全球 M≥6.0 地震；每 60 秒自动校核新地震，并持续等待新震的滑坡概率产品。
- 叠加 USGS Ground Failure 官方滑坡概率（约 250 m 网格），显示 GF 滑坡预警等级。
- 框选或采用当前视窗，导出原生像元 GeoTIFF（WGS84 Float32）、透明 PNG、带卫星或标准底图的综合成图 PNG / A3 PDF。
- 直接下载 USGS 原始滑坡概率 GeoTIFF。
- 前端访问密码（仅作一般访问控制，不等同于服务器端保密）。

## 官方文件匹配

代码按前缀 `jessee_2018` 在 ground-failure 产品的 contents 中查找 `.tif` / `.png`，优先 `jessee_2018_model.tif`，并排除不确定度等附属文件（见 `src/App.tsx` 中的 `officialContentKey`）。若 USGS 更改命名，只需修改那里。

## 色阶

分档与液化站一致：0.1–1%、1–3%、3–10%、10–30%、≥30%，低于 0.1% 透明。修改位置：`src/App.tsx` 中的 `PROBABILITY_STOPS` 与 `probabilityRgba`。

## 本地运行

    pnpm install
    pnpm dev

## 修改访问密码

    pnpm set-password

按提示输入新密码，脚本只把 SHA-256 摘要写入 `src/StaticAccessGate.tsx`。提交并推送后自动重新部署。

## 部署

推送到 `main` 分支后，`.github/workflows/deploy-pages.yml` 自动构建并发布到 GitHub Pages。仓库需为公开仓库（免费账户的 Pages 要求），并在仓库 Settings → Pages 中把 Source 设为 GitHub Actions。

## 可靠性边界

- 概率用于区域尺度震后快速筛查，不替代现场调查、斜坡稳定性评价或应急结论。
- USGS 并非对每次地震都发布 Ground Failure 产品；未发布或空白不代表没有滑坡风险。
- 区域导出不插值放大；GeoTIFF 使用 EPSG:4326、Float32 与显式 NoData。

## 数据来源

- USGS FDSN Event Web Service / ComCat
- USGS Ground Failure：https://earthquake.usgs.gov/data/ground-failure/
- Nowicki Jessee, M.A., et al., 2018. A global empirical model for near-real-time assessment of seismically induced landslides. JGR: Earth Surface.
- 底图：OpenStreetMap、Esri World Imagery
