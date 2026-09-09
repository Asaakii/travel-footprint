"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseCsv,
  csvToRecords,
  durationToMinutes,
  extractUmetripKm,
  milesToKm,
  parseAircraft,
  buildAirportIndex,
  buildTravelData,
} = require("../tools/import-travel-data.js");

const HEADER =
  "Date,From,To,Flight_Number,Airline,Distance,Duration,Seat,Seat_Type,Class,Reason,Plane,Registration,Trip,Note,From_OID,To_OID,Airline_OID,Plane_OID";

const AIRPORTS_DAT = [
  '3364,"Beijing Capital International Airport","Beijing","China","PEK","ZBAA",40.0801,116.5846,116,8,"U","Asia/Shanghai","airport","OurAirports"',
  '3395,"Chengdu Shuangliu International Airport","Chengdu","China","CTU","ZUUU",30.5785,103.947,1625,8,"U","Asia/Shanghai","airport","OurAirports"',
  '3391,"Shanghai Pudong International Airport","Shanghai","China","PVG","ZSPD",31.1434,121.805,13,8,"U","Asia/Shanghai","airport","OurAirports"',
  '3888,"Tokyo Haneda International Airport","Tokyo","Japan","HND","RJTT",35.5523,139.78,21,9,"U","Asia/Tokyo","airport","OurAirports"',
].join("\n");

function makeAirportIndex() {
  return buildAirportIndex(AIRPORTS_DAT);
}

function makeCsv(bodyRows) {
  return "﻿" + HEADER + "\r\n" + bodyRows.join("\r\n") + "\r\n";
}

function row(overrides) {
  const base = {
    Date: "2026-08-31 08:41:00",
    From: "PEK",
    To: "CTU",
    Flight_Number: "CA0000",
    Airline: "Air China",
    Distance: "966",
    Duration: "02:26",
    Seat: "00A",
    Seat_Type: "W",
    Class: "Y",
    Reason: "L",
    Plane: "Boeing 737-89L(WL)",
    Registration: "B0000",
    Trip: "",
    Note: "",
    From_OID: "3364",
    To_OID: "3395",
    Airline_OID: "751",
    Plane_OID: "14734",
  };
  const r = { ...base, ...overrides };
  return [
    r.Date, r.From, r.To, r.Flight_Number, r.Airline, r.Distance, r.Duration,
    r.Seat, r.Seat_Type, r.Class, r.Reason, r.Plane, r.Registration, r.Trip,
    r.Note, r.From_OID, r.To_OID, r.Airline_OID, r.Plane_OID,
  ].join(",");
}

test("parseCsv 处理 UTF-8 BOM 与 CRLF", () => {
  const rows = parseCsv("﻿a,b\r\nc,d\r\n");
  assert.deepEqual(rows, [["a", "b"], ["c", "d"]]);
});

test("parseCsv 处理带逗号与引号的字段", () => {
  const rows = parseCsv('x,"hello, world","say ""hi"""');
  assert.deepEqual(rows, [["x", "hello, world", 'say "hi"']]);
});

test("csvToRecords 的 Note 含逗号/引号/票号时列不错位", () => {
  const note = '"Ticket 9999000011111; UMETRIP 1697km 08:30-11:25; 含,逗号与""引号"""';
  const recs = csvToRecords(makeCsv([row({ Note: note })]));
  assert.equal(recs.length, 1);
  assert.equal(recs[0].From, "PEK");
  assert.equal(recs[0].To_OID, "3395");
  assert.match(recs[0].Note, /UMETRIP 1697km/);
});

test("Duration HH:MM 转分钟", () => {
  assert.equal(durationToMinutes("02:26"), 146);
  assert.equal(durationToMinutes("00:45"), 45);
  assert.equal(durationToMinutes(""), 0);
  assert.equal(durationToMinutes("bad"), 0);
});

