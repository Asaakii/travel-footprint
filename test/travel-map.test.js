"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MAP_W,
  MAP_H,
  project,
  routeSegments,
  routePathD,
  routeGeometry,
  ringToPathD,
  lineToPathD,
  fanBends,
  fanOffsets,
  mapLegsFromDirected,
  splitClosedRingAtDateline,
} = require("../tools/travel-map.js");
const { geojsonToPathD, isChinaAdmin1 } = require("../tools/build-travel-basemap.js");
const { csvToRecords, buildTravelData, buildAirportIndex } = require("../tools/import-travel-data.js");

test("投影边界：四角与原点", () => {
  assert.deepEqual(project(-180, 90), { x: 0, y: 0 });
  assert.deepEqual(project(180, -90), { x: MAP_W, y: MAP_H });
  assert.deepEqual(project(0, 0), { x: MAP_W / 2, y: MAP_H / 2 });
  const p = project(116.5846, 40.0801); // PEK
  assert.ok(p.x > 0 && p.x < MAP_W && p.y > 0 && p.y < MAP_H);
});

test("普通航线（不跨日界线）生成单段弧线", () => {
  const d = routePathD({ lon: 116.58, lat: 40.08 }, { lon: 103.95, lat: 30.58 }); // PEK -> CTU
  assert.equal(d.split("M").length - 1, 1);
  assert.match(d, /^M [\d.]+ [\d.]+ Q [\d.]+ [\d.]+ [\d.]+ [\d.]+$/);
});

test("跨日界线航线拆成两段，分别从图边出/入", () => {
  // 东经 170 -> 西经 170：最短路径向东跨过 180°
  const segs = routeSegments({ lon: 170, lat: 35 }, { lon: -170, lat: 20 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0][1].x, MAP_W); // 第一段到右图边
  assert.equal(segs[1][0].x, 0); // 第二段从左图边入
  assert.equal(segs[0][1].y, segs[1][0].y); // 换边处纬度连续

  const d = routePathD({ lon: 170, lat: 35 }, { lon: -170, lat: 20 });
  assert.equal(d.split("M").length - 1, 2);
  // 两段都不应横跨整张图
  for (const m of d.match(/M [\d.]+ [\d.]+ Q [\d.]+ [\d.]+ [\d.]+ [\d.]+/g)) {
    const nums = m.match(/[\d.]+/g).map(Number);
    const span = Math.abs(nums[4] - nums[0]);
    assert.ok(span < MAP_W / 2, `子路径横向跨度过大: ${span}`);
  }
});

test("西向跨日界线同样正确换边", () => {
  const segs = routeSegments({ lon: -170, lat: 20 }, { lon: 170, lat: 35 });
  assert.equal(segs.length, 2);
  assert.equal(segs[0][1].x, 0); // 到左图边
  assert.equal(segs[1][0].x, MAP_W); // 从右图边入
});

test("航线几何带中点箭头，且同 key 结果稳定", () => {
  const g1 = routeGeometry({ lon: 116.58, lat: 40.08 }, { lon: 103.95, lat: 30.58 }, "PEK-CTU");
  assert.ok(g1.d.startsWith("M "));
  assert.equal(g1.arrows.length, 1);
  assert.ok(Number.isFinite(g1.arrows[0].x) && Number.isFinite(g1.arrows[0].deg));
  assert.deepEqual(
    routeGeometry({ lon: 116.58, lat: 40.08 }, { lon: 103.95, lat: 30.58 }, "PEK-CTU"),
    g1
  );
  // 不同 key 的弯曲参数应出现差异（防同走廊重叠）
  const ds = new Set(
    ["PEK-CTU", "PEK-PVG", "PEK-SZX", "CTU-PVG"].map(
      (k) => routeGeometry({ lon: 116.58, lat: 40.08 }, { lon: 104, lat: 31 }, k).d
    )
  );
  assert.ok(ds.size > 1);
});

test("同走廊多航段扇形错开，弯曲互不相同", () => {
  const b1 = fanOffsets(1, 70);
  assert.equal(b1.length, 1);
  const b6 = fanOffsets(6, 70);
  assert.equal(b6.length, 6);
  assert.equal(new Set(b6.map((x) => x.toFixed(1))).size, 6);
  const pek = { lon: 116.58, lat: 40.08 };
  const ctu = { lon: 103.95, lat: 30.58 };
  const ds = new Set(b6.map((b) => routeGeometry(pek, ctu, b).d));
  assert.equal(ds.size, 6);
  assert.equal(fanBends(6, 70).length, 6);
});

