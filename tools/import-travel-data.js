/**
 * 旅途轨迹数据导入器（第一阶段）
 *
 * 用法:
 *   node tools/import-travel-data.js <openflights.csv> [--airports <airports.dat>] [--out <travel.json>]
 *
 * 说明:
 *   - 输入为 OpenFlights 风格导出 CSV（私人数据，绝不入库、绝不回显敏感列）。
 *   - 输出为「脱敏且预聚合」的 src/data/travel.json，只包含统计聚合结果，
 *     不包含航班号、座位、注册号、票号、行程分组、原始备注等敏感字段。
 *   - 机场元数据来源（均为导入时一次性拉取，运行时不依赖在线 API）:
 *       1. 首选 OpenFlights 公开机场数据 airports.dat
 *          https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat
 *       2. OpenFlights 数据停更较早，缺失的新机场（如 TFU）回退到 OurAirports 公开数据
 *          https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv
 *          https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/countries.csv
 *     也可用 --airports 指定本地 airports.dat 副本。坐标映射失败时明确报错，绝不猜测坐标。
 *   - 里程口径: CSV 的 Distance 单位是英里，默认 distanceKm = 英里 * 1.609344；
 *     若 Note 中存在 "UMETRIP <数字>km"，优先采用该公里值（Note 本身绝不写入输出）。
 *   - 坐标/国家/大洲映射失败时明确报错，绝不猜测坐标。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { routeGeometry, mapLegsFromDirected } = require("./travel-map.js");

const MILE_TO_KM = 1.609344;
const OPENFLIGHTS_AIRPORTS_URL =
  "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";
const OURAIRPORTS_AIRPORTS_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/airports.csv";
const OURAIRPORTS_COUNTRIES_URL =
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/countries.csv";
const OURAIRPORTS_CONTINENT = {
  AF: "Africa", AN: "Antarctica", AS: "Asia", EU: "Europe",
  NA: "North America", OC: "Oceania", SA: "South America",
};

/* OpenFlights airports.dat 的 country 字段（英文名）-> 大洲 */
const CONTINENT_COUNTRIES = {
  Asia: [
    "Afghanistan", "Armenia", "Azerbaijan", "Bahrain", "Bangladesh", "Bhutan",
    "Brunei", "Cambodia", "China", "Christmas Island", "Cocos (Keeling) Islands",
    "Cyprus", "Georgia", "Hong Kong", "India", "Indonesia", "Iran", "Iraq",
    "Israel", "Japan", "Jordan", "Kazakhstan", "Kuwait", "Kyrgyzstan", "Laos",
    "Lebanon", "Macau", "Malaysia", "Maldives", "Mongolia", "Myanmar", "Nepal",
    "North Korea", "Oman", "Pakistan", "Palestine", "Philippines", "Qatar",
    "Saudi Arabia", "Singapore", "South Korea", "Sri Lanka", "Syria", "Taiwan",
    "Tajikistan", "Thailand", "Timor-Leste", "Turkmenistan",
    "United Arab Emirates", "Uzbekistan", "Vietnam", "Yemen",
  ],
  Europe: [
    "Albania", "Andorra", "Austria", "Belarus", "Belgium",
    "Bosnia and Herzegovina", "Bulgaria", "Croatia", "Czech Republic",
    "Czechia", "Denmark", "Estonia", "Faroe Islands", "Finland", "France",
    "Germany", "Gibraltar", "Greece", "Guernsey", "Hungary", "Iceland",
    "Ireland", "Isle of Man", "Italy", "Jersey", "Kosovo", "Latvia",
    "Liechtenstein", "Lithuania", "Luxembourg", "Macedonia", "Malta",
    "Moldova", "Monaco", "Montenegro", "Netherlands", "Norway", "Poland",
    "Portugal", "Romania", "Russia", "San Marino", "Serbia", "Slovakia",
    "Slovenia", "Spain", "Svalbard", "Sweden", "Switzerland", "Ukraine",
    "Turkey",
    "United Kingdom", "Vatican City",
  ],
  Africa: [
    "Algeria", "Angola", "Benin", "Botswana", "Burkina Faso", "Burundi",
    "Cameroon", "Cape Verde", "Central African Republic", "Chad", "Comoros",
    "Congo", "Congo (Brazzaville)", "Congo (Kinshasa)", "Cote d'Ivoire",
    "Djibouti", "Egypt", "Equatorial Guinea", "Eritrea", "Ethiopia", "Gabon",
    "Gambia", "Ghana", "Guinea", "Guinea-Bissau", "Ivory Coast", "Kenya",
    "Lesotho", "Liberia", "Libya", "Madagascar", "Malawi", "Mali",
    "Mauritania", "Mauritius", "Mayotte", "Morocco", "Mozambique", "Namibia",
    "Niger", "Nigeria", "Reunion", "Rwanda", "Sao Tome and Principe",
    "Senegal", "Seychelles", "Sierra Leone", "Somalia", "South Africa",
    "South Sudan", "Sudan", "Swaziland", "Tanzania", "Togo", "Tunisia",
    "Uganda", "Western Sahara", "Zambia", "Zimbabwe",
  ],
  "North America": [
    "Anguilla", "Antigua and Barbuda", "Aruba", "Bahamas", "Barbados",
    "Belize", "Bermuda", "Bonaire", "British Virgin Islands", "Canada",
    "Cayman Islands", "Costa Rica", "Cuba", "Curacao", "Dominica",
    "Dominican Republic", "El Salvador", "Greenland", "Grenada",
    "Guadeloupe", "Guatemala", "Haiti", "Honduras", "Jamaica", "Martinique",
    "Mexico", "Montserrat", "Nicaragua", "Panama", "Puerto Rico",
    "Saint Kitts and Nevis", "Saint Lucia", "Saint Martin",
    "Saint Vincent and the Grenadines", "Sint Maarten",
    "Trinidad and Tobago", "Turks and Caicos Islands", "United States",
    "Virgin Islands",
  ],
  "South America": [
    "Argentina", "Bolivia", "Brazil", "Chile", "Colombia", "Ecuador",
    "Falkland Islands", "French Guiana", "Guyana", "Paraguay", "Peru",
    "Suriname", "Uruguay", "Venezuela",
  ],
  Oceania: [
    "American Samoa", "Australia", "Cook Islands", "Fiji", "French Polynesia",
    "Guam", "Kiribati", "Marshall Islands", "Micronesia", "Nauru",
    "New Caledonia", "New Zealand", "Niue", "Norfolk Island",
    "Northern Mariana Islands", "Palau", "Papua New Guinea", "Samoa",
    "Solomon Islands", "Tonga", "Tuvalu", "Vanuatu", "Wallis and Futuna",
  ],
  Antarctica: ["Antarctica"],
};