test("英里转公里（无 UMETRIP 标记时）", () => {
  assert.equal(milesToKm("966"), Math.round(966 * 1.609344)); // 1555
  const recs = csvToRecords(makeCsv([row({ Distance: "966", Note: "" })]));
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.overall.distanceKm, Math.round(966 * 1.609344));
});

test("Note 中的 UMETRIP 公里值优先于英里换算", () => {
  const recs = csvToRecords(makeCsv([row({ Distance: "966", Note: '"UMETRIP 1697km 08:30-11:25"' })]));
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.overall.distanceKm, 1697);
  assert.equal(extractUmetripKm("prefix UMETRIP 1697km suffix"), 1697);
  assert.equal(extractUmetripKm("no marker"), null);
});

test("跨年统计与按年 dailyCounts", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ Date: "2025-12-31 23:00:00" }),
      row({ Date: "2026-01-01 01:00:00" }),
      row({ Date: "2026-01-01 09:00:00" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.overall.flights, 3);
  assert.equal(data.years["2025"].totals.flights, 1);
  assert.equal(data.years["2026"].totals.flights, 2);
  assert.equal(data.years["2026"].dailyCounts["01-01"], 2);
  assert.equal(data.years["2025"].dailyCounts["12-31"], 1);
});

test("每个年度切片包含完整聚合维度", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ Date: "2025-06-01 08:00:00", Plane: "Boeing 737-800" }),
      row({ Date: "2026-01-01 09:00:00", Plane: "" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  for (const y of ["2025", "2026"]) {
    const s = data.years[y];
    for (const key of ["totals", "dailyCounts", "routes", "airlines", "manufacturers", "aircraft", "footprint"]) {
      assert.ok(key in s, `年份 ${y} 缺少维度 ${key}`);
    }
    assert.ok(Array.isArray(s.routes));
    assert.ok(s.footprint.routes === s.routes.length);
    assert.ok(s.footprint.airports > 0);
  }
  // 年度航线与航司切片独立正确
  assert.equal(data.years["2025"].routes[0].flights, 1);
  assert.equal(data.years["2025"].airlines["Air China"].flights, 1);
});

test("年度 totals 与全量 totals 对账一致", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ Date: "2024-03-02 08:00:00", Distance: "500", Duration: "01:10" }),
      row({ Date: "2025-06-01 08:00:00", Distance: "966", Duration: "02:26" }),
      row({ Date: "2026-01-01 09:00:00", Distance: "1309", Duration: "02:55" }),
      row({ Date: "2026-02-01 09:00:00", Distance: "100", Duration: "00:50" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  const sums = Object.values(data.years).reduce(
    (acc, y) => ({
      flights: acc.flights + y.totals.flights,
      distanceKm: acc.distanceKm + y.totals.distanceKm,
      durationMin: acc.durationMin + y.totals.durationMin,
    }),
    { flights: 0, distanceKm: 0, durationMin: 0 }
  );
  assert.equal(sums.flights, data.overall.flights);
  assert.equal(sums.distanceKm, data.overall.distanceKm);
  assert.equal(sums.durationMin, data.overall.durationMin);
  // 年度航线 totalDistanceKm 也对账到年度 totals
  for (const y of Object.values(data.years)) {
    assert.equal(y.routes.reduce((s, r) => s + r.totalDistanceKm, 0), y.totals.distanceKm);
  }
});

test("机型已识别/未识别航段数完整（全量与逐年）", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ Date: "2025-01-01 08:00:00", Plane: "Boeing 737-800" }),
      row({ Date: "2025-02-01 08:00:00", Plane: "" }),
      row({ Date: "2026-01-01 09:00:00", Plane: "Airbus A320" }),
      row({ Date: "2026-03-01 09:00:00", Plane: "   " }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.overall.aircraftKnownFlights, 2);
  assert.equal(data.overall.aircraftUnknownFlights, 2);
  assert.equal(
    data.overall.aircraftKnownFlights + data.overall.aircraftUnknownFlights,
    data.overall.flights
  );
  for (const y of Object.values(data.years)) {
    assert.equal(y.aircraftKnownFlights + y.aircraftUnknownFlights, y.totals.flights);
  }
  assert.equal(data.years["2025"].aircraftKnownFlights, 1);
  assert.equal(data.years["2025"].aircraftUnknownFlights, 1);
});

