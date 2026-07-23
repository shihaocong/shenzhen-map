#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import https from "node:https";

const DEFAULT_WORKBOOK = "/Users/shihaocong/Desktop/深圳园区班车线路表26-3-30.xlsx";
const DATA_DIR = resolve("data");
const ROUTES_PATH = resolve(DATA_DIR, "routes.json");
const GEOCODE_CACHE_PATH = resolve(DATA_DIR, "geocode-cache.json");
const OSRM_CACHE_PATH = resolve(DATA_DIR, "osrm-cache.json");
const MANUAL_GEOCODES_PATH = resolve(DATA_DIR, "manual-geocodes.json");

const SHENZHEN_CENTER = { lat: 22.5431, lng: 114.0579 };
const DONGGUAN_CENTER = { lat: 23.0207, lng: 113.7518 };
const REGION_BOUNDS = {
  minLng: 113.64,
  minLat: 22.34,
  maxLng: 114.68,
  maxLat: 23.26,
};

const ROUTE_COLORS = [
  "#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9",
  "#B2182B", "#2166AC", "#1B9E77", "#D95F02", "#7570B3", "#E7298A",
  "#66A61E", "#A6761D", "#1F78B4", "#E31A1C", "#33A02C", "#FF7F00",
  "#6A3D9A", "#008080", "#C51B7D", "#4D4D4D", "#8C6D31",
];

const cli = parseArgs(process.argv.slice(2));
const workbookPath = resolve(cli.workbook ?? DEFAULT_WORKBOOK);

await mkdir(DATA_DIR, { recursive: true });

const parsed = cli.existingData
  ? await readExistingRouteData()
  : await parseWorkbook(workbookPath);
let geocodeCache = await readJson(GEOCODE_CACHE_PATH, emptyGeocodeCache());
geocodeCache = reconcileGeocodeCache(geocodeCache, parsed.stops);
const manualGeocodes = await readJson(MANUAL_GEOCODES_PATH, emptyManualGeocodes());
geocodeCache = applyManualGeocodes(geocodeCache, parsed.stops, manualGeocodes);

if (!cli.parseOnly) {
  geocodeCache = await geocodeStops(geocodeCache, parsed.stops, { refresh: cli.refresh });
}

await writeJson(GEOCODE_CACHE_PATH, geocodeCache);

let routes = mergeGeocodes(parsed, geocodeCache);
let osrmCache = await readJson(OSRM_CACHE_PATH, emptyOsrmCache());

if (!cli.parseOnly && !cli.skipRouting) {
  ({ routes, cache: osrmCache } = await routeDirections(routes, osrmCache, {
    refresh: cli.refresh || cli.refreshRouting,
  }));
}

routes.meta.geocoding = summarizeGeocoding(routes.stops);
routes.meta.routing = summarizeRouting(routes.routes);

await writeJson(OSRM_CACHE_PATH, osrmCache);
await writeJson(ROUTES_PATH, routes);

console.log(JSON.stringify({
  output: ROUTES_PATH,
  routes: routes.meta.routeCount,
  directions: routes.meta.directionCount,
  uniqueStops: routes.meta.uniqueStopCount,
  geocoding: routes.meta.geocoding,
  routing: routes.meta.routing,
}, null, 2));