const COUNTRY_TO_CONTINENT = (() => {
  const map = new Map();
  for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
    for (const c of countries) map.set(c, continent);
  }
  return map;
})();

/** 解析标准 CSV（支持 UTF-8 BOM、CRLF/LF、带引号字段、字段内逗号/换行/双引号转义） */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

/** CSV 文本 -> 对象数组（按表头命名） */
function csvToRecords(text) {
  const rows = parseCsv(text);
  if (rows.length < 1) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const rec = {};
    header.forEach((h, i) => {
      rec[h] = (cols[i] || "").trim();
    });
    return rec;
  });
}

/** "HH:MM" -> 分钟 */
function durationToMinutes(duration) {
  const m = /^(\d{1,3}):(\d{2})$/.exec(duration || "");
  if (!m) return 0;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/** 提取 Note 中的 "UMETRIP <num>km" 公里值；无则返回 null。Note 内容本身绝不外泄。 */
function extractUmetripKm(note) {
  const m = /UMETRIP\s+(\d+(?:\.\d+)?)\s*km/i.exec(note || "");
  return m ? Math.round(parseFloat(m[1])) : null;
}

function milesToKm(miles) {
  const v = parseFloat(miles);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.round(v * MILE_TO_KM);
}

/**
 * 已知制造商前缀（按长度降序匹配，保证 "De Havilland" 先于 "De" 之类命中）。
 * 未命中的机型归入 "其他"，且 model 保留完整原始字符串。
 */
const KNOWN_MANUFACTURERS = [
  "De Havilland",
  "McDonnell Douglas",
  "British Aerospace",
  "Bombardier",
  "Airbus",
  "Boeing",
  "COMAC",
  "Embraer",
  "Tupolev",
  "Ilyushin",
  "Antonov",
  "Sukhoi",
  "Fokker",
  "Dassault",
  "Cessna",
  "Gulfstream",
  "Saab",
  "Xian",
  "ATR",
].sort((a, b) => b.length - a.length);

/**
 * 裸机型（无制造商前缀）映射：源数据中存在 "C919" 这类不带前缀的写法。
 * 仅收录归属明确的型号；型号串完整保留为 model。
 */
const BARE_MODEL_MANUFACTURERS = {
  C919: "COMAC",
  C909: "COMAC",
  ARJ21: "COMAC",
};

/**
 * "Boeing 737-89L(WL)" -> { manufacturer: "Boeing", model: "737-89L(WL)" }
 * "De Havilland DHC-8-400" -> { manufacturer: "De Havilland", model: "DHC-8-400" }
 * "C919" -> { manufacturer: "COMAC", model: "C919" }
 * 未知制造商 -> { manufacturer: "其他", model: <完整原始字符串> }
 */
function parseAircraft(plane) {
  const p = (plane || "").trim();
  if (!p) return null;
  for (const mfr of KNOWN_MANUFACTURERS) {
    if (p === mfr) return { manufacturer: mfr, model: p };
    if (p.startsWith(mfr + " ")) {
      return { manufacturer: mfr, model: p.slice(mfr.length + 1).trim() || p };
    }
  }
  for (const [bare, mfr] of Object.entries(BARE_MODEL_MANUFACTURERS)) {
    if (p === bare || p.startsWith(bare + " ") || p.startsWith(bare + "-")) {
      return { manufacturer: mfr, model: p };
    }
  }
  return { manufacturer: "其他", model: p };
}

/** 解析 airports.dat，返回 { byOid: Map, byIata: Map } */
function buildAirportIndex(airportsDatText) {
  const records = parseCsv(airportsDatText);
  const byOid = new Map();
  const byIata = new Map();
  for (const cols of records) {
    if (cols.length < 9) continue;
    const [oid, name, city, country, iata, , lat, lon] = cols;
    const entry = {
      name: name || "",
      city: city || "",
      country: country || "",
      lat: parseFloat(lat),
      lon: parseFloat(lon),
    };
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) continue;
    byOid.set(String(oid), entry);
    if (iata && iata !== "\\N") byIata.set(iata, entry);
  }
  return { byOid, byIata };
}

