/**
 * 生成航线图底图资产（开发时一次性运行，运行时不依赖任何在线服务）
 *
 * 数据源: Natural Earth（Public Domain）
 *   https://www.naturalearthdata.com/about/terms-of-use/
 *   nvkelso/natural-earth-vector:
 *   - 远景陆地/国界: 1:50m
 *   - 近景陆地/国界/中国省界: 1:10m（抽稀后仍保留海岸线细节）
 *
 * 输出（等距圆柱投影，viewBox 0 0 1000 500）:
 *   - travel-land.svg / travel-land-detail.svg
 *   - travel-borders.svg / travel-borders-detail.svg
 *   - travel-provinces.svg
 *
 * 用法: node tools/build-travel-basemap.js
 *   [--input|--land-50|--land-10|--borders|--borders-10|--provinces <file>]
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { ringToPathD, lineToPathD } = require("./travel-map.js");

const NE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson";
const URLS = {
  land50: `${NE}/ne_50m_land.geojson`,
  land10: `${NE}/ne_10m_land.geojson`,
  borders50: `${NE}/ne_50m_admin_0_boundary_lines_land.geojson`,
  borders10: `${NE}/ne_10m_admin_0_boundary_lines_land.geojson`,
  provinces10: `${NE}/ne_10m_admin_1_states_provinces_lines.geojson`,
};
const OUT_DIR = path.join(__dirname, "..", "src", "templates", "page");

/** Natural Earth admin_1 要素是否属于中国（大陆省级，不含 TWN） */
function isChinaAdmin1(feature) {
  const p = (feature && feature.properties) || {};
  const a3 = String(p.adm0_a3 || p.ADM0_A3 || "").toUpperCase();
  const iso = String(p.iso_a2 || p.ISO_A2 || "").toUpperCase();
  const name = String(p.admin || p.ADMIN || p.adm0_name || p.ADM0_NAME || "");
  return a3 === "CHN" || iso === "CN" || name === "China";
}

/** bbox: [west, south, east, north]，经度已归一化到 [-180,180] */
function ringHitsBbox(ring, bbox) {
  if (!bbox || !ring || ring.length === 0) return true;
  const [w, s, e, n] = bbox;
  return ring.some(([lon, lat]) => {
    const x = ((lon + 540) % 360) - 180;
    return x >= w && x <= e && lat >= s && lat <= n;
  });
}

/**
 * GeoJSON -> 拼接后的 SVG path d。
 * options: { filter, minDist, decimals, bbox }
 */
