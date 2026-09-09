/**
 * 航线图几何模块（SSR / 导入器 / 底图生成 / 测试共用）
 * - 等距圆柱投影: viewBox 0 0 1000 500，x=(lon+180)/360*1000，y=(90-lat)/180*500
 * - 纯数学函数，无 IO，无依赖
 */
"use strict";

const MAP_W = 1000;
const MAP_H = 500;

/** 经纬度 -> SVG 坐标 */
function project(lon, lat) {
  return { x: ((lon + 180) / 360) * MAP_W, y: ((90 - lat) / 180) * MAP_H };
}

/** 把经度差折叠到 [-180, 180]，用于判断是否跨越日界线 */
function unwrapDeltaLon(dLon) {
  if (dLon > 180) return dLon - 360;
  if (dLon < -180) return dLon + 360;
  return dLon;
}

function r1(n) {
  return Math.round(n * 10) / 10;
}

function roundN(n, decimals) {
  const d = decimals == null ? 1 : decimals;
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/**
 * 单段弧线（二次贝塞尔）。
 * offset: 弦中点沿左侧法线的位移（SVG 单位）。往返若共用同一条法线符号，
 * 会因方向取反而叠合，所以调用方须按「字母序走廊」统一符号。
 * 仅控制点沿法线偏移：端点必须精确落在机场坐标，保证所有航线在枢纽汇合。
 */
function arcSegment(x1, y1, x2, y2, offset) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    return { d: `M ${r1(x1)} ${r1(y1)}`, arrows: [] };
  }
  const off = offset || 0;
  const nx = -dy / len;
  const ny = dx / len;
  const ax = x1;
  const ay = y1;
  const bx = x2;
  const by = y2;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  // 二次贝塞尔在 t=0.5 时的法线偏移为控制点偏移的一半。
  const cOff = 2 * off;
  const cx = mx + nx * cOff;
  const cy = my + ny * cOff;
  const arrow = {
    x: r1((ax + 2 * cx + bx) / 4),
    y: r1((ay + 2 * cy + by) / 4),
    deg: r1((Math.atan2(dy, dx) * 180) / Math.PI),
  };
  return {
    d: `M ${r1(ax)} ${r1(ay)} Q ${r1(cx)} ${r1(cy)} ${r1(bx)} ${r1(by)}`,
    arrows: [arrow],
  };
}

/** 由航线 key 派生稳定的弯曲方向与强弱，使不同走廊的单条航线不贴在一起 */
function routeBend(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return (h % 2 === 0 ? 1 : -1) * (1 + (h % 3) * 0.35);
}

/** 无向走廊键：A-B 与 B-A 同一组，用于扇形错开 */
function corridorKey(from, to) {
  return from < to ? `${from}-${to}` : `${to}-${from}`;
}

/** 同走廊 n 条航段的中点法向位移（SVG 单位），保证相邻间距可读 */
function fanOffsets(n, len) {
  if (n <= 1) return [0];
  const gap = Math.min(6.2, Math.max(4.2, (len * 0.42) / (n - 1)));
  const out = [];
  for (let i = 0; i < n; i++) out.push(r1((i - (n - 1) / 2) * gap));
  return out;
}

/** @deprecated 兼容旧测试：第二参数 < 2 时当作默认弦长 */
function fanBends(n, lenOrBend) {
  const len = typeof lenOrBend === "number" && lenOrBend > 2 ? lenOrBend : 80;
  return fanOffsets(n, len);
}

function defaultMidOffset(len, key) {
  const bend = routeBend(key || "");
  const mag = Math.min(Math.max(len * 0.08, 4), 18);
  return r1(mag * Math.sign(bend));
}

function chordMeta(fromAp, toAp) {
  const p1 = project(fromAp.lon, fromAp.lat);
  const p2 = project(toAp.lon, toAp.lat);
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    dx,
    dy,
    len,
    nx: -dy / len,
    ny: dx / len,
    mx: (p1.x + p2.x) / 2,
    my: (p1.y + p2.y) / 2,
  };
}

/** 近平行航迹中点间距过小则沿各自法线推开（交叉航线不处理） */
function relaxOffsets(metas, offsets) {
  const n = metas.length;
  const minGap = 5.2;
  const maxAng = 28;
  for (let iter = 0; iter < 12; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = metas[i];
        const b = metas[j];
        if (a.len < 1 || b.len < 1) continue;
        const cos = Math.abs((a.dx * b.dx + a.dy * b.dy) / (a.len * b.len));
        const ang = (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
        if (ang > maxAng) continue;
        const ix = a.mx + a.nx * offsets[i];
        const iy = a.my + a.ny * offsets[i];
        const jx = b.mx + b.nx * offsets[j];
        const jy = b.my + b.ny * offsets[j];
        let vx = ix - jx;
        let vy = iy - jy;
        let dist = Math.hypot(vx, vy);
        if (dist >= minGap) continue;
        if (dist < 1e-3) {
          vx = a.nx;
          vy = a.ny;
          dist = 1;
        }
        const need = (minGap - dist) / 2 + 0.15;
        const ux = vx / dist;
        const uy = vy / dist;
        offsets[i] += need * (ux * a.nx + uy * a.ny);
        offsets[j] -= need * (ux * b.nx + uy * b.ny);
        moved++;
      }
    }
    if (!moved) break;
  }
  for (let i = 0; i < n; i++) offsets[i] = r1(offsets[i]);
  return offsets;
}