/** 解析 OurAirports airports.csv + countries.csv，返回 { byIata: Map }（作为 OpenFlights 的兜底） */
function buildOurAirportsIndex(airportsCsvText, countriesCsvText) {
  const countryName = new Map();
  for (const r of csvToRecords(countriesCsvText)) {
    if (r.code) countryName.set(r.code, r.name || r.code);
  }
  const byIata = new Map();
  for (const r of csvToRecords(airportsCsvText)) {
    const iata = (r.iata_code || "").trim();
    if (!iata) continue;
    const lat = parseFloat(r.latitude_deg);
    const lon = parseFloat(r.longitude_deg);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    byIata.set(iata, {
      name: r.name || "",
      city: r.municipality || "",
      country: countryName.get(r.iso_country) || r.iso_country || "",
      continent: OURAIRPORTS_CONTINENT[r.continent] || null,
      lat,
      lon,
    });
  }
  return { byOid: new Map(), byIata };
}

/** 返回记录中在索引里（OID 与 IATA 均）匹配不到的机场 IATA 集合 */
function findMissingAirports(records, airportIndex) {
  const missing = new Set();
  for (const rec of records) {
    for (const [iata, oid] of [
      [(rec.From || "").toUpperCase(), rec.From_OID],
      [(rec.To || "").toUpperCase(), rec.To_OID],
    ]) {
      if (!iata) continue;
      if (oid && airportIndex.byOid.has(String(oid))) continue;
      if (airportIndex.byIata.has(iata)) continue;
      missing.add(iata);
    }
  }
  return missing;
}