function parseArgs(args) {
  const parsed = {
    parseOnly: false,
    skipRouting: false,
    refresh: false,
    refreshRouting: false,
    existingData: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--parse-only") parsed.parseOnly = true;
    else if (arg === "--skip-routing") parsed.skipRouting = true;
    else if (arg === "--refresh") parsed.refresh = true;
    else if (arg === "--refresh-routing") parsed.refreshRouting = true;
    else if (arg === "--existing-data") parsed.existingData = true;
    else if (arg === "--workbook") parsed.workbook = args[++i];
    else if (!arg.startsWith("--") && !parsed.workbook) parsed.workbook = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

async function readExistingRouteData() {
  const data = await readJson(ROUTES_PATH, null);
  if (!data || !Array.isArray(data.routes) || !Array.isArray(data.stops)) {
    throw new Error(`Existing route data is unavailable: ${ROUTES_PATH}`);
  }
  return data;
}

async function parseWorkbook(path) {
  const stringsXml = unzipEntry(path, "xl/sharedStrings.xml");
  const workbookXml = unzipEntry(path, "xl/workbook.xml");
  const sheetXml = unzipEntry(path, "xl/worksheets/sheet1.xml");
  const strings = parseSharedStrings(stringsXml);
  const rows = parseSheetRows(sheetXml, strings);
  const sourceStat = await stat(path);
  const sheetName = decodeXml((workbookXml.match(/<sheet\b[^>]*\bname="([^"]+)"/) ?? [])[1] ?? "Sheet1");

  const headerRows = [...rows.keys()]
    .filter((rowNumber) => isRouteTitle(rows.get(rowNumber)?.get("A")))
    .sort((a, b) => a - b);

  if (process.env.DEBUG_XLSX) {
    console.error(JSON.stringify({
      sharedStringCount: strings.length,
      rowCount: rows.size,
      columnA: [...rows.entries()].slice(0, 24).map(([rowNumber, cells]) => [rowNumber, cells.get("A")]),
      headerRows,
    }, null, 2));
  }

  const routes = [];
  const stopRegistry = new Map();
  let stopOrder = 0;
  const finalWorkbookRow = Math.max(...rows.keys());

  for (let routeIndex = 0; routeIndex < headerRows.length; routeIndex += 1) {
    const titleRow = headerRows[routeIndex];
    const nextTitleRow = headerRows[routeIndex + 1] ?? finalWorkbookRow + 1;
    const titleCells = rows.get(titleRow);
    const title = String(titleCells.get("A")).trim();
    const note = [...titleCells.entries()]
      .filter(([column, value]) => column !== "A" && typeof value === "string" && value.trim())
      .map(([, value]) => value.trim())
      .join("；") || null;
    const directionRows = [];

    for (let rowNumber = titleRow + 1; rowNumber < nextTitleRow; rowNumber += 1) {
      const row = rows.get(rowNumber);
      if (!row) continue;
      const directionLabel = String(row.get("B") ?? "").trim();
      if (!["上班", "下班"].includes(directionLabel) || String(row.get("C") ?? "").trim() !== "站点") {
        continue;
      }
      directionRows.push({ rowNumber, row, directionLabel });
    }

    if (directionRows.length === 0) continue;

    const routeLabel = directionRows
      .map(({ row }) => String(row.get("A") ?? "").trim())
      .find(Boolean) ?? routeLabelFromTitle(title);
    const routeId = routeIdFromLabel(routeLabel);
    const category = routeCategory(routeLabel);
    const rawDirections = directionRows.map(({ rowNumber, row, directionLabel }) => {
      const timeRow = rows.get(rowNumber + 1);
      const hasTimeRow = String(timeRow?.get("C") ?? "").trim() === "时间";
      const stops = [];

      for (const column of columnsBetween("D", "P")) {
        const rawValue = row.get(column);
        if (typeof rawValue !== "string" || !rawValue.trim()) continue;
        const rawName = normalizeWhitespace(rawValue);
        const normalizedName = normalizeStopName(rawName);
        const stopId = stopIdFor(normalizedName);
        const city = expectedCity(routeLabel, normalizedName);
        const rawTime = hasTimeRow ? timeRow.get(column) : null;

        if (!stopRegistry.has(stopId)) {
          stopRegistry.set(stopId, {
            id: stopId,
            rawName,
            normalizedName,
            aliases: [rawName],
            expectedCities: [city],
            firstSeenOrder: stopOrder++,
          });
        } else {
          const existing = stopRegistry.get(stopId);
          if (!existing.aliases.includes(rawName)) existing.aliases.push(rawName);
          if (!existing.expectedCities.includes(city)) existing.expectedCities.push(city);
        }

        stops.push({
          sequence: stops.length + 1,
          stopId,
          rawName,
          normalizedName,
          scheduledTime: normalizeTime(rawTime),
          rawTime: rawTime == null || rawTime === "" ? null : rawTime,
        });
      }

      const scheduledTimes = stops.map((stop) => stop.scheduledTime);
      return {
        id: directionLabel === "上班" ? "inbound" : "outbound",
        label: directionLabel,
        stops,
        trips: [{
          id: `${directionLabel === "上班" ? "inbound" : "outbound"}-1`,
          departureTime: scheduledTimes.find(Boolean) ?? null,
          scheduledTimes,
        }],
      };
    });
    const directions = consolidateDirections(rawDirections.filter((direction) => direction.stops.length > 0));

    routes.push({
      id: routeId,
      code: routeCode(routeLabel),
      name: routeLabel,
      title,
      note,
      category,
      color: ROUTE_COLORS[routes.length % ROUTE_COLORS.length],
      directions,
    });
  }

  const stops = [...stopRegistry.values()]
    .sort((a, b) => a.firstSeenOrder - b.firstSeenOrder)
    .map(({ firstSeenOrder: _discard, ...stop }) => stop);

  return {
    schemaVersion: 1,
    meta: {
      sourceFile: basename(path),
      sourceSheet: sheetName,
      sourceModifiedAt: sourceStat.mtime.toISOString(),
      coordinateSystem: "WGS84",
      routeCount: routes.length,
      directionCount: routes.reduce((sum, route) => sum + route.directions.length, 0),
      rawUniqueStopCount: new Set(routes.flatMap((route) => route.directions.flatMap((direction) => direction.stops.map((stop) => stop.rawName)))).size,
      uniqueStopCount: stops.length,
    },
    routes,
    stops,
  };
}

function consolidateDirections(directions) {
  const grouped = [];
  const lookup = new Map();
  for (const direction of directions) {
    const signature = `${direction.label}:${direction.stops.map((stop) => stop.stopId).join(",")}`;
    const existing = lookup.get(signature);
    if (!existing) {
      lookup.set(signature, direction);
      grouped.push(direction);
      continue;
    }
    const trip = direction.trips[0];
    existing.trips.push({ ...trip, id: `${existing.id}-${existing.trips.length + 1}` });
  }
  const labelCounts = new Map();
  for (const direction of grouped) {
    const count = (labelCounts.get(direction.id) ?? 0) + 1;
    labelCounts.set(direction.id, count);
    if (count > 1) direction.id = `${direction.id}-variant-${count}`;
  }
  return grouped;
}

function unzipEntry(path, entry) {
  return execFileSync("unzip", ["-p", path, entry], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => {
    const textNodes = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)];
    return textNodes.map((node) => decodeXml(node[1])).join("");
  });
}

function parseSheetRows(xml, sharedStrings) {
  const rows = new Map();
  const cellRegex = /<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g;
  for (const match of xml.matchAll(cellRegex)) {
    const token = match[0];
    const attributes = (token.match(/^<c\b([^>]*)>/) ?? [])[1] ?? "";
    const body = token.endsWith("/>") ? "" : (token.match(/^<c\b[^>]*>([\s\S]*?)<\/c>$/) ?? [])[1] ?? "";
    const reference = (attributes.match(/\br="([A-Z]+\d+)"/) ?? [])[1];
    if (!reference) continue;
    const [, column, rowText] = reference.match(/^([A-Z]+)(\d+)$/);
    const type = (attributes.match(/\bt="([^"]+)"/) ?? [])[1];
    const valueText = (body.match(/<v>([\s\S]*?)<\/v>/) ?? [])[1];
    let value = null;
    if (type === "s" && valueText != null) value = sharedStrings[Number(valueText)] ?? null;
    else if (type === "inlineStr") {
      value = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((node) => decodeXml(node[1]))
        .join("");
    } else if (valueText != null && valueText !== "") {
      value = Number.isFinite(Number(valueText)) ? Number(valueText) : decodeXml(valueText);
    }
    if (!rows.has(Number(rowText))) rows.set(Number(rowText), new Map());
    rows.get(Number(rowText)).set(column, value);
  }
  return rows;
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function isRouteTitle(value) {
  return typeof value === "string"
    && /^拓邦(?:班车|加班)/.test(value.trim())
    && /(号线|支援线|松山湖线|龙岗线|班车线\d)/.test(value);
}

function routeLabelFromTitle(title) {
  const match = title.match(/^拓邦(?:班车)?(.+?线\d?|\d+[A-Z]?号线)[：:]/);
  return match?.[1] ?? title.split(/[：:]/)[0].replace(/^拓邦班车/, "");
}

function routeIdFromLabel(label) {
  const normalized = label.toLowerCase();
  if (/^\d+[a-z]?号线$/.test(normalized)) return `route-${normalized.replace("号线", "")}`;
  if (label === "支援线") return "route-support";
  if (label === "松山湖线") return "route-songshanhu";
  if (label === "龙岗线") return "route-longgang";
  const overtime = label.match(/加班班车线(\d+)/);
  if (overtime) return `route-overtime-${overtime[1]}`;
  return `route-${createHash("sha1").update(label).digest("hex").slice(0, 8)}`;
}

function routeCode(label) {
  return label
    .replace(/^拓邦/, "")
    .replace(/^班车/, "")
    .replace(/号线$/, "")
    .replace(/^加班班车线/, "加班");
}

function routeCategory(label) {
  if (label.includes("加班")) return "overtime";
  if (label.includes("支援")) return "support";
  if (label.includes("松山湖") || label.includes("龙岗")) return "regional";
  return "regular";
}

function expectedCity(routeLabel, normalizedName) {
  if (routeLabel === "松山湖线" && normalizedName !== "拓邦工业园") return "东莞";
  return "深圳";
}

function normalizeWhitespace(value) {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeStopName(value) {
  return normalizeWhitespace(value)
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[&＆]/g, "与")
    .replace(/\s+[12]$/, "")
    .replace(/公交站台(?=\s*\(?\d*\)?$)/, "公交站")
    .replace(/公交站后面路边$/, "公交站")
    .replace(/([\p{L}\p{N}])1公交站$/u, "$1公交站")
    .replace(/公交站\s*\([12]\)$/, "公交站")
    .replace(/西乡立交1公交站$/, "西乡立交公交站")
    .replace(/九祥岭2公交站$/, "九祥岭公交站")
    .replace(/上横郎/g, "上横朗")
    .replace(/^锦秀江南/, "锦绣江南")
    .trim();
}

function stopIdFor(normalizedName) {
  const digest = createHash("sha1").update(normalizedName).digest("hex").slice(0, 10);
  return `stop-${digest}`;
}

function columnsBetween(first, last) {
  const start = columnNumber(first);
  const end = columnNumber(last);
  return Array.from({ length: end - start + 1 }, (_, index) => columnName(start + index));
}

function columnNumber(name) {
  return [...name].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
}

function columnName(number) {
  let result = "";
  for (let value = number; value > 0; value = Math.floor((value - 1) / 26)) {
    result = String.fromCharCode(((value - 1) % 26) + 65) + result;
  }
  return result;
}

function normalizeTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const minutes = Math.round((value % 1) * 24 * 60);
    return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.normalize("NFKC").trim().replace(/[；;]/g, ":");
  const match = normalized.match(/^(\d{1,2})\s*:\s*(\d{1,2})$/);
  if (!match) return normalized;
  return `${match[1].padStart(2, "0")}:${match[2].padStart(2, "0")}`;
}

function emptyGeocodeCache() {
  return {
    schemaVersion: 1,
    provider: {
      name: "Nominatim",
      endpoint: "https://nominatim.openstreetmap.org/search",
      attribution: "OpenStreetMap contributors",
      coordinateSystem: "WGS84",
    },
    stops: {},
  };
}

function emptyManualGeocodes() {
  return {
    schemaVersion: 1,
    coordinateSystem: "WGS84",
    provider: "manual",
    provenance: "manual",
    stops: [],
  };
}

function reconcileGeocodeCache(cache, stops) {
  const previousStops = cache?.stops ?? {};
  const next = { ...emptyGeocodeCache(), ...cache, stops: {} };
  for (const stop of stops) {
    const cached = previousStops[stop.id] ?? {};
    const previous = cached.provider === "manual" ? {} : cached;
    next.stops[stop.id] = {
      id: stop.id,
      rawName: stop.rawName,
      normalizedName: stop.normalizedName,
      aliases: stop.aliases,
      expectedCities: stop.expectedCities,
      query: previous.query ?? null,
      lat: previous.lat ?? null,
      lng: previous.lng ?? null,
      confidence: previous.confidence ?? 0,
      status: previous.status ?? "unresolved",
      displayName: previous.displayName ?? null,
      provider: previous.provider ?? null,
      osmType: previous.osmType ?? null,
      osmId: previous.osmId ?? null,
      candidateCount: previous.candidateCount ?? 0,
      reason: previous.reason ?? "not-geocoded",
      sourceProvider: previous.sourceProvider ?? null,
      sourceCoordinateSystem: previous.sourceCoordinateSystem ?? null,
      sourceLat: previous.sourceLat ?? null,
      sourceLng: previous.sourceLng ?? null,
    };
  }
  return next;
}

function applyManualGeocodes(cache, stops, manual) {
  const entries = Array.isArray(manual?.stops) ? manual.stops : [];
  if (entries.length === 0) return cache;

  const stopByNormalizedName = new Map(stops.map((stop) => [stop.normalizedName, stop]));
  const matchedStopIds = new Set();

  for (const entry of entries) {
    const entryName = normalizeStopName(entry?.name ?? "");
    const stop = stopByNormalizedName.get(entryName);
    if (!stop) throw new Error(`Manual geocode does not match a workbook stop: ${entry?.name ?? "(missing name)"}`);
    if (matchedStopIds.has(stop.id)) throw new Error(`Duplicate manual geocode for stop: ${stop.normalizedName}`);

    const sourceLat = Number(entry.lat);
    const sourceLng = Number(entry.lng);
    if (!Number.isFinite(sourceLat) || !Number.isFinite(sourceLng)) {
      throw new Error(`Invalid manual coordinate for stop: ${stop.normalizedName}`);
    }

    const sourceCoordinateSystem = String(entry.coordinateSystem ?? manual.coordinateSystem ?? "WGS84").toUpperCase();
    const [lng, lat] = sourceCoordinateSystem === "GCJ-02"
      ? gcj02ToWgs84(sourceLng, sourceLat)
      : sourceCoordinateSystem === "WGS84" || sourceCoordinateSystem === "WGS-84"
        ? [sourceLng, sourceLat]
        : (() => { throw new Error(`Unsupported coordinate system: ${sourceCoordinateSystem}`); })();

    cache.stops[stop.id] = {
      ...cache.stops[stop.id],
      query: entry.name,
      lat: round(lat, 7),
      lng: round(lng, 7),
      confidence: 1,
      status: "resolved",
      displayName: null,
      provider: "manual",
      osmType: null,
      osmId: null,
      candidateCount: 1,
      reason: "user-provided-coordinate",
      sourceProvider: entry.provider ?? manual.provider ?? "manual",
      sourceCoordinateSystem,
      sourceLat,
      sourceLng,
    };
    matchedStopIds.add(stop.id);
  }

  return cache;
}

async function geocodeStops(cache, stops, { refresh }) {
  const eligible = stops.filter((stop) => {
    const cached = cache.stops[stop.id];
    if (cached?.provider === "manual") return false;
    return refresh || cached?.status !== "resolved";
  });

  let lastRequestAt = 0;
  for (let index = 0; index < eligible.length; index += 1) {
    const stop = eligible[index];
    const city = preferredCity(stop.expectedCities);
    const queryName = queryNameFor(stop.normalizedName);
    const query = `${queryName}, ${city}市, 广东省`;
    const waitMs = Math.max(0, 1100 - (Date.now() - lastRequestAt));
    if (waitMs) await delay(waitMs);

    let candidates = [];
    let requestError = null;
    try {
      lastRequestAt = Date.now();
      candidates = await nominatimSearch(query);
    } catch (error) {
      requestError = error;
    }

    const scored = candidates
      .map((candidate) => scoreCandidate(candidate, queryName, city))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    const accepted = best && best.score >= 0.55 && best.nameScore >= 0.38;
    const ambiguous = best && !accepted && best.score >= 0.43 && best.nameScore >= 0.28;

    cache.stops[stop.id] = {
      ...cache.stops[stop.id],
      query,
      lat: accepted ? Number(best.candidate.lat) : null,
      lng: accepted ? Number(best.candidate.lon) : null,
      confidence: best ? round(best.score, 3) : 0,
      status: accepted ? "resolved" : ambiguous ? "ambiguous" : "unresolved",
      displayName: best?.candidate.display_name ?? null,
      provider: best ? "Nominatim" : null,
      osmType: best?.candidate.osm_type ?? null,
      osmId: best?.candidate.osm_id ?? null,
      candidateCount: candidates.length,
      reason: requestError ? `request-error: ${requestError.message}`
        : accepted ? "accepted-by-name-region-score"
          : ambiguous ? "candidate-needs-review" : "no-reliable-candidate",
    };

    process.stderr.write(`[geocode ${index + 1}/${eligible.length}] ${stop.normalizedName}: ${cache.stops[stop.id].status}\n`);
    await writeJson(GEOCODE_CACHE_PATH, cache);
  }
  return cache;
}

function queryNameFor(name) {
  return name
    .replace(/\([^)]*(?:对面|路口|大门|上沙河|中石化|加油站)[^)]*\)/g, "")
    .replace(/\((?:公交站|\d+号门|[A-Z]出口|\d+)\)/g, "")
    .replace(/公交站(?:台)?$/, "")
    .replace(/地铁站[A-Z]?出口$/, "地铁站")
    .replace(/\s+/g, " ")
    .trim();
}