test("扇形错开的航线端点仍精确连接机场", () => {
  const from = { lon: 116.5846, lat: 40.0801 };
  const to = { lon: 103.947, lat: 30.5785 };
  const p1 = project(from.lon, from.lat);
  const p2 = project(to.lon, to.lat);
  const d = routeGeometry(from, to, 18).d;
  const nums = d.match(/[\d.-]+/g).map(Number);

  assert.deepEqual(nums.slice(0, 2), [Math.round(p1.x * 10) / 10, Math.round(p1.y * 10) / 10]);
  assert.deepEqual(nums.slice(-2), [Math.round(p2.x * 10) / 10, Math.round(p2.y * 10) / 10]);
});

test("逐航段地图几何不合并往返，且同走廊不共线", () => {
  const airports = {
    PEK: { lat: 40.0801, lon: 116.5846 },
    CTU: { lat: 30.5785, lon: 103.947 },
  };
  const legs = mapLegsFromDirected(airports, [
    { from: "PEK", to: "CTU" },
    { from: "CTU", to: "PEK" },
    { from: "PEK", to: "CTU" },
  ]);
  assert.equal(legs.length, 3);
  assert.equal(new Set(legs.map((l) => l.d)).size, 3);
  assert.equal(legs.filter((l) => l.from === "PEK" && l.to === "CTU").length, 2);
  assert.equal(legs.filter((l) => l.from === "CTU" && l.to === "PEK").length, 1);
});

test("同走廊往返不会因法线反向而叠成一条", () => {
  const airports = {
    PEK: { lat: 40.0801, lon: 116.5846 },
    CTU: { lat: 30.5785, lon: 103.947 },
  };
  const legs = mapLegsFromDirected(airports, [
    { from: "PEK", to: "CTU" },
    { from: "CTU", to: "PEK" },
  ]);
  assert.notEqual(legs[0].d, legs[1].d);
  const mid = (d) => {
    const m = d.match(/M\s+([\d.-]+)\s+([\d.-]+)\s+Q\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)/);
    const x1 = +m[1], y1 = +m[2], cx = +m[3], cy = +m[4], x2 = +m[5], y2 = +m[6];
    return [(x1 + 2 * cx + x2) / 4, (y1 + 2 * cy + y2) / 4];
  };
  const a = mid(legs[0].d);
  const b = mid(legs[1].d);
  const gap = Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.ok(gap >= 4, `往返中点间距过小: ${gap}`);
});

test("退化到点的航线不画箭头，短程可见航线要画", () => {
  const tiny = routeGeometry({ lon: 116.58, lat: 40.08 }, { lon: 116.9, lat: 40.1 }, "PEK-NEAR");
  assert.equal(tiny.arrows.length, 0);
  // CTS→HND 量级（约 800km），原先 40 单位阈值会漏掉
  const short = routeGeometry({ lon: 141.69, lat: 42.78 }, { lon: 139.78, lat: 35.55 }, "CTS-HND");
  assert.equal(short.arrows.length, 1);
  assert.ok(Number.isFinite(short.arrows[0].deg));
});

test("抽稀会丢掉过近的中间点，但保留端点", () => {
  const dense = [];
  for (let lon = 100; lon <= 110; lon += 0.01) dense.push([lon, 30]);
  const full = lineToPathD(dense);
  const thin = lineToPathD(dense, 0.5, 1);
  assert.ok(thin.length < full.length);
  assert.match(thin.trim(), /^M /);
  assert.ok(thin.includes(" L "));
});

test("日界线两侧端点经极点闭合，不画横贯弦", () => {
  const ring = [
    [170, 65],
    [179, 66],
    [-179, 66],
    [-170, 64],
    [-175, 62],
    [175, 62],
    [170, 65],
  ];
  const d = ringToPathD(ring);
  assert.ok(!/L 0(?:\.0)? 69\.\d+ Z/.test(d) && !/L 1000(?:\.0)? 69\.\d+ Z/.test(d));
  assert.ok(d.includes(" 0.3 ") || d.includes(" 0.2 ") || d.includes(" 0.1 ") || d.includes(" 0 ")); // 北极 y≈0
});

test("闭合环跨日界线切成两侧，经度跨度不超过 180°", () => {
  const ring = [
    [170, 10],
    [179, 10],
    [-179, 10],
    [-170, 20],
    [-179, 20],
    [179, 20],
    [170, 10],
  ];
  const parts = splitClosedRingAtDateline(ring);
  assert.ok(parts.length >= 2, "应切成两侧环");
  for (const part of parts) {
    const lons = part.map((c) => c[0]);
    assert.ok(Math.max(...lons) - Math.min(...lons) <= 180 + 1e-6);
  }
  const d = ringToPathD(ring);
  assert.ok((d.split("M").length - 1) >= 2);
});