/** 聚合切片（全量与逐年同构）：航线只聚合到「年」粒度，绝不产生 route-日期 联表 */
function newSlice() {
  return {
    totals: { flights: 0, distanceKm: 0, durationMin: 0 },
    dailyCounts: {},
    airportVisits: {},
    routeMap: new Map(),
    directedLegs: [],
    airlines: {},
    manufacturers: {},
    aircraft: {},
    aircraftKnownFlights: 0,
    aircraftUnknownFlights: 0,
  };
}

function accumulateSlice(slice, { distanceKm, durationMin, dayKey, from, to, airlineName, ac }) {
  slice.totals.flights += 1;
  slice.totals.distanceKm += distanceKm;
  slice.totals.durationMin += durationMin;
  if (dayKey) slice.dailyCounts[dayKey] = (slice.dailyCounts[dayKey] || 0) + 1;

  slice.airportVisits[from] = (slice.airportVisits[from] || 0) + 1;
  slice.airportVisits[to] = (slice.airportVisits[to] || 0) + 1;

  // 地图逐航段保留方向（不合并）；统计航线仍按无向去重
  slice.directedLegs.push({ from, to });

  // 无向航线聚合（A-B 与 B-A 视为同一路线，供足迹/明细）
  // distanceKm: 代表里程（取最大）；totalDistanceKm: 逐航段累计
  const [ra, rb] = from < to ? [from, to] : [to, from];
  const routeKey = `${ra}-${rb}`;
  if (!slice.routeMap.has(routeKey)) {
    slice.routeMap.set(routeKey, { from: ra, to: rb, flights: 0, distanceKm: 0, totalDistanceKm: 0 });
  }
  const route = slice.routeMap.get(routeKey);
  route.flights += 1;
  route.distanceKm = Math.max(route.distanceKm, distanceKm);
  route.totalDistanceKm += distanceKm;

  if (!slice.airlines[airlineName]) slice.airlines[airlineName] = { flights: 0, distanceKm: 0, durationMin: 0 };
  slice.airlines[airlineName].flights += 1;
  slice.airlines[airlineName].distanceKm += distanceKm;
  slice.airlines[airlineName].durationMin += durationMin;

  if (ac) {
    slice.aircraftKnownFlights += 1;
    if (!slice.manufacturers[ac.manufacturer]) slice.manufacturers[ac.manufacturer] = { flights: 0 };
    slice.manufacturers[ac.manufacturer].flights += 1;
    if (!slice.aircraft[ac.model]) slice.aircraft[ac.model] = { manufacturer: ac.manufacturer, flights: 0 };
    slice.aircraft[ac.model].flights += 1;
  } else {
    slice.aircraftUnknownFlights += 1;
  }
}

/**
 * 由 CSV 记录 + 机场索引构建脱敏聚合数据。
 * 只输出聚合统计，不保留任何逐航段明细或敏感字段。
 */