/**
 * 航线 -> { d, arrows }。跨越 180° 经线时拆成两段，
 * 分别从一侧图边出、另一侧图边入，避免横跨整张图的错误长线。
 * from/to: { lat, lon }
 * keyOrBend: 航线 key（散列弯曲）或数值弯曲系数
 */
function routeGeometry(from, to, keyOrOffset) {
  return routeSegments(from, to)
    .map(([p1, p2]) => {
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const offset = typeof keyOrOffset === "number" ? keyOrOffset : defaultMidOffset(len, keyOrOffset);
      return arcSegment(p1.x, p1.y, p2.x, p2.y, offset);
    })
    .reduce(
      (acc, seg) => ({ d: (acc.d ? acc.d + " " : "") + seg.d, arrows: acc.arrows.concat(seg.arrows) }),
      { d: "", arrows: [] }
    );
}

/**
 * 逐航段地图几何：同走廊扇形错开；往返按走廊字母序统一法线符号，避免叠合；
 * 再对近平行航迹做中点推开。
 */
function mapLegsFromDirected(airports, legs) {
  const metas = legs.map((leg) => chordMeta(airports[leg.from], airports[leg.to]));
  const groups = new Map();
  legs.forEach((leg, i) => {
    const k = corridorKey(leg.from, leg.to);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  const offsets = metas.map(() => 0);
  groups.forEach((idxs) => {
    const len = idxs.reduce((s, i) => s + metas[i].len, 0) / idxs.length;
    const k = corridorKey(legs[idxs[0]].from, legs[idxs[0]].to);
    if (idxs.length === 1) {
      offsets[idxs[0]] = defaultMidOffset(len, k);
      return;
    }
    const fan = fanOffsets(idxs.length, len);
    idxs.forEach((i, t) => {
      const sign = legs[i].from < legs[i].to ? 1 : -1;
      offsets[i] = sign * fan[t];
    });
  });
  relaxOffsets(metas, offsets);
  return legs.map((leg, i) => {
    const geo = routeGeometry(airports[leg.from], airports[leg.to], offsets[i]);
    return { from: leg.from, to: leg.to, d: geo.d, arrows: geo.arrows };
  });
}

/** 由已聚合的无向航线展开为逐次航迹（缺原始方向时全部按 from→to） */
function mapLegsFromAggregated(airports, routes) {
  const directed = [];
  for (const rt of routes) {
    const n = Math.max(1, rt.flights || 1);
    for (let i = 0; i < n; i++) directed.push({ from: rt.from, to: rt.to });
  }
  return mapLegsFromDirected(airports, directed);
}

/**
 * 航线 -> 投影后的线段序列。跨越 180° 经线时拆成两段，
 * 分别从一侧图边出、另一侧图边入，避免横跨整张图的错误长线。
 * from/to: { lat, lon }；返回 [[{x,y},{x,y}], ...]
 */
function routeSegments(from, to) {
  const dLonRaw = to.lon - from.lon;
  if (Math.abs(dLonRaw) <= 180) {
    return [[project(from.lon, from.lat), project(to.lon, to.lat)]];
  }
  const dLon = unwrapDeltaLon(dLonRaw);
  const toLonUnwrapped = from.lon + dLon; // 可能超出 ±180
  const boundary = dLon > 0 ? 180 : -180;
  const t = (boundary - from.lon) / (toLonUnwrapped - from.lon);
  const crossLat = from.lat + t * (to.lat - from.lat);
  return [
    [project(from.lon, from.lat), project(boundary, crossLat)],
    [project(-boundary, crossLat), project(to.lon, to.lat)],
  ];
}

/** 航线 -> SVG path d（跨日界线时含两个 M 子路径） */
function routePathD(from, to) {
  return routeGeometry(from, to).d;
}

module.exports = {
  MAP_W,
  MAP_H,
  project,
  unwrapDeltaLon,
  routeSegments,
  routeGeometry,
  routePathD,
  routeBend,
  corridorKey,
  fanBends,
  fanOffsets,
  mapLegsFromDirected,
  mapLegsFromAggregated,
  ringToPathD,
  lineToPathD,
  roundN,
  splitClosedRingAtDateline,
};

/**
 * 把跨 ±180° 的闭合环切成两侧各自闭合的环。
 * 禁止在切断处 Z 封口，否则会拉出一条横贯整张图的弦（西伯利亚割裂带）。
 */
function splitClosedRingAtDateline(ring) {
  if (!ring || ring.length < 3) return ring ? [ring] : [];
  const norm = (lon) => ((lon + 540) % 360) - 180;
  const pts = ring.map(([lon, lat]) => [norm(lon), lat]);
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  if (pts.length > 1 && same(pts[0], pts[pts.length - 1])) pts.pop();
  if (pts.length < 3) return [ring];

  let crosses = false;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (Math.abs(b[0] - a[0]) > 180) {
      crosses = true;
      break;
    }
  }
  if (!crosses) return [pts.concat([pts[0]])];

  const fragments = [];
  let frag = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    frag.push(a);
    const raw = b[0] - a[0];
    if (Math.abs(raw) > 180) {
      const dLon = unwrapDeltaLon(raw);
      const unwrappedB = a[0] + dLon;
      const boundary = dLon > 0 ? 180 : -180;
      const t = (boundary - a[0]) / (unwrappedB - a[0]);
      const lat = a[1] + t * (b[1] - a[1]);
      frag.push([boundary, lat]);
      fragments.push(frag);
      frag = [[-boundary, lat]];
    }
  }
  if (fragments.length === 0) return [pts.concat([pts[0]])];
  fragments[0] = frag.concat(fragments[0]);
  return fragments
    .map((f) => {
      if (f.length && same(f[0], f[f.length - 1])) f = f.slice(0, -1);
      if (f.length < 3) return f.concat(f[0] ? [f[0]] : []);
      const a = f[0];
      const b = f[f.length - 1];
      const aEdge = Math.abs(Math.abs(a[0]) - 180) < 0.05;
      const bEdge = Math.abs(Math.abs(b[0]) - 180) < 0.05;
      // 两侧图边的端点：经北极/南极闭合，禁止横贯大陆的弦
      if (aEdge && bEdge && a[0] * b[0] < 0) {
        const pole = (a[1] + b[1]) / 2 >= 0 ? 89.9 : -89.9;
        f = f.concat([[b[0], pole], [a[0], pole]]);
      }
      return f.concat([f[0]]);
    })
    .filter((f) => f.length >= 4);
}