test("往返航线合并为同一条无向航线", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ From: "PEK", To: "CTU", From_OID: "3364", To_OID: "3395" }),
      row({ From: "CTU", To: "PEK", From_OID: "3395", To_OID: "3364" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.routes.length, 1);
  assert.equal(data.routes[0].from, "CTU");
  assert.equal(data.routes[0].to, "PEK");
  assert.equal(data.routes[0].flights, 2);
  assert.equal(data.footprint.routes, 1);
});

test("地图航迹不合并：往返各画一条且路径不同", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ From: "PEK", To: "CTU", From_OID: "3364", To_OID: "3395" }),
      row({ From: "CTU", To: "PEK", From_OID: "3395", To_OID: "3364" }),
      row({ From: "PEK", To: "CTU", From_OID: "3364", To_OID: "3395" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.mapLegs.length, 3);
  assert.equal(new Set(data.mapLegs.map((l) => l.d)).size, 3);
  assert.equal(data.years["2026"].mapLegs.length, 3);
  const dirs = data.mapLegs.map((l) => l.from + "->" + l.to).sort();
  assert.deepEqual(dirs, ["CTU->PEK", "PEK->CTU", "PEK->CTU"].sort());
  // 箭头朝向须跟 from→to 一致，不能按 IATA 字母序翻转
  const pekCtu = data.mapLegs.find((l) => l.from === "PEK" && l.to === "CTU");
  const ctuPek = data.mapLegs.find((l) => l.from === "CTU" && l.to === "PEK");
  assert.ok(pekCtu.arrows.length && ctuPek.arrows.length);
  const ang = (a, b) => {
    const d = ((a - b + 540) % 360) - 180;
    return Math.abs(d);
  };
  assert.ok(ang(pekCtu.arrows[0].deg, ctuPek.arrows[0].deg) > 90, "往返箭头应接近相反");
});

test("航线保留代表里程 distanceKm 且 totalDistanceKm 累计等于 overall.distanceKm", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ From: "PEK", To: "CTU", From_OID: "3364", To_OID: "3395", Distance: "966" }),
      row({ From: "CTU", To: "PEK", From_OID: "3395", To_OID: "3364", Distance: "966" }),
      row({ From: "PEK", To: "HND", From_OID: "3364", To_OID: "3888", Distance: "1309" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  const ctuPek = data.routes.find((r) => r.from === "CTU" && r.to === "PEK");
  assert.equal(ctuPek.distanceKm, Math.round(966 * 1.609344));
  assert.equal(ctuPek.totalDistanceKm, 2 * Math.round(966 * 1.609344));
  const sumRoutes = data.routes.reduce((s, r) => s + r.totalDistanceKm, 0);
  assert.equal(sumRoutes, data.overall.distanceKm);
});

test("机型解析：最长制造商前缀优先，未知归入「其他」并保留完整机型串", () => {
  assert.deepEqual(parseAircraft("Boeing 737-89L(WL)"), { manufacturer: "Boeing", model: "737-89L(WL)" });
  assert.deepEqual(parseAircraft("Airbus A320-214"), { manufacturer: "Airbus", model: "A320-214" });
  assert.deepEqual(parseAircraft("COMAC C919"), { manufacturer: "COMAC", model: "C919" });
  assert.deepEqual(parseAircraft("Embraer E190"), { manufacturer: "Embraer", model: "E190" });
  assert.deepEqual(parseAircraft("Bombardier CRJ900"), { manufacturer: "Bombardier", model: "CRJ900" });
  assert.deepEqual(parseAircraft("ATR 72-600"), { manufacturer: "ATR", model: "72-600" });
  assert.deepEqual(parseAircraft("De Havilland DHC-8-400"), { manufacturer: "De Havilland", model: "DHC-8-400" });
  assert.deepEqual(parseAircraft("Xian MA60"), { manufacturer: "Xian", model: "MA60" });
  // 裸型号映射：C919 归属 COMAC，型号串完整保留
  assert.deepEqual(parseAircraft("C919"), { manufacturer: "COMAC", model: "C919" });
  assert.deepEqual(parseAircraft("C919-100"), { manufacturer: "COMAC", model: "C919-100" });
  assert.deepEqual(parseAircraft("未知厂商 XY-9"), { manufacturer: "其他", model: "未知厂商 XY-9" });
  assert.equal(parseAircraft(""), null);
});

