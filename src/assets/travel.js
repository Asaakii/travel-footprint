/**
 * 行程统计页交互
 * - 仅在 #travel 页面生效；幂等初始化，兼容 PJAX 重复进入，不重复绑定
 * - 数据来源为页面内嵌的脱敏聚合 JSON（#travel-data），不发起任何网络请求
 * - 地图支持拖动与滚轮缩放；按缩放级别切换 大洲/国家/首都/省份 标签层
 */
(function () {
  "use strict";

  /* 航司中文显示名（仅 UI 映射；JSON 保留原始聚合键） */
  var AIRLINE_NAMES = {
    "Air China": "中国国航",
    Egyptair: "埃及航空",
    "Air Cairo": "开罗航空",
    "China Southern Airlines": "南方航空",
    "Shanghai Airlines": "上海航空",
    "China Eastern Airlines": "东方航空",
    "All Nippon Airways": "全日空",
    "Sichuan Airlines": "四川航空",
    "Loong Air": "长龙航空",
    "Malindo Air": "马印航空",
    AirAsia: "亚洲航空",
    "Xiamen Airlines": "厦门航空",
    "VietJet Air": "越捷航空",
  };
  /* 可验证的真实标志来源；没有在此表中的航司使用项目内已有的 SVG。 */
  var AIRLINE_LOGO_SOURCES = {
    "China Eastern Airlines": "https://upload.wikimedia.org/wikipedia/en/6/6b/China_Eastern_Airlines_logo.svg",
    Egyptair: "https://upload.wikimedia.org/wikipedia/commons/c/c2/Egyptair-Logo-2010.svg",
    "Loong Air": "https://upload.wikimedia.org/wikipedia/en/3/35/LoongAir_logo.png",
    "Shanghai Airlines": "https://upload.wikimedia.org/wikipedia/en/4/4e/Shanghai_Airlines.svg",
    "Xiamen Airlines": "https://www.xiamenair.com/i18n-ow-_nuxt/img/logo@3x.7a49c02.svg",
  };

  var CONT_ZH = {
    Asia: "亚洲",
    Europe: "欧洲",
    Africa: "非洲",
    "North America": "北美洲",
    "South America": "南美洲",
    Oceania: "大洋洲",
    Antarctica: "南极洲",
  };

  var PRISM_COLORS = ["cyan", "green", "blue", "violet"];
  var MFR_BIG3 = [
    { key: "Airbus", zh: "空客" },
    { key: "Boeing", zh: "波音" },
    { key: "COMAC", zh: "中国商飞" },
  ];
  /* 机场城市 UI 显示映射（仅展示层；不改 JSON 原始字段） */
  var CITY_DISPLAY = { TFU: "成都天府" };
  /* 用户在 OpenFlights 导出中标记的航段用紫色；其余航段统一青色。 */
  var PURPLE_LEGS = {
    "CAI-PEK": 1,
    "CAI-ASW": 1,
    "IST-CAI": 1,
    "PKX-IST": 1,
    "NRT-PVG": 1,
    "OKA-HND": 1,
    "ITM-OKA": 1,
    "PVG-KIX": 1,
    "NRT-DLC": 1,
    "CTS-HND": 1,
    "HKD-CTS": 1,
    "HND-CTS": 1,
    "DLC-NRT": 1,
  };
  var STROKE_CYAN = "#57f1ed";
  var STROKE_VIOLET = "#9a7cff";
  var DETAIL_RETURN_SCROLL_KEY = "travel-detail-return-scroll";
  function isPurpleLeg(rt) {
    return !!PURPLE_LEGS[rt.from + "-" + rt.to];
  }
  function legColor(rt) {
    return isPurpleLeg(rt) ? "lc2" : "lc0";
  }
  function legStroke(rt) {
    return isPurpleLeg(rt) ? STROKE_VIOLET : STROKE_CYAN;
  }
  /* 环形里程仪表周长（r=70，与 SSR 一致） */
  var GAUGE_C = Math.round(2 * Math.PI * 70 * 100) / 100;
  var MILESTONE_KM = 100000;
  /* 地图视窗：完整世界 / 移动端聚焦亚太 */
  var MAP_FULL = { x: 0, y: 0, w: 1000, h: 500 };
  var MAP_APAC = { x: 652, y: 76, w: 308, h: 218 }; // 约东经 55°–165°、北纬 62°–南纬 15°
  var MAP_MIN_W = 80;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtInt(n) {
    return Number(n).toLocaleString("en-US");
  }
  function alName(k) {
    return AIRLINE_NAMES[k] || k;
  }
  function alSlug(k) {
    return k.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function alLogo(k) {
    return AIRLINE_LOGO_SOURCES[k] || "/img/travel/airlines/" + alSlug(k) + ".svg";
  }
  function durationText(min) {
    return { h: Math.floor(min / 60), m: min % 60 };
  }
  /* logo 加载失败时隐藏 img，露出后层文字徽标 */
  function armLogoFallback(scope) {
    scope.querySelectorAll("img").forEach(function (img) {
      var mark = function () {
        img.classList.add("is-missing");
      };
      if (img.complete && img.naturalWidth === 0) mark();
      else img.addEventListener("error", mark);
    });
  }

  function initTravelPage() {
    var root = document.getElementById("travel");
    if (!root || root.dataset.travelInited === "1") return;
    var dataEl = document.getElementById("travel-data");
    if (!dataEl) return; // 明细页无内嵌数据，纯 SSR
    var data;
    try {
      data = JSON.parse(dataEl.textContent);
    } catch (e) {
      return;
    }
    root.dataset.travelInited = "1";

    /* 五个足迹入口跳转前记录位置；二级页返回后由本页恢复一次。 */
    root.querySelectorAll("a.travel-fp-card").forEach(function (link) {
      link.addEventListener("click", function (event) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        try {
          window.sessionStorage.setItem(DETAIL_RETURN_SCROLL_KEY, String(Math.round(window.scrollY)));
        } catch (e) {
          /* 隐私模式等禁用 sessionStorage 时，保持普通返回行为。 */
        }
      });
    });

    var yearKeys = Object.keys(data.years).sort().reverse();
    var latestYear = yearKeys[0];
    var currentYear = "all";
    var airlinesExpanded = false;
    var modelsExpanded = false;
    var calView = "year";
    var calendarSelectedYear = latestYear;

    function sliceFor(year) {
      if (year === "all") {
        return {
          totals: {
            flights: data.overall.flights,
            distanceKm: data.overall.distanceKm,
            durationMin: data.overall.durationMin,
          },
          routes: data.routes,
          mapLegs: data.mapLegs,
          airlines: data.airlines,
          manufacturers: data.manufacturers,
          aircraft: data.aircraft,
          aircraftKnownFlights: data.overall.aircraftKnownFlights,
          aircraftUnknownFlights: data.overall.aircraftUnknownFlights,
          footprint: data.footprint,
        };
      }
      return data.years[year];
    }

    function setField(name, text) {
      root.querySelectorAll('[data-field="' + name + '"]').forEach(function (el) {
        el.textContent = text;
      });
    }

    function periodText() {
      return currentYear === "all" ? "全部" : currentYear + " 年";
    }

    /* 端点航段数（所选切片内） */
    function airportEndpointCounts(s) {
      var apCount = {};
      s.routes.forEach(function (rt) {
        apCount[rt.from] = (apCount[rt.from] || 0) + rt.flights;
        apCount[rt.to] = (apCount[rt.to] || 0) + rt.flights;
      });
      return apCount;
    }

    /* 给每座机场安排一个不与已放置标签相撞的 IATA 标签位置。 */
    function airportLabelPositions(apCount, project, scale) {
      scale = scale || 1;
      var placed = [];
      var positions = {};
      var candidates = [];
      [10, 24, 40, 56, 72, 88].forEach(function (baseRadius) {
        var radius = baseRadius * scale;
        for (var step = 0; step < 8; step++) {
          var angle = (step * Math.PI) / 4;
          var dx = Math.cos(angle) * radius;
          candidates.push({ dx: dx, dy: Math.sin(angle) * radius + 4 * scale, anchor: dx >= 0 ? "start" : "end" });
        }
      });
      var intersects = function (a, b) {
        var gap = 2 * scale;
        return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
      };
      var nodeBoxes = Object.keys(apCount).map(function (iata) {
        var ap = data.airports[iata];
        var p = project(ap.lon, ap.lat);
        return { x: p.x - 7 * scale, y: p.y - 7 * scale, w: 14 * scale, h: 14 * scale };
      });

      Object.keys(apCount)
        .sort(function (a, b) {
          return apCount[b] - apCount[a] || a.localeCompare(b);
        })
        .forEach(function (iata) {
          var ap = data.airports[iata];
          if (!ap) return;
          var p = project(ap.lon, ap.lat);
          var width = (iata.length * 7.5 + 3) * scale;
          var selected;
          candidates.some(function (c) {
            var x = Math.min(Math.max(p.x + c.dx, c.anchor === "start" ? 4 * scale : width + 4 * scale), c.anchor === "start" ? 996 - width : 996);
            var y = Math.min(Math.max(p.y + c.dy, 12 * scale), 494);
            var box = { x: c.anchor === "start" ? x : x - width, y: y - 11 * scale, w: width, h: 14 * scale };
            if (placed.some(function (other) { return intersects(box, other); }) || nodeBoxes.some(function (node) { return intersects(box, node); })) return false;
            selected = { x: x, y: y, anchor: c.anchor, box: box };
            return true;
          });
          if (!selected) {
            var fallback = candidates[candidates.length - 1];
            var fx = Math.min(Math.max(p.x + fallback.dx, 4 * scale), 996 - width);
            var fy = Math.min(Math.max(p.y + fallback.dy, 12 * scale), 494);
            selected = { x: fx, y: fy, anchor: fallback.anchor, box: { x: fx, y: fy - 11 * scale, w: width, h: 14 * scale } };
          }
          placed.push(selected.box);
          positions[iata] = selected;
        });
      return positions;
    }

    /* ================= 地图 ================= */
    var mapSvg = root.querySelector(".travel-map-svg");
    var vb = { x: MAP_FULL.x, y: MAP_FULL.y, w: MAP_FULL.w, h: MAP_FULL.h };
    var arrowPaths = [];
    var renderedMapSlice = null;

    /* 缩放系数：1 屏幕像素对应的世界坐标数，用于标签/节点/箭头反比缩放保持屏幕尺寸恒定 */
    function currentZl() {
      if (!mapSvg) return 1;
      var rect = mapSvg.getBoundingClientRect();
      return rect.width ? vb.w / rect.width : vb.w / MAP_FULL.w;
    }

    function updateArrowScale() {
      if (!mapSvg) return;
      var zl = currentZl();
      mapSvg.style.setProperty("--zl", zl.toFixed(4));
      for (var i = 0; i < arrowPaths.length; i++) {
        arrowPaths[i].setAttribute("transform", arrowPaths[i].dataset.base + " scale(" + zl.toFixed(3) + ")");
      }
    }

    function primeArrows() {
      var g = root.querySelector('[data-field="mapArrows"]');
      arrowPaths = g ? Array.prototype.slice.call(g.querySelectorAll("path")) : [];
      arrowPaths.forEach(function (p) {
        if (!p.dataset.base) p.dataset.base = p.getAttribute("transform") || "";
      });
      updateArrowScale();
    }

    function renderAirportLayer(s) {
      var apCount = airportEndpointCounts(s);
      var iatas = Object.keys(apCount);
      var project = function (lon, lat) {
        return { x: ((lon + 180) / 360) * 1000, y: ((90 - lat) / 180) * 500 };
      };
      var labelPositions = airportLabelPositions(apCount, project, currentZl());
      var apsHtml = iatas
        .map(function (iata) {
          var ap = data.airports[iata];
          if (!ap) return "";
          var p = project(ap.lon, ap.lat);
          var rr = Math.min(2 + Math.sqrt(apCount[iata]) * 1.2, 6);
          return (
            '<circle class="travel-map-halo" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (rr * 2.2).toFixed(1) + '" style="--r:' + (rr * 2.2).toFixed(1) + 'px"/>' +
            '<circle class="travel-map-node" cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + rr.toFixed(1) + '" style="--r:' + rr.toFixed(1) + 'px">' +
            '<title>' + esc(iata + " · " + ap.city + "，" + apCount[iata] + " 航段") + "</title></circle>"
          );
        })
        .join("");
      apsHtml += iatas
        .map(function (iata) {
          var pos = labelPositions[iata];
          return '<text class="travel-map-aplabel" text-anchor="' + pos.anchor + '" x="' + pos.x.toFixed(1) + '" y="' + pos.y.toFixed(1) + '">' + esc(iata) + "</text>";
        })
        .join("");
      root.querySelector('[data-field="mapAirports"]').innerHTML = apsHtml;
    }

    function clampVB() {
      if (vb.w >= MAP_FULL.w) {
        vb.x = 0;
        vb.y = 0;
        vb.w = MAP_FULL.w;
        vb.h = MAP_FULL.h;
        return;
      }
      vb.x = Math.min(Math.max(vb.x, 0), MAP_FULL.w - vb.w);
      vb.y = Math.min(Math.max(vb.y, 0), MAP_FULL.h - vb.h);
    }

    function applyViewBox() {
      if (!mapSvg) return;
      mapSvg.setAttribute(
        "viewBox",
        [vb.x.toFixed(1), vb.y.toFixed(1), vb.w.toFixed(1), vb.h.toFixed(1)].join(" ")
      );
      var z = MAP_FULL.w / vb.w;
      mapSvg.setAttribute("data-zoom", z >= 3 ? "near" : z >= 1.6 ? "mid" : "far");
      updateArrowScale();
      if (renderedMapSlice) renderAirportLayer(renderedMapSlice);
    }

    function resetMapViewport() {
      var mobile = window.matchMedia("(max-width: 768px)").matches;
      var base = mobile ? MAP_APAC : MAP_FULL;
      vb = { x: base.x, y: base.y, w: base.w, h: base.h };
      if (mapSvg) mapSvg.setAttribute("preserveAspectRatio", mobile ? "xMidYMid meet" : "xMidYMid slice");
      applyViewBox();
    }

    function bindMapPanZoom() {
      if (!mapSvg) return;
      /* 滚轮缩放：按 deltaY 指数归一化（触控板/鼠标滚轮都线性），rAF 合帧 */
      var pendingDelta = 0;
      var zoomAnchor = null;
      var zoomRaf = 0;
      mapSvg.addEventListener(
        "wheel",
        function (e) {
          e.preventDefault();
          var dy = e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
          pendingDelta += Math.max(-100, Math.min(100, dy));
          zoomAnchor = { x: e.clientX, y: e.clientY };
          if (!zoomRaf) {
            zoomRaf = requestAnimationFrame(function () {
              zoomRaf = 0;
              var rect = mapSvg.getBoundingClientRect();
              var px = vb.x + ((zoomAnchor.x - rect.left) / rect.width) * vb.w;
              var py = vb.y + ((zoomAnchor.y - rect.top) / rect.height) * vb.h;
              var factor = Math.exp(Math.max(-240, Math.min(240, pendingDelta)) * 0.0022);
              pendingDelta = 0;
              var nw = Math.min(MAP_FULL.w, Math.max(MAP_MIN_W, vb.w * factor));
              var scale = nw / vb.w;
              vb.x = px - (px - vb.x) * scale;
              vb.y = py - (py - vb.y) * scale;
              vb.w = nw;
              vb.h = nw / 2;
              clampVB();
              applyViewBox();
            });
          }
        },
        { passive: false }
      );
      var drag = null;
      var clearMapSelection = function () {
        var sel = window.getSelection && window.getSelection();
        if (sel && sel.removeAllRanges) sel.removeAllRanges();
      };
      mapSvg.addEventListener("selectstart", function (e) {
        e.preventDefault();
      });
      mapSvg.addEventListener("dragstart", function (e) {
        e.preventDefault();
      });
      mapSvg.addEventListener("pointerdown", function (e) {
        e.preventDefault();
        clearMapSelection();
        drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y };
        mapSvg.setPointerCapture(e.pointerId);
        mapSvg.classList.add("is-dragging");
      });
      mapSvg.addEventListener("pointermove", function (e) {
        if (!drag) return;
        clearMapSelection();
        var rect = mapSvg.getBoundingClientRect();
        vb.x = drag.vx - ((e.clientX - drag.x) / rect.width) * vb.w;
        vb.y = drag.vy - ((e.clientY - drag.y) / rect.height) * vb.h;
        clampVB();
        applyViewBox();
      });
      var endDrag = function () {
        drag = null;
        mapSvg.classList.remove("is-dragging");
        clearMapSelection();
      };
      mapSvg.addEventListener("pointerup", endDrag);
      mapSvg.addEventListener("pointercancel", endDrag);
    }

    function renderMap(s) {
      renderedMapSlice = s;
      var legs = s.mapLegs && s.mapLegs.length ? s.mapLegs : s.routes;
      setField("mapMeta", periodText() + " · " + legs.length + " 条航迹 · " + s.footprint.airports + " 座机场");

      var coreHtml = "";
      var arrowHtml = "";
      legs.forEach(function (rt) {
        var lc = legColor(rt);
        var stroke = legStroke(rt);
        var label = rt.from + " → " + rt.to;
        coreHtml +=
          '<path class="' +
          lc +
          '" d="' +
          esc(rt.d) +
          '" style="stroke:' +
          stroke +
          ';stroke-width:1.75;opacity:0.82" tabindex="0" role="img" aria-label="' +
          esc(label) +
          '"><title>' +
          esc(label) +
          "</title></path>";
        (rt.arrows || []).forEach(function (a) {
          arrowHtml +=
            '<path class="' + lc + '" d="M -3.6 -2.6 L 4 0 L -3.6 2.6 Z" style="fill:' + stroke + ';stroke:none" transform="translate(' + a.x + " " + a.y + ") rotate(" + a.deg + ')"/>';
        });
      });
      root.querySelector('[data-field="mapRoutes"]').innerHTML = coreHtml;
      root.querySelector('[data-field="mapArrows"]').innerHTML = arrowHtml;
      primeArrows();

      renderAirportLayer(s);
    }

    /* ================= 总览仪表盘 ================= */
    function renderDash(s) {
      var km = s.totals.distanceKm;
      var pct = Math.min(km / MILESTONE_KM, 1);
      setField("gaugeKm", fmtInt(km));
      setField("gaugePct", "十万公里里程碑 " + Math.round(pct * 100) + "%");
      var arc = root.querySelector('[data-field="gaugeArc"]');
      if (arc) arc.style.strokeDashoffset = (GAUGE_C * (1 - pct)).toFixed(2);

      var d = durationText(s.totals.durationMin);
      setField("rDistance", fmtInt(km));
      setField("rDurationH", String(d.h));
      setField("rDurationM", String(d.m));
      setField("rFlights", String(s.totals.flights));
    }

    /* ================= 五项足迹 ================= */
    function renderFootprint(s) {
      setField("continents", s.footprint.continents);
      setField("countries", s.footprint.countries);
      setField("cities", s.footprint.cities);
      setField("airports", s.footprint.airports);
      setField("routes", s.footprint.routes);

      var chipsEl = root.querySelector('[data-field="continentChips"]');
      if (chipsEl) {
        chipsEl.innerHTML = (s.footprint.continentList || [])
          .map(function (c) {
            return '<span class="travel-fp-chip">' + esc(CONT_ZH[c] || c) + "</span>";
          })
          .join("");
      }

      var apCount = airportEndpointCounts(s);
      var topAp = Object.keys(apCount).sort(function (a, b) {
        return apCount[b] - apCount[a];
      })[0];
      setField("tagTopAirport", topAp && data.airports[topAp] ? CITY_DISPLAY[topAp] || data.airports[topAp].city : "—");
      var topRoute = s.routes[0];
      setField("tagTopRoute", topRoute ? topRoute.from + "-" + topRoute.to : "—");
    }

    /* ================= 年度飞行报告 ================= */
    function renderReport(s) {
      setField("reportTitle", currentYear === "all" ? "全部飞行报告" : currentYear + " 年度飞行报告");
      setField("reportSub", (currentYear === "all" ? "累计 " : "当年 ") + s.totals.flights + " 次飞行");
      var d = durationText(s.totals.durationMin);
      setField("repDistance", fmtInt(s.totals.distanceKm) + " km");
      setField("repDuration", d.h + "h " + d.m + "min");
      setField("repFlights", s.totals.flights + " 次");
      var topRoute = s.routes[0];
      setField("repTopRoute", topRoute ? topRoute.from + " ⇋ " + topRoute.to + " × " + topRoute.flights : "—");
      var topAirline = Object.keys(s.airlines)
        .map(function (k) {
          return { key: k, flights: s.airlines[k].flights };
        })
        .sort(function (a, b) {
          return b.flights - a.flights;
        })[0];
      setField("repTopAirline", topAirline ? alName(topAirline.key) + " × " + topAirline.flights : "—");
    }

    /* ================= 飞行日历（年/月/日） ================= */
    function calendarYears() {
      return calendarSelectedYear === "all" ? yearKeys : [calendarSelectedYear];
    }

    function calendarYearHtml(year, counts, showHeading) {
      var y = parseInt(year, 10);
      var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
      var offset = (new Date(Date.UTC(y, 0, 1)).getUTCDay() + 6) % 7;
      var diy = leap ? 366 : 365;
      var monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      var weeks = Math.ceil((offset + diy) / 7);

      var html = "";
      for (var i = 0; i < offset; i++) {
        html += '<span class="travel-cal-day travel-cal-blank" aria-hidden="true"></span>';
      }
      for (var dnum = 1; dnum <= diy; dnum++) {
        var dt = new Date(Date.UTC(y, 0, dnum));
        var mm = ("0" + (dt.getUTCMonth() + 1)).slice(-2);
        var dd = ("0" + dt.getUTCDate()).slice(-2);
        var cnt = counts[mm + "-" + dd] || 0;
        var lv = cnt === 0 ? 0 : cnt === 1 ? 1 : cnt === 2 ? 2 : cnt === 3 ? 3 : 4;
        var label = dt.getUTCMonth() + 1 + "月" + dt.getUTCDate() + "日：" + cnt + " 次飞行";
        html +=
          '<span class="travel-cal-day" role="listitem" data-level="' + lv + '" tabindex="' +
          (cnt > 0 ? "0" : "-1") + '" title="' + label + '" aria-label="' + label + '"></span>';
      }
      var monthsHtml = "";
      var doy = 1;
      for (var m = 0; m < 12; m++) {
        var col = Math.floor((doy - 1 + offset) / 7);
        monthsHtml += "<span style=\"left:" + (col / weeks * 100).toFixed(2) + '%">' + (m + 1) + "月</span>";
        doy += monthDays[m];
      }
      return (
        '<section class="travel-cal-year-block" aria-label="' + year + ' 年飞行日历">' +
        (showHeading ? '<h3 class="travel-cal-year-heading">' + year + " 年</h3>" : "") +
        '<div class="travel-cal-scroll"><div class="travel-cal">' +
        '<div class="travel-cal-weekdays" aria-hidden="true"><span style="grid-row:1">一</span><span style="grid-row:4">四</span></div>' +
        '<div class="travel-cal-main"><div class="travel-cal-months" aria-hidden="true">' + monthsHtml +
        '</div><div class="travel-cal-grid" role="list" aria-label="' + year + ' 年逐日飞行热力图" style="grid-template-columns:repeat(' + weeks + ', minmax(10px, 1fr))">' + html +
        "</div></div></div></div></section>"
      );
    }

    function renderCalendar() {
      var years = calendarYears();
      root.querySelector('[data-field="calViewYear"]').innerHTML = years
        .map(function (year) {
          return calendarYearHtml(year, (data.years[year] && data.years[year].dailyCounts) || {}, currentYear === "all");
        })
        .join("") +
        '<div class="travel-cal-legend" aria-hidden="true"><span>少</span>' +
        '<span class="travel-cal-day" data-level="0"></span><span class="travel-cal-day" data-level="1"></span>' +
        '<span class="travel-cal-day" data-level="2"></span><span class="travel-cal-day" data-level="3"></span>' +
        '<span class="travel-cal-day" data-level="4"></span><span>多</span></div>';
    }

    function renderCalMonth() {
      var months = new Array(12).fill(0);
      calendarYears().forEach(function (year) {
        var counts = (data.years[year] && data.years[year].dailyCounts) || {};
        Object.keys(counts).forEach(function (k) {
          months[parseInt(k.slice(0, 2), 10) - 1] += counts[k];
        });
      });
      var max = Math.max.apply(null, months.concat([1]));
      root.querySelector('[data-field="calViewMonth"]').innerHTML =
        '<div class="travel-cal-bars" role="list" aria-label="' + (currentYear === "all" ? "全部年份" : currentYear + " 年") + '逐月飞行次数">' +
        months
          .map(function (c, i) {
            var h = Math.max(Math.round((c / max) * 100), 2);
            return (
              '<div class="travel-cal-bar" role="listitem" tabindex="0" aria-label="' + (i + 1) + "月：" + c + ' 次">' +
              '<span class="travel-cal-bar-val">' + c + "</span>" +
              '<span class="travel-cal-bar-col" style="height:' + h + '%"></span>' +
              '<span class="travel-cal-bar-label">' + (i + 1) + "月</span></div>"
            );
          })
          .join("") + "</div>";
    }

    function renderCalDay() {
      var days = [];
      calendarYears().forEach(function (year) {
        var counts = (data.years[year] && data.years[year].dailyCounts) || {};
        Object.keys(counts).forEach(function (day) {
          days.push({ date: year + "-" + day, count: counts[day] });
        });
      });
      days.sort(function (a, b) { return b.date.localeCompare(a.date); });
      root.querySelector('[data-field="calViewDay"]').innerHTML = days.length
        ? '<div class="travel-cal-days">' +
          days
            .map(function (day) {
              return (
                '<div class="travel-cal-day-row"><span class="travel-cal-day-date">' + day.date + "</span>" +
                '<span class="travel-cal-day-count travel-num">' + day.count + '<span class="travel-unit">次</span></span></div>'
              );
            })
            .join("") + "</div>"
        : '<div class="travel-cal-days-empty">暂无飞行记录</div>';
    }

    function showCalView(view) {
      calView = view;
      root.querySelectorAll(".travel-cal-view-btn").forEach(function (b) {
        var on = b.getAttribute("data-view") === view;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      root.querySelector('[data-field="calViewYear"]').hidden = view !== "year";
      root.querySelector('[data-field="calViewMonth"]').hidden = view !== "month";
      root.querySelector('[data-field="calViewDay"]').hidden = view !== "day";
      if (view === "month") renderCalMonth();
      if (view === "day") renderCalDay();
    }

    /* ================= 搭乘航司 ================= */
    function renderAirlines(s) {
      var list = Object.keys(s.airlines)
        .map(function (k) {
          return { key: k, slug: alSlug(k), logo: alLogo(k), name: alName(k), flights: s.airlines[k].flights };
        })
        .sort(function (a, b) {
          return b.flights - a.flights;
        });
      setField("airlineCount", "共搭乘 " + list.length + " 家");

      var prismEl = root.querySelector('[data-field="prismRow"]');
      prismEl.innerHTML = list
        .slice(0, 4)
        .map(function (a, i) {
          return (
            '<div class="travel-prism pc-' + PRISM_COLORS[i] + '">' +
            '<div class="travel-prism-num travel-num">' + a.flights + '<span class="travel-unit">次</span></div>' +
            '<div class="travel-prism-logo" aria-hidden="true"><img src="' + a.logo + '" alt=""/>' +
            '<span class="travel-prism-mono">' + esc(a.name.slice(0, 2)) + "</span></div>" +
            '<div class="travel-prism-name">' + esc(a.name) + "</div></div>"
          );
        })
        .join("");
      armLogoFallback(prismEl);

      var max = list.length ? list[0].flights : 1;
      var html = list
        .map(function (a, i) {
          var share = s.totals.flights ? ((a.flights / s.totals.flights) * 100).toFixed(1) : "0.0";
          return (
            '<div class="travel-bar-row' + (i >= 8 ? " travel-extra" : "") + '">' +
            '<div class="travel-bar-head"><span class="travel-bar-name">' + esc(a.name) + "</span>" +
            '<span class="travel-bar-meta">' + a.flights + " 次 · " + share + "%</span></div>" +
            '<div class="travel-bar-track"><div class="travel-bar-fill" style="width:' +
            ((a.flights / max) * 100).toFixed(1) + '%"></div></div></div>'
          );
        })
        .join("");
      var listEl = root.querySelector('[data-field="airlineList"]');
      listEl.innerHTML = html;
      listEl.classList.toggle("expanded", airlinesExpanded);
      var toggle = root.querySelector('[data-field="airlineToggle"]');
      if (toggle) {
        toggle.style.display = list.length > 8 ? "" : "none";
        toggle.textContent = airlinesExpanded ? "收起" : "展开全部";
        toggle.setAttribute("aria-expanded", String(airlinesExpanded));
      }
    }

    /* ================= 乘坐机型 ================= */
    function renderFleet(s) {
      var known = s.aircraftKnownFlights;
      var total = known + s.aircraftUnknownFlights;
      setField("fleetCompleteness", "已识别 " + known + "/" + total + " 航段");

      var big3Sum = 0;
      var mfrEl = root.querySelector('[data-field="mfrRow"]');
      var orbsHtml = MFR_BIG3.map(function (m, i) {
        var n = s.manufacturers[m.key] ? s.manufacturers[m.key].flights : 0;
        big3Sum += n;
        return (
          '<div class="travel-mfr-badge pc-' + PRISM_COLORS[i] + '">' +
          '<div class="travel-mfr-orb" aria-hidden="true"><img src="/img/travel/manufacturers/' + m.key.toLowerCase() + '.svg" alt=""/><span>' + m.key + "</span></div>" +
          '<div class="travel-mfr-name">' + m.zh + '</div>' +
          '<div class="travel-mfr-count travel-num">' + n + '<span class="travel-unit">次</span></div></div>'
        );
      }).join("");
      orbsHtml +=
        '<div class="travel-mfr-badge pc-green">' +
        '<div class="travel-mfr-orb" aria-hidden="true"><span>···</span></div>' +
        '<div class="travel-mfr-name">其他</div>' +
        '<div class="travel-mfr-count travel-num">' + (known - big3Sum) + '<span class="travel-unit">次</span></div></div>';
      mfrEl.innerHTML = orbsHtml;
      armLogoFallback(mfrEl);

      var modelList = Object.keys(s.aircraft)
        .map(function (k) {
          return { model: k, mfr: s.aircraft[k].manufacturer, flights: s.aircraft[k].flights };
        })
        .sort(function (a, b) {
          return b.flights - a.flights;
        });
      var modelListEl = root.querySelector('[data-field="modelList"]');
      modelListEl.innerHTML = modelList
        .map(function (m, i) {
          return (
            '<div class="travel-model-row' + (i >= 8 ? " travel-extra" : "") + '">' +
            '<span class="travel-model-rank">' + (i + 1) + "</span>" +
            '<span class="travel-model-name">' + esc(m.model) + "</span>" +
            '<span class="travel-model-mfr">' + esc(m.mfr) + "</span>" +
            '<span class="travel-model-flights travel-num">' + m.flights + '<span class="travel-unit">次</span></span></div>'
          );
        })
        .join("");
      modelListEl.classList.toggle("expanded", modelsExpanded);
      var modelToggle = root.querySelector('[data-field="modelToggle"]');
      if (modelToggle) {
        modelToggle.style.display = modelList.length > 8 ? "" : "none";
        modelToggle.textContent = modelsExpanded ? "收起" : "展开全部";
        modelToggle.setAttribute("aria-expanded", String(modelsExpanded));
      }

      var note = root.querySelector('[data-field="fleetNote"]');
      if (note) {
        if (s.aircraftUnknownFlights > 0) {
          note.style.display = "";
          note.textContent = "其余 " + s.aircraftUnknownFlights + " 航段源数据缺少机型信息，未计入以上统计。";
        } else {
          note.style.display = "none";
        }
      }
    }

    function renderAll() {
      var s = sliceFor(currentYear);
      if (!s) return;
      renderMap(s);
      renderDash(s);
      renderFootprint(s);
      renderReport(s);
      renderCalendar();
      if (calView === "month") renderCalMonth();
      if (calView === "day") renderCalDay();
      renderAirlines(s);
      renderFleet(s);
    }

    root.querySelectorAll(".travel-year-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var year = btn.getAttribute("data-year");
        if (year === currentYear) return;
        currentYear = year;
        root.querySelectorAll(".travel-year-chip").forEach(function (b) {
          var on = b === btn;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", String(on));
        });
        /* 全局年份筛选切换时，日历同步回该年；“全部”默认保持清爽的最新年。 */
        calendarSelectedYear = year === "all" ? latestYear : year;
        var calYearSelect = root.querySelector('[data-field="calYearSelect"]');
        if (calYearSelect) calYearSelect.value = calendarSelectedYear;
        renderAll();
      });
    });

    var calYearSelect = root.querySelector('[data-field="calYearSelect"]');
    if (calYearSelect) {
      calYearSelect.addEventListener("change", function () {
        calendarSelectedYear = calYearSelect.value;
        renderCalendar();
        if (calView === "month") renderCalMonth();
        if (calView === "day") renderCalDay();
      });
    }

    root.querySelectorAll(".travel-cal-view-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showCalView(btn.getAttribute("data-view"));
      });
    });

    var toggle = root.querySelector('[data-field="airlineToggle"]');
    if (toggle) {
      toggle.addEventListener("click", function () {
        airlinesExpanded = !airlinesExpanded;
        renderAirlines(sliceFor(currentYear));
      });
    }
    var modelToggle = root.querySelector('[data-field="modelToggle"]');
    if (modelToggle) {
      modelToggle.addEventListener("click", function () {
        modelsExpanded = !modelsExpanded;
        renderFleet(sliceFor(currentYear));
      });
    }

    resetMapViewport();
    bindMapPanZoom();
    renderAll();
    /* 等首轮渲染落入布局后再滚动，避免返回时先回顶或被内容撑开推走。 */
    try {
      var savedScroll = window.sessionStorage.getItem(DETAIL_RETURN_SCROLL_KEY);
      if (savedScroll !== null) {
        window.sessionStorage.removeItem(DETAIL_RETURN_SCROLL_KEY);
        var scrollY = Number(savedScroll);
        if (Number.isFinite(scrollY) && scrollY > 0) {
          window.requestAnimationFrame(function () {
            window.requestAnimationFrame(function () {
              window.scrollTo(0, scrollY);
            });
          });
        }
      }
    } catch (e) {
      /* 不可用时不影响页面初始化。 */
    }
    primeArrows();
    /* resize 监听全局只保留最新一份（PJAX 重进不累积） */
    if (window.__travelMapResizeHandler) {
      window.removeEventListener("resize", window.__travelMapResizeHandler);
    }
    window.__travelMapResizeHandler = function () {
      /* 只有在未手动缩放过时才随断点重置视窗 */
      resetMapViewport();
    };
    window.addEventListener("resize", window.__travelMapResizeHandler);
  }

  /* PJAX 完成后重新初始化（全局监听只绑定一次） */
  if (!window.__travelPjaxBound) {
    window.__travelPjaxBound = true;
    document.addEventListener("pjax:complete", initTravelPage);
  }
  initTravelPage();
})();