/**
 * 经纬度折线 -> SVG path d。
 * 相邻点经度跳变超过 180° 时在图边切断并换边续画（折线用 M 换边，不 Z）。
 * coords: [[lon, lat], ...]；close=true 时每个子路径以 Z 闭合（多边形环）。
 * minDist: 投影后相邻点最小间距，用于抽稀高精度海岸线。
 * decimals: 坐标小数位，默认 1。
 */
function coordsToPathD(coords, close, minDist, decimals) {
  if (!coords || coords.length === 0) return "";
  const dist = minDist || 0;
  const dec = decimals == null ? 1 : decimals;
  const fmt = (n) => roundN(n, dec);
  const norm = (lon) => ((lon + 540) % 360) - 180;
  let d = "";
  let prev = null;
  let lastEmit = null;
  let started = false;
  const emit = (p, cmd) => {
    if (dist && lastEmit && cmd === "L") {
      if (Math.hypot(p.x - lastEmit.x, p.y - lastEmit.y) < dist) return false;
    }
    d += cmd === "M" ? ` M ${fmt(p.x)} ${fmt(p.y)}` : ` L ${fmt(p.x)} ${fmt(p.y)}`;
    lastEmit = p;
    started = true;
    return true;
  };
  const lastIdx = coords.length - 1;
  for (let i = 0; i < coords.length; i++) {
    const [rawLon, lat] = coords[i];
    const lon = norm(rawLon);
    const isEnd = i === lastIdx;
    if (prev && Math.abs(lon - prev.lon) > 180) {
      const dLon = unwrapDeltaLon(lon - prev.lon);
      const lonUnwrapped = prev.lon + dLon;
      const boundary = dLon > 0 ? 180 : -180;
      const t = (boundary - prev.lon) / (lonUnwrapped - prev.lon);
      const crossLat = prev.lat + t * (lat - prev.lat);
      emit(project(boundary, crossLat), started ? "L" : "M");
      // 折线换边用 M；闭合环应事先 splitClosedRingAtDateline，此处不再 Z
      lastEmit = null;
      emit(project(-boundary, crossLat), "M");
    }
    const p = project(lon, lat);
    // 闭合环的首尾点始终保留，避免抽稀切断轮廓
    if (isEnd || i === 0) lastEmit = null;
    emit(p, started ? "L" : "M");
    prev = { lon, lat };
  }
  return close ? d + " Z" : d;
}

/** 陆地多边形环 -> SVG path d（闭合）。跨日界线的环先切开再各自闭合。 */
function ringToPathD(ring, minDist, decimals) {
  return splitClosedRingAtDateline(ring)
    .map((r) => coordsToPathD(r, true, minDist, decimals))
    .join("");
}

/** 国界/省界折线 -> SVG path d（不闭合）。line: [[lon, lat], ...] */
function lineToPathD(line, minDist, decimals) {
  return coordsToPathD(line, false, minDist, decimals);
}