function buildTravelData(records, airportIndex) {
  const overallSlice = newSlice();
  const yearSlices = {};
  const airports = {};
  const skipped = [];
  const missingAirports = new Set();

  const lookupAirport = (iata, oid) => {
    if (oid && airportIndex.byOid.has(String(oid))) return airportIndex.byOid.get(String(oid));
    if (iata && airportIndex.byIata.has(iata)) return airportIndex.byIata.get(iata);
    return null;
  };

  for (const rec of records) {
    const dateStr = rec.Date || "";
    const from = (rec.From || "").toUpperCase();
    const to = (rec.To || "").toUpperCase();
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
    if (!dateMatch || !from || !to) {
      skipped.push({ date: dateStr.slice(0, 10), from, to });
      continue;
    }
    const year = dateMatch[1];
    const dayKey = `${dateMatch[2]}-${dateMatch[3]}`;

    // 里程：Note 中 UMETRIP 公里值优先，否则英里 * 1.609344
    const umetripKm = extractUmetripKm(rec.Note);
    const distanceKm = umetripKm !== null ? umetripKm : milesToKm(rec.Distance);
    const durationMin = durationToMinutes(rec.Duration);
    const airlineName = (rec.Airline || "").trim() || "未知";
    const ac = parseAircraft(rec.Plane);

    if (!yearSlices[year]) yearSlices[year] = newSlice();
    const ctx = { distanceKm, durationMin, from, to, airlineName, ac };
    accumulateSlice(overallSlice, { ...ctx, dayKey: null });
    accumulateSlice(yearSlices[year], { ...ctx, dayKey });

    // 机场元数据（全局去重，首次出现时建立；visits 最后统一由全量切片回填）
    for (const [iata, oid] of [[from, rec.From_OID], [to, rec.To_OID]]) {
      if (!airports[iata]) {
        const meta = lookupAirport(iata, oid);
        if (!meta) {
          missingAirports.add(iata);
        } else {
          const continent = meta.continent || COUNTRY_TO_CONTINENT.get(meta.country);
          if (!continent) {
            throw new Error(
              `无法确定国家 "${meta.country}"（机场 ${iata}）所属大洲，请在脚本的 CONTINENT_COUNTRIES 中补充映射。`
            );
          }
          airports[iata] = {
            iata,
            name: meta.name,
            city: meta.city,
            country: meta.country,
            continent,
            lat: Math.round(meta.lat * 10000) / 10000,
            lon: Math.round(meta.lon * 10000) / 10000,
            visits: 0,
          };
        }
      }
    }
  }

  if (missingAirports.size > 0) {
    throw new Error(
      `以下机场在 OpenFlights 机场数据中未找到（OID/IATA 均不匹配），拒绝猜测坐标: ${[...missingAirports].sort().join(", ")}`
    );
  }

  // 全局机场 visits 由全量切片回填
  for (const iata of Object.keys(airports)) {
    airports[iata].visits = overallSlice.airportVisits[iata] || 0;
  }

  // 足迹统计：大洲 / 国家地区 / 城市 / 机场 / 航线（切片维度）
  const finalizeSlice = (slice) => {
    const iatas = Object.keys(slice.airportVisits).filter((i) => airports[i]);
    const continentSet = new Set(iatas.map((i) => airports[i].continent));
    const countrySet = new Set(iatas.map((i) => airports[i].country));
    const citySet = new Set(iatas.map((i) => `${airports[i].country}/${airports[i].city}`));
    const routes = [...slice.routeMap.values()]
      .sort((a, b) => b.flights - a.flights || a.from.localeCompare(b.from))
      .map((rt) => {
        const geo = routeGeometry(airports[rt.from], airports[rt.to], `${rt.from}-${rt.to}`);
        return { ...rt, d: geo.d, arrows: geo.arrows };
      });
    const mapLegs = mapLegsFromDirected(airports, slice.directedLegs);
    return {
      totals: slice.totals,
      dailyCounts: slice.dailyCounts,
      routes,
      mapLegs,
      airlines: slice.airlines,
      manufacturers: slice.manufacturers,
      aircraft: slice.aircraft,
      aircraftKnownFlights: slice.aircraftKnownFlights,
      aircraftUnknownFlights: slice.aircraftUnknownFlights,
      footprint: {
        continents: continentSet.size,
        countries: countrySet.size,
        cities: citySet.size,
        airports: iatas.length,
        routes: routes.length,
        continentList: [...continentSet].sort(),
      },
    };
  };

  const overallFin = finalizeSlice(overallSlice);
  const years = {};
  for (const y of Object.keys(yearSlices).sort()) {
    years[y] = finalizeSlice(yearSlices[y]);
  }

  const airportList = Object.values(airports);
  const byContinent = {};
  for (const a of airportList) {
    if (!byContinent[a.continent]) byContinent[a.continent] = { airports: 0, visits: 0 };
    byContinent[a.continent].airports += 1;
    byContinent[a.continent].visits += a.visits;
  }

  return {
    generatedAt: new Date().toISOString(),
    source: "OpenFlights 导出 CSV（本地导入，已脱敏预聚合）；机场元数据: OpenFlights airports.dat",
    overall: {
      flights: overallFin.totals.flights,
      distanceKm: overallFin.totals.distanceKm,
      durationMin: overallFin.totals.durationMin,
      aircraftKnownFlights: overallFin.aircraftKnownFlights,
      aircraftUnknownFlights: overallFin.aircraftUnknownFlights,
    },
    years,
    airports,
    routes: overallFin.routes,
    mapLegs: overallFin.mapLegs,
    airlines: overallFin.airlines,
    manufacturers: overallFin.manufacturers,
    aircraft: overallFin.aircraft,
    footprint: { ...overallFin.footprint, byContinent },
    skippedCount: skipped.length,
  };
}

