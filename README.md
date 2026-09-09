# Travel Footprint

独立的静态飞行足迹与行程统计站点，展示航线地图、年度统计、机场/城市/国家/大洲明细，以及年度飞行报告。

## 本地使用

```bash
npm install
npm run build
npm run dev
```

页面模板、地图矢量和前端逻辑都在本项目中；首次构建不依赖原博客项目。

## 更新行程数据

```bash
npm run travel:import -- /path/to/openflights.csv
npm run build
```

导入器仅生成脱敏聚合数据；请不要提交原始航班 CSV、票号、订单信息或备注。

## 许可证

项目代码采用 [MIT License](LICENSE)。该许可证不授予第三方素材或商标的任何权利。

## 素材与商标

航司和制造商标识的来源及使用说明见 `src/assets/img/travel/SOURCES.txt`。相关商标仍归其权利人所有。