test("机型聚合按制造商归类", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ Plane: "Boeing 737-800" }),
      row({ Plane: "De Havilland DHC-8-400" }),
      row({ Plane: "MysteryJet 1000" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.manufacturers["De Havilland"].flights, 1);
  assert.equal(data.manufacturers["其他"].flights, 1);
  assert.equal(data.aircraft["MysteryJet 1000"].manufacturer, "其他");
  assert.equal(data.aircraft["DHC-8-400"].manufacturer, "De Havilland");
});

test("裸型号 C919 计入 COMAC 而非其他", () => {
  const recs = csvToRecords(makeCsv([row({ Plane: "C919" })]));
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.manufacturers["COMAC"].flights, 1);
  assert.ok(!data.manufacturers["其他"]);
  assert.equal(data.aircraft["C919"].manufacturer, "COMAC");
});

test("机场元数据、visits 与足迹聚合", () => {
  const recs = csvToRecords(
    makeCsv([
      row({ From: "PEK", To: "CTU", From_OID: "3364", To_OID: "3395" }),
      row({ From: "PEK", To: "HND", From_OID: "3364", To_OID: "3888" }),
    ])
  );
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.airports.PEK.visits, 2);
  assert.equal(data.airports.PEK.city, "Beijing");
  assert.equal(data.airports.PEK.continent, "Asia");
  assert.equal(data.airports.HND.country, "Japan");
  assert.equal(data.footprint.airports, 3);
  assert.equal(data.footprint.countries, 2);
  assert.equal(data.footprint.cities, 3);
  assert.equal(data.footprint.continents, 1);
});

test("敏感字段不出现在输出 JSON 中", () => {
  const note = '"Ticket 9999000011111; UMETRIP 1697km; 私密备注内容XYZ"';
  const recs = csvToRecords(
    makeCsv([
      row({
        Flight_Number: "CA9999",
        Seat: "99Z",
        Registration: "B9999",
        Trip: "私密行程分组ABC",
        Note: note,
      }),
    ])
  );
  const json = JSON.stringify(buildTravelData(recs, makeAirportIndex()));
  for (const secret of [
    "CA9999", "99Z", "B9999", "9999000011111", "私密备注内容XYZ",
    "私密行程分组ABC", "Ticket", "UMETRIP",
  ]) {
    assert.ok(!json.includes(secret), `输出中不应包含敏感内容: ${secret}`);
  }
  // 结构性检查：输出中不存在逐航段明细或敏感键名
  for (const key of ["Flight_Number", "Seat", "Seat_Type", "Class", "Reason", "Registration", "Trip", "Note"]) {
    assert.ok(!json.includes(`"${key}"`), `输出中不应包含字段: ${key}`);
  }
});

test("机场 OID 缺失时按 IATA 兜底匹配", () => {
  const recs = csvToRecords(makeCsv([row({ From_OID: "", To_OID: "" })]));
  const data = buildTravelData(recs, makeAirportIndex());
  assert.equal(data.airports.PEK.name, "Beijing Capital International Airport");
  assert.equal(data.airports.CTU.lat, 30.5785);
});

test("机场无法匹配时明确报错，不猜测坐标", () => {
  const recs = csvToRecords(makeCsv([row({ From: "XXX", To: "CTU", From_OID: "99999999" })]));
  assert.throws(() => buildTravelData(recs, makeAirportIndex()), /未找到/);
});