function preferredCity(cities) {
  if (cities.length === 1) return cities[0];
  return cities.includes("深圳") ? "深圳" : cities[0];
}

async function nominatimSearch(query) {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    addressdetails: "1",
    namedetails: "1",
    limit: "8",
    countrycodes: "cn",
    bounded: "1",
    viewbox: `${REGION_BOUNDS.minLng},${REGION_BOUNDS.maxLat},${REGION_BOUNDS.maxLng},${REGION_BOUNDS.minLat}`,
    accept_language: "zh-CN,zh,en",
  });
  return getJson(`https://nominatim.openstreetmap.org/search?${params}`, {
    "User-Agent": "ShenzhenShuttleMap/1.0 (local route visualization)",
    Referer: "http://localhost/",
  });
}

function scoreCandidate(candidate, queryName, expectedCityName) {
  const displayName = String(candidate.display_name ?? "");
  const candidateName = String(candidate.name ?? candidate.namedetails?.name ?? displayName.split(",")[0] ?? "");
  const queryCore = compactPlaceName(queryName);
  const candidateCore = compactPlaceName(candidateName);
  const displayCore = compactPlaceName(displayName);
  let nameScore = Math.max(diceCoefficient(queryCore, candidateCore), diceCoefficient(queryCore, displayCore));
  if (candidateCore && (candidateCore.includes(queryCore) || queryCore.includes(candidateCore))) {
    nameScore = Math.max(nameScore, Math.min(candidateCore.length, queryCore.length) / Math.max(candidateCore.length, queryCore.length));
  }
  if (displayCore.includes(queryCore)) nameScore = Math.max(nameScore, 0.92);

  const addressText = Object.values(candidate.address ?? {}).join(" ");
  const inGuangdong = /广东/.test(`${displayName} ${addressText}`);
  const inExpectedCity = new RegExp(expectedCityName).test(`${displayName} ${addressText}`);
  const regionScore = inExpectedCity ? 1 : inGuangdong ? 0.48 : 0;

  const center = expectedCityName === "东莞" ? DONGGUAN_CENTER : SHENZHEN_CENTER;
  const distanceKm = haversineKm(center, { lat: Number(candidate.lat), lng: Number(candidate.lon) });
  const distanceScore = Math.max(0, 1 - distanceKm / 95);
  const typeScore = /public_transport|railway|amenity|building|place|highway/.test(`${candidate.category} ${candidate.type}`) ? 1 : 0.55;
  const importanceScore = Math.min(1, Number(candidate.importance ?? 0) * 4);
  const score = nameScore * 0.64 + regionScore * 0.18 + distanceScore * 0.1 + typeScore * 0.05 + importanceScore * 0.03;

  return { candidate, score, nameScore, regionScore, distanceKm };
}