test("陆地环跨日界线时在图边切断", () => {
  // 构造一个跨越 180° 的简单环
  const d = ringToPathD([[179, 10], [181, 10], [181, 20], [179, 20], [179, 10]]);
  const mCount = d.split("M").length - 1;
  assert.ok(mCount >= 2, "跨界环应产生多个子路径");
  // 所有坐标都在画布内
  for (const n of d.match(/-?[\d.]+/g).map(Number)) {
    assert.ok(n >= 0 && n <= MAP_W || n >= 0 && n <= MAP_H, `坐标越界: ${n}`);
  }
});

test("国界折线不闭合，跨日界线时换边续画", () => {
  const d = lineToPathD([[100, 30], [110, 31]]).trim();
  assert.match(d, /^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
  assert.ok(!d.includes(" Z"), "折线不应以 Z 闭合");

  const split = lineToPathD([[170, 20], [190, 20]]);
  assert.equal(split.split("M").length - 1, 2);
  assert.ok(!split.trim().endsWith("Z"));
});

test("geojsonToPathD 支持 LineString，并按中国过滤省界", () => {
  const gj = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { adm0_a3: "CHN" },
        geometry: { type: "LineString", coordinates: [[104, 30], [108, 31]] },
      },
      {
        type: "Feature",
        properties: { adm0_a3: "USA" },
        geometry: { type: "LineString", coordinates: [[-100, 40], [-110, 41]] },
      },
    ],
  };
  assert.equal(isChinaAdmin1(gj.features[0]), true);
  assert.equal(isChinaAdmin1(gj.features[1]), false);
  const all = geojsonToPathD(gj);
  const chn = geojsonToPathD(gj, { filter: isChinaAdmin1 });
  assert.ok(all.length > chn.length);
  assert.match(chn.trim(), /^M /);
  assert.ok(!chn.includes(" Z"));
});

// ---- 与聚合数据联动 ----

const HEADER =
  "Date,From,To,Flight_Number,Airline,Distance,Duration,Seat,Seat_Type,Class,Reason,Plane,Registration,Trip,Note,From_OID,To_OID,Airline_OID,Plane_OID";

const AIRPORTS_DAT = [
  '3364,"Beijing Capital International Airport","Beijing","China","PEK","ZBAA",40.0801,116.5846,116,8,"U","Asia/Shanghai","airport","OurAirports"',
  '3395,"Chengdu Shuangliu International Airport","Chengdu","China","CTU","ZUUU",30.5785,103.947,1625,8,"U","Asia/Shanghai","airport","OurAirports"',
  '3888,"Tokyo Haneda International Airport","Tokyo","Japan","HND","RJTT",35.5523,139.78,21,9,"U","Asia/Tokyo","airport","OurAirports"',
].join("\n");

function makeRecs(rows) {
  const csv = "﻿" + HEADER + "\r\n" + rows.join("\r\n") + "\r\n";
  return csvToRecords(csv);
}

function r(date, from, to, fromOid, toOid) {
  return `${date},${from},${to},XX000,Air China,966,02:00,00A,W,Y,L,Boeing 737-800,B0000,,,"",${fromOid},${toOid},751,14734`;
}

test("年度切片航线数量/机场足迹联动，且每条航线带几何 d", () => {
  const recs = makeRecs([
    r("2025-05-01 08:00:00", "PEK", "CTU", 3364, 3395),
    r("2025-05-02 08:00:00", "CTU", "PEK", 3395, 3364),
    r("2026-01-01 08:00:00", "PEK", "HND", 3364, 3888),
  ]);
  const data = buildTravelData(recs, buildAirportIndex(AIRPORTS_DAT));

  // 全量：2 条无向航线，3 座机场
  assert.equal(data.routes.length, 2);
  assert.equal(data.footprint.airports, 3);
  // 年度联动
  assert.equal(data.years["2025"].routes.length, 1);
  assert.equal(data.years["2025"].routes[0].flights, 2);
  assert.equal(data.years["2025"].footprint.routes, 1);
  assert.equal(data.years["2025"].footprint.airports, 2);
  assert.equal(data.years["2026"].routes.length, 1);
  assert.equal(data.years["2026"].footprint.airports, 2); // PEK + HND

  // 每条航线（全量与逐年）都带预计算几何，端点坐标存在于机场表
  for (const slice of [data, ...Object.values(data.years)]) {
    const list = slice.routes || [];
    for (const rt of list) {
      assert.ok(rt.d && rt.d.startsWith("M "), `航线 ${rt.from}-${rt.to} 缺少几何 d`);
      assert.ok(data.airports[rt.from] && data.airports[rt.to]);
      assert.ok(Number.isFinite(data.airports[rt.from].lat));
    }
  }
});