function geojsonToPathD(geojson, options) {
  const opt = options || {};
  const filter = opt.filter;
  const minDist = opt.minDist || 0;
  const decimals = opt.decimals == null ? 1 : opt.decimals;
  const bbox = opt.bbox;
  const parts = [];
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  for (const f of features) {
    if (filter && !filter(f)) continue;
    const g = f.geometry || (f.type && f.type !== "Feature" ? f : null);
    if (!g) continue;
    if (g.type === "LineString") {
      if (!ringHitsBbox(g.coordinates, bbox)) continue;
      const d = lineToPathD(g.coordinates, minDist, decimals);
      if (d.length > 4) parts.push(d);
    } else if (g.type === "MultiLineString") {
      for (const line of g.coordinates) {
        if (!ringHitsBbox(line, bbox)) continue;
        const d = lineToPathD(line, minDist, decimals);
        if (d.length > 4) parts.push(d);
      }
    } else {
      const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      for (const rings of polys) {
        for (const ring of rings) {
          if (!ringHitsBbox(ring, bbox)) continue;
          const d = ringToPathD(ring, minDist, decimals);
          if (d.length > 4) parts.push(d);
        }
      }
    }
  }
  if (parts.length === 0) throw new Error("底图源数据中没有可用的几何");
  return parts.join(" ");
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

async function readOrFetch(localPath, url, label) {
  if (localPath) return fs.readFileSync(localPath, "utf8");
  console.error(`正在一次性拉取 ${label}: ${url}`);
  return fetchText(url);
}

function header(what, src) {
  return (
    `<!-- ${what}。来源: Natural Earth (Public Domain)，nvkelso/natural-earth-vector 仓库 ${src}；` +
    `由 tools/build-travel-basemap.js 生成，等距圆柱投影，viewBox 坐标系 0 0 1000 500。勿手工编辑。 -->\n`
  );
}

function writeSvg(file, html) {
  fs.writeFileSync(path.join(OUT_DIR, file), html, "utf8");
  return Math.round(html.length / 1024);
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const land50Text = await readOrFetch(
      argValue(argv, "--land-50") || argValue(argv, "--input"),
      URLS.land50,
      "Natural Earth 50m land"
    );
    const land10Text = await readOrFetch(argValue(argv, "--land-10"), URLS.land10, "Natural Earth 10m land");
    const borders50Text = await readOrFetch(
      argValue(argv, "--borders") || argValue(argv, "--countries"),
      URLS.borders50,
      "Natural Earth 50m admin 0 boundary lines"
    );
    const borders10Text = await readOrFetch(
      argValue(argv, "--borders-10"),
      URLS.borders10,
      "Natural Earth 10m admin 0 boundary lines"
    );
    const provincesText = await readOrFetch(
      argValue(argv, "--provinces"),
      URLS.provinces10,
      "Natural Earth 10m admin 1 province lines"
    );

    console.error("正在投影 / 抽稀…");
    const land50D = geojsonToPathD(JSON.parse(land50Text), { minDist: 0.18, decimals: 1 });
    // 近景精细层覆盖欧亚非（含埃及/印尼/日本），美洲仍用 50m 底图
    const detailBbox = [15, -20, 180, 82];
    const land10D = geojsonToPathD(JSON.parse(land10Text), {
      minDist: 0.08,
      decimals: 2,
      bbox: detailBbox,
    });
    const borders50D = geojsonToPathD(JSON.parse(borders50Text), { minDist: 0.12, decimals: 1 });
    const borders10D = geojsonToPathD(JSON.parse(borders10Text), {
      minDist: 0.05,
      decimals: 2,
      bbox: detailBbox,
    });
    const provincesJson = JSON.parse(provincesText);
    const provinceCount = (provincesJson.features || []).filter(isChinaAdmin1).length;
    const provincesD = geojsonToPathD(provincesJson, {
      filter: isChinaAdmin1,
      minDist: 0.035,
      decimals: 2,
    });

    const kbLand = writeSvg(
      "travel-land.svg",
      header("世界陆地轮廓（远/中景 50m）", "ne_50m_land.geojson") +
        `<path class="travel-land-path" d="${land50D}"/>\n`
    );
    const kbLandDetail = writeSvg(
      "travel-land-detail.svg",
      header("世界陆地轮廓（近景 10m）", "ne_10m_land.geojson") +
        `<path class="travel-land-detail-path" d="${land10D}"/>\n`
    );
    const kbBorders = writeSvg(
      "travel-borders.svg",
      header("世界国界折线（远/中景 50m）", "ne_50m_admin_0_boundary_lines_land.geojson") +
        `<path class="travel-borders-path" d="${borders50D}"/>\n`
    );
    const kbBordersDetail = writeSvg(
      "travel-borders-detail.svg",
      header("世界国界折线（近景 10m）", "ne_10m_admin_0_boundary_lines_land.geojson") +
        `<path class="travel-borders-detail-path" d="${borders10D}"/>\n`
    );
    const kbProvinces = writeSvg(
      "travel-provinces.svg",
      header("中国省界折线（近景 10m）", "ne_10m_admin_1_states_provinces_lines.geojson") +
        `<path class="travel-provinces-path" d="${provincesD}"/>\n`
    );
    console.error(
      `底图已生成: land ${kbLand} KB / land-detail ${kbLandDetail} KB, ` +
        `borders ${kbBorders} KB / borders-detail ${kbBordersDetail} KB, ` +
        `provinces ${kbProvinces} KB（中国省级要素 ${provinceCount}）`
    );
  } catch (err) {
    console.error(`底图源数据拉取/解析失败: ${err.message}。可改用 --land-50 / --land-10 / --borders / --provinces 指定本地文件`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`底图生成失败: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { geojsonToPathD, isChinaAdmin1 };