function compactPlaceName(value) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/广东省|深圳市|东莞市|深圳|东莞/g, "")
    .replace(/公交站(?:台)?|地铁站|站台|路口|天桥|[a-z]出口/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function gcj02ToWgs84(lng, lat) {
  if (outsideChina(lng, lat)) return [lng, lat];

  let minLng = lng - 0.02;
  let maxLng = lng + 0.02;
  let minLat = lat - 0.02;
  let maxLat = lat + 0.02;

  for (let index = 0; index < 32; index += 1) {
    const candidateLng = (minLng + maxLng) / 2;
    const candidateLat = (minLat + maxLat) / 2;
    const [projectedLng, projectedLat] = wgs84ToGcj02(candidateLng, candidateLat);
    if (projectedLng > lng) maxLng = candidateLng;
    else minLng = candidateLng;
    if (projectedLat > lat) maxLat = candidateLat;
    else minLat = candidateLat;
  }

  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

function wgs84ToGcj02(lng, lat) {
  if (outsideChina(lng, lat)) return [lng, lat];
  const semiMajorAxis = 6378245;
  const eccentricitySquared = 0.006693421622965943;
  const latitudeRadians = lat / 180 * Math.PI;
  const sine = Math.sin(latitudeRadians);
  const magic = 1 - eccentricitySquared * sine * sine;
  const squareRootMagic = Math.sqrt(magic);
  let latitudeDelta = transformLatitude(lng - 105, lat - 35);
  let longitudeDelta = transformLongitude(lng - 105, lat - 35);
  latitudeDelta = latitudeDelta * 180
    / ((semiMajorAxis * (1 - eccentricitySquared)) / (magic * squareRootMagic) * Math.PI);
  longitudeDelta = longitudeDelta * 180
    / (semiMajorAxis / squareRootMagic * Math.cos(latitudeRadians) * Math.PI);
  return [lng + longitudeDelta, lat + latitudeDelta];
}

function transformLatitude(x, y) {
  return -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y
    + 0.2 * Math.sqrt(Math.abs(x))
    + (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
    + (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
    + (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
}

function transformLongitude(x, y) {
  return 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y
    + 0.1 * Math.sqrt(Math.abs(x))
    + (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
    + (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
    + (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
}

function outsideChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function diceCoefficient(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length === 1 || right.length === 1) return left === right ? 1 : 0;
  const leftPairs = bigrams(left);
  const rightCounts = new Map();
  for (const pair of bigrams(right)) rightCounts.set(pair, (rightCounts.get(pair) ?? 0) + 1);
  let overlap = 0;
  for (const pair of leftPairs) {
    const count = rightCounts.get(pair) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightCounts.set(pair, count - 1);
    }
  }
  return (2 * overlap) / (leftPairs.length + Math.max(1, right.length - 1));
}

function bigrams(value) {
  return Array.from({ length: Math.max(0, value.length - 1) }, (_, index) => value.slice(index, index + 2));
}

function haversineKm(a, b) {
  const radiusKm = 6371;
  const latitudeDelta = toRadians(b.lat - a.lat);
  const longitudeDelta = toRadians(b.lng - a.lng);
  const value = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(value));
}

function toRadians(value) {
  return value * Math.PI / 180;
}

function mergeGeocodes(parsed, cache) {
  const stopLookup = Object.fromEntries(parsed.stops.map((stop) => {
    const geocode = cache.stops[stop.id];
    return [stop.id, {
      ...stop,
      lat: geocode?.lat ?? null,
      lng: geocode?.lng ?? null,
      confidence: geocode?.confidence ?? 0,
      status: geocode?.status ?? "unresolved",
      displayName: geocode?.displayName ?? null,
      provider: geocode?.provider ?? null,
      sourceProvider: geocode?.sourceProvider ?? null,
      sourceCoordinateSystem: geocode?.sourceCoordinateSystem ?? null,
      sourceLat: geocode?.sourceLat ?? null,
      sourceLng: geocode?.sourceLng ?? null,
    }];
  }));

  const routes = parsed.routes.map((route) => ({
    ...route,
    directions: route.directions.map((direction) => ({
      ...direction,
      geometry: null,
      geometryStatus: "unavailable",
      geometrySource: null,
      distanceMeters: null,
      durationSeconds: null,
      resolvedWaypointCount: direction.stops.filter((stop) => stopLookup[stop.stopId]?.status === "resolved").length,
      totalStopCount: direction.stops.length,
      missingStopSequences: direction.stops
        .filter((stop) => stopLookup[stop.stopId]?.status !== "resolved")
        .map((stop) => stop.sequence),
      stops: direction.stops.map((routeStop) => ({
        ...routeStop,
        lat: stopLookup[routeStop.stopId]?.lat ?? null,
        lng: stopLookup[routeStop.stopId]?.lng ?? null,
        confidence: stopLookup[routeStop.stopId]?.confidence ?? 0,
        status: stopLookup[routeStop.stopId]?.status ?? "unresolved",
        displayName: stopLookup[routeStop.stopId]?.displayName ?? null,
        coordinateProvider: stopLookup[routeStop.stopId]?.provider ?? null,
      })),
    })),
  }));

  return { ...parsed, routes, stops: Object.values(stopLookup) };
}

function emptyOsrmCache() {
  return {
    schemaVersion: 1,
    provider: {
      name: "OSRM",
      endpoint: "https://router.project-osrm.org/route/v1/driving",
      profile: "driving",
      coordinateSystem: "WGS84",
    },
    routes: {},
  };
}

async function routeDirections(data, cache, { refresh }) {
  const nextCache = { ...emptyOsrmCache(), ...cache, routes: { ...(cache.routes ?? {}) } };
  let lastRequestAt = 0;

  for (const route of data.routes) {
    for (const direction of route.directions) {
      const waypoints = direction.stops.filter((stop) => stop.status === "resolved" && stop.lat != null && stop.lng != null);
      const isComplete = waypoints.length === direction.stops.length;
      if (waypoints.length < 2) continue;

      const coordinateText = waypoints.map((stop) => `${Number(stop.lng).toFixed(6)},${Number(stop.lat).toFixed(6)}`).join(";");
      const cacheKey = createHash("sha1").update(coordinateText).digest("hex");
      let cached = nextCache.routes[cacheKey];
      const previousCached = cached;

      if (!cached || cached.status === "fallback" || refresh) {
        const waitMs = Math.max(0, 650 - (Date.now() - lastRequestAt));
        if (waitMs) await delay(waitMs);
        try {
          lastRequestAt = Date.now();
          const response = await getJson(
            `https://router.project-osrm.org/route/v1/driving/${coordinateText}?overview=full&geometries=geojson&steps=false`,
            { "User-Agent": "ShenzhenShuttleMap/1.0 (local route visualization)" },
          );
          const result = response.routes?.[0];
          if (!result?.geometry?.coordinates?.length) throw new Error(`OSRM ${response.code ?? "empty response"}`);
          cached = {
            status: "routed",
            geometry: result.geometry,
            distanceMeters: Math.round(result.distance),
            durationSeconds: Math.round(result.duration),
          };
        } catch (error) {
          cached = previousCached?.status === "routed"
            ? previousCached
            : {
                status: "fallback",
                geometry: {
                  type: "LineString",
                  coordinates: waypoints.map((stop) => [stop.lng, stop.lat]),
                },
                distanceMeters: null,
                durationSeconds: null,
                reason: error.message,
              };
        }
        nextCache.routes[cacheKey] = cached;
        await writeJson(OSRM_CACHE_PATH, nextCache);
      }

      direction.geometry = cached.geometry;
      direction.geometrySource = cached.status === "routed" ? "osrm" : "station-polyline";
      direction.geometryStatus = `${isComplete ? "complete" : "partial"}-${cached.status}`;
      direction.distanceMeters = cached.distanceMeters;
      direction.durationSeconds = cached.durationSeconds;
      process.stderr.write(`[routing] ${route.name} ${direction.label}: ${direction.geometryStatus}\n`);
    }
  }
  return { routes: data, cache: nextCache };
}

function summarizeGeocoding(stops) {
  const counts = { resolved: 0, ambiguous: 0, unresolved: 0 };
  for (const stop of stops) counts[stop.status] = (counts[stop.status] ?? 0) + 1;
  return {
    ...counts,
    manual: stops.filter((stop) => stop.provider === "manual").length,
    total: stops.length,
    resolvedRate: stops.length ? round(counts.resolved / stops.length, 4) : 0,
  };
}

function summarizeRouting(routes) {
  const counts = {};
  for (const route of routes) {
    for (const direction of route.directions) {
      counts[direction.geometryStatus] = (counts[direction.geometryStatus] ?? 0) + 1;
    }
  }
  return counts;
}

function getJson(url, headers) {
  return new Promise((resolvePromise, reject) => {
    const request = https.get(url, { headers, timeout: 30_000 }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        getJson(new URL(response.headers.location, url), headers).then(resolvePromise, reject);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 180)}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${error.message}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
