/**
 * 生成航线图缩放层级标签数据（开发时一次性运行，运行时不依赖在线服务）
 *
 * 数据源:
 *   1. Natural Earth 1:110m countries / populated places（Public Domain）
 *      https://www.naturalearthdata.com/about/terms-of-use/
 *      官方维护仓库 nvkelso/natural-earth-vector:
 *      - geojson/ne_110m_admin_0_countries.geojson
 *      - geojson/ne_110m_populated_places_simple.geojson
 *   2. 中国省级标签为手工整理的公开常识数据（省份名 + 省会经纬度），见 CHINA_PROVINCES。
 *
 * 输出: src/data/travel_map_labels.json
 *   { countries: [{n,x,y}], capitals: [{n,x,y}], provinces: [{n,x,y}] }
 *   坐标已按等距圆柱投影换算到 viewBox 0 0 1000 500。
 *   原始 GeoJSON 不保留在仓库中。
 *
 * 用法: node tools/build-travel-map-labels.js [--countries <file>] [--places <file>]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { project } = require("./travel-map.js");

const NE_COUNTRIES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson";
const NE_PLACES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_populated_places_simple.geojson";
const OUT_PATH = path.join(__dirname, "..", "src", "data", "travel_map_labels.json");

/* 中国省级行政区：省份名 + 省会/首府经纬度（公开常识数据，手工整理） */
const CHINA_PROVINCES = [
  ["北京", 116.41, 39.9], ["天津", 117.2, 39.09], ["河北", 114.51, 38.04],
  ["山西", 112.55, 37.87], ["内蒙古", 111.75, 40.84], ["辽宁", 123.43, 41.8],
  ["吉林", 125.32, 43.89], ["黑龙江", 126.63, 45.75], ["上海", 121.47, 31.23],
  ["江苏", 118.78, 32.07], ["浙江", 120.15, 30.28], ["安徽", 117.28, 31.86],
  ["福建", 119.3, 26.08], ["江西", 115.89, 28.68], ["山东", 117.0, 36.65],
  ["河南", 113.65, 34.76], ["湖北", 114.3, 30.6], ["湖南", 112.98, 28.19],
  ["广东", 113.26, 23.13], ["广西", 108.33, 22.84], ["海南", 110.35, 20.02],
  ["重庆", 106.55, 29.56], ["四川", 104.07, 30.57], ["贵州", 106.71, 26.57],
  ["云南", 102.71, 25.04], ["西藏", 91.13, 29.65], ["陕西", 108.95, 34.27],
  ["甘肃", 103.82, 36.06], ["青海", 101.74, 36.56], ["宁夏", 106.27, 38.47],
  ["新疆", 87.61, 43.82], ["香港", 114.17, 22.3], ["澳门", 113.55, 22.19],
  ["台湾", 121.56, 25.03],
];

function r1(n) {
  return Math.round(n * 10) / 10;
}

/** 最大外环坐标均值作为标签点（NE 110m 无 LABEL_X/Y 时的兜底） */
function roughLabelPoint(geometry) {
  const polys =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.type === "MultiPolygon" ? geometry.coordinates : [];
  let best = null;
  for (const rings of polys) {
    if (!best || (rings[0] && rings[0].length > best.length)) best = rings[0];
  }
  if (!best || !best.length) return null;
  let sx = 0;
  let sy = 0;
  for (const [lon, lat] of best) {
    sx += lon;
    sy += lat;
  }
  return [sx / best.length, sy / best.length];
}

async function fetchJson(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`拉取失败: HTTP ${res.status} ${url}`);
  return res.json();
}

async function main() {
  const argv = process.argv.slice(2);
  const ci = argv.indexOf("--countries");
  const pi = argv.indexOf("--places");
  let countriesGeo, placesGeo;
  if (ci !== -1 && argv[ci + 1]) {
    countriesGeo = JSON.parse(fs.readFileSync(argv[ci + 1], "utf8"));
  } else {
    console.error(`拉取 Natural Earth countries: ${NE_COUNTRIES_URL}`);
    countriesGeo = await fetchJson(NE_COUNTRIES_URL);
  }
  if (pi !== -1 && argv[pi + 1]) {
    placesGeo = JSON.parse(fs.readFileSync(argv[pi + 1], "utf8"));
  } else {
    console.error(`拉取 Natural Earth populated places: ${NE_PLACES_URL}`);
    placesGeo = await fetchJson(NE_PLACES_URL);
  }

  const countries = [];
  for (const f of countriesGeo.features) {
    const p = f.properties || {};
    const name = p.NAME_ZH || p.NAME || p.ADMIN;
    if (!name) continue;
    const pt =
      Number.isFinite(p.LABEL_X) && Number.isFinite(p.LABEL_Y)
        ? [p.LABEL_X, p.LABEL_Y]
        : roughLabelPoint(f.geometry);
    if (!pt) continue;
    const { x, y } = project(pt[0], pt[1]);
    countries.push({ n: name, x: r1(x), y: r1(y) });
  }

  const capitals = [];
  for (const f of placesGeo.features) {
    const p = f.properties || {};
    if (p.featurecla !== "Admin-0 capital") continue;
    const name = p.nameascii || p.name;
    const coords = f.geometry && f.geometry.coordinates;
    if (!name || !coords) continue;
    const { x, y } = project(coords[0], coords[1]);
    capitals.push({ n: name, x: r1(x), y: r1(y) });
  }

  const provinces = CHINA_PROVINCES.map(([n, lon, lat]) => {
    const { x, y } = project(lon, lat);
    return { n, x: r1(x), y: r1(y) };
  });

  const out = { countries, capitals, provinces };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(out) + "\n", "utf8");
  console.error(
    `标签数据已生成: ${path.relative(process.cwd(), OUT_PATH)} ` +
      `（国家 ${countries.length}，首都 ${capitals.length}，中国省份 ${provinces.length}）`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`标签数据生成失败: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { CHINA_PROVINCES };