async function fetchText(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`拉取机场数据失败: HTTP ${res.status} ${url}`);
  return res.text();
}

function parseArgs(argv) {
  const args = { csv: null, airports: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--airports") args.airports = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (!argv[i].startsWith("--") && !args.csv) args.csv = argv[i];
    else throw new Error(`无法识别的参数: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.csv) {
    console.error("用法: node tools/import-travel-data.js <openflights.csv> [--airports <airports.dat>] [--out <travel.json>]");
    process.exit(1);
  }
  const outPath = args.out || path.join(__dirname, "..", "src", "data", "travel.json");

  if (!fs.existsSync(args.csv)) {
    console.error(`CSV 文件不存在: ${args.csv}`);
    process.exit(1);
  }
  const csvText = fs.readFileSync(args.csv, "utf8");
  const records = csvToRecords(csvText);

  let airportsDatText;
  if (args.airports) {
    if (!fs.existsSync(args.airports)) {
      console.error(`机场数据文件不存在: ${args.airports}`);
      process.exit(1);
    }
    airportsDatText = fs.readFileSync(args.airports, "utf8");
  } else {
    console.error(`正在一次性拉取 OpenFlights 机场数据: ${OPENFLIGHTS_AIRPORTS_URL}`);
    try {
      airportsDatText = await fetchText(OPENFLIGHTS_AIRPORTS_URL);
    } catch (err) {
      console.error(`机场数据拉取失败，已中止（绝不猜测坐标）。可改用 --airports 指定本地 airports.dat。原因: ${err.message}`);
      process.exit(1);
    }
  }

  const airportIndex = buildAirportIndex(airportsDatText);

  // OpenFlights 数据停更早，缺失机场回退到 OurAirports 公开数据
  let usedOurAirports = false;
  let missing = findMissingAirports(records, airportIndex);
  if (missing.size > 0) {
    console.error(
      `OpenFlights 数据缺少机场: ${[...missing].sort().join(", ")}，回退 OurAirports 公开数据补齐`
    );
    try {
      const [oaAirports, oaCountries] = await Promise.all([
        fetchText(OURAIRPORTS_AIRPORTS_URL),
        fetchText(OURAIRPORTS_COUNTRIES_URL),
      ]);
      const oaIndex = buildOurAirportsIndex(oaAirports, oaCountries);
      for (const iata of missing) {
        if (oaIndex.byIata.has(iata)) airportIndex.byIata.set(iata, oaIndex.byIata.get(iata));
      }
      usedOurAirports = true;
    } catch (err) {
      console.error(`OurAirports 兜底数据拉取失败，已中止（绝不猜测坐标）。原因: ${err.message}`);
      process.exit(1);
    }
    missing = findMissingAirports(records, airportIndex);
    if (missing.size > 0) {
      console.error(
        `以下机场在 OpenFlights 与 OurAirports 中均未找到，拒绝猜测坐标: ${[...missing].sort().join(", ")}`
      );
      process.exit(1);
    }
  }

  const data = buildTravelData(records, airportIndex);
  if (usedOurAirports) {
    data.source += "；缺失新机场兜底: OurAirports airports.csv/countries.csv";
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.error(
    `导入完成: ${data.overall.flights} 航段, ${data.overall.distanceKm} km, ` +
      `${Object.keys(data.years).length} 个年份, ${data.footprint.airports} 个机场, ` +
      `${data.footprint.routes} 条航线 -> ${path.relative(process.cwd(), outPath)}` +
      (data.skippedCount ? `（跳过无效行 ${data.skippedCount} 条）` : "")
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`导入失败: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  parseCsv,
  csvToRecords,
  durationToMinutes,
  extractUmetripKm,
  milesToKm,
  parseAircraft,
  buildAirportIndex,
  buildOurAirportsIndex,
  findMissingAirports,
  buildTravelData,
  MILE_TO_KM,
};
