(function () {
  "use strict";

  const DATA_URL = "./data/routes.json";
  const FALLBACK_BOUNDS = [
    [22.35, 113.68],
    [23.05, 114.72],
  ];
  const ROUTE_PALETTE = [
    "#0072b2",
    "#d55e00",
    "#007b5e",
    "#9b4f86",
    "#9a6700",
    "#176b87",
    "#332288",
    "#882255",
    "#2f766d",
    "#7b4ab0",
    "#a33b20",
    "#245c28",
  ];
  const CONFIRMED_WORDS = /confirmed|verified|exact|precise|high|resolved|已确认|已核验|准确/i;
  const UNRESOLVED_WORDS = /unresolved|missing|unknown|none|未解析|无坐标|缺失/i;
  const PENDING_WORDS = /approx|estimated|inferred|pending|medium|low|待确认|估算|推测|近似/i;
  const CONFIRMED_GEOMETRY_WORDS = /complete-routed|^routed$|^complete$|confirmed|verified/i;
  const PENDING_GEOMETRY_WORDS = /partial|fallback|unavailable|approx|estimated|inferred|pending|missing/i;

  const state = {
    map: null,
    tileLayer: null,
    routes: [],
    meta: {},
    routeLayers: new Map(),
    stopMarkers: new Map(),
    allBounds: null,
    selectedRouteId: null,
    selectedDirectionId: null,
    flowGroup: null,
    tileErrors: 0,
    tileLoads: 0,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  };

  const elements = {
    routeCount: document.querySelector("#route-count"),
    stopCount: document.querySelector("#stop-count"),
    panelTitle: document.querySelector("#panel-title"),
    panelSummary: document.querySelector("#panel-summary"),
    panelBody: document.querySelector("#route-panel-body"),
    routeList: document.querySelector("#route-list"),
    drawerToggle: document.querySelector("#drawer-toggle"),
    mapStatus: document.querySelector("#map-status"),
    mapNotice: document.querySelector("#map-notice"),
    mapNoticeText: document.querySelector("#map-notice-text"),
    tileRetry: document.querySelector("#tile-retry"),
    leafletCss: document.querySelector("#leaflet-css"),
    inboundLegend: document.querySelector("#inbound-legend"),
    outboundLegend: document.querySelector("#outbound-legend"),
  };

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    if (window.lucide) {
      window.lucide.createIcons({ attrs: { "stroke-width": 2 } });
    }

    bindInterfaceEvents();

    if (!window.L || elements.leafletCss?.dataset.failed === "true") {
      showFatal(
        "地图组件加载失败",
        "无法连接地图资源，请检查网络后重试。",
      );
      renderListMessage("地图组件未加载，暂时无法显示线路。", true);
      return;
    }

    createMap();

    try {
      const response = await fetch(DATA_URL, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      const normalized = normalizePayload(payload);
      state.routes = normalized.routes;
      state.meta = normalized.meta;

      updateMetrics();
      renderRouteList();
      renderRoutes();

      if (!state.routes.length) {
        showFatal("暂无线路数据", "线路文件中没有可显示的路线。", false);
        return;
      }

      if (!state.allBounds || !state.allBounds.isValid()) {
        showFatal("站点坐标待补充", "线路已读取，但当前没有可定位到地图的站点。", false);
        return;
      }

      fitAllRoutes(false);
      hideMapStatus();
    } catch (error) {
      console.error("Failed to load route data", error);
      showFatal(
        "线路数据加载失败",
        "请确认 data/routes.json 存在，并通过本地服务器打开页面。",
      );
      renderListMessage("无法读取线路数据。", true);
    }
  }

  function bindInterfaceEvents() {
    elements.drawerToggle.addEventListener("click", () => {
      setDrawerOpen(!document.body.classList.contains("drawer-open"));
    });

    elements.tileRetry.addEventListener("click", () => {
      state.tileErrors = 0;
      state.tileLoads = 0;
      hideMapNotice();
      state.tileLayer?.redraw();
    });

    elements.routeList.addEventListener("click", (event) => {
      const target = event.target.closest("button[data-action]");
      if (!target) return;

      const action = target.dataset.action;
      if (action === "select-route") {
        selectRoute(target.dataset.routeId);
      } else if (action === "select-direction") {
        selectDirection(target.dataset.routeId, target.dataset.directionId);
      } else if (action === "select-stop") {
        openStop(target.dataset.stopKey);
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (document.body.classList.contains("drawer-open") && isMobile()) {
        setDrawerOpen(false);
      } else if (state.selectedRouteId) {
        clearSelection();
      }
    });
  }

  function createMap() {
    state.map = window.L.map("map", {
      zoomControl: false,
      preferCanvas: false,
      keyboard: true,
      zoomAnimation: !state.reducedMotion,
      fadeAnimation: !state.reducedMotion,
      markerZoomAnimation: !state.reducedMotion,
    });

    state.map.fitBounds(FALLBACK_BOUNDS, { animate: false });
    createRoutePanes();
    window.L.control.zoom({ position: "bottomright" }).addTo(state.map);

    state.tileLayer = window.L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      {
        subdomains: "abcd",
        maxZoom: 20,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      },
    ).addTo(state.map);

    state.tileLayer.on("tileload", () => {
      state.tileLoads += 1;
      if (state.tileLoads > 0) hideMapNotice();
    });

    state.tileLayer.on("tileerror", () => {
      state.tileErrors += 1;
      if (state.tileErrors >= 3 && state.tileLoads === 0) {
        showMapNotice("深圳底图暂时无法加载，线路仍可查看。");
      }
    });

    addFitControl();
  }

  function createRoutePanes() {
    const panes = [
      ["routeCasingPane", 410],
      ["routeLinePane", 420],
      ["routeFlowPane", 430],
    ];
    panes.forEach(([name, zIndex]) => {
      const pane = state.map.createPane(name);
      pane.style.zIndex = String(zIndex);
      pane.style.pointerEvents = name === "routeLinePane" ? "auto" : "none";
    });
  }

  function addFitControl() {
    const FitControl = window.L.Control.extend({
      options: { position: "topright" },
      onAdd() {
        const container = window.L.DomUtil.create("div", "leaflet-bar");
        const button = window.L.DomUtil.create("a", "fit-control", container);
        button.href = "#";
        button.textContent = "全览";
        button.title = "显示全部线路";
        button.setAttribute("role", "button");
        button.setAttribute("aria-label", "显示全部线路");
        window.L.DomEvent.disableClickPropagation(container);
        window.L.DomEvent.on(button, "click", (event) => {
          window.L.DomEvent.preventDefault(event);
          clearSelection();
        });
        return container;
      },
    });

    new FitControl().addTo(state.map);
  }

  function normalizePayload(payload) {
    const rawRoutes = Array.isArray(payload)
      ? payload
      : payload?.routes || payload?.data?.routes || [];
    const routes = rawRoutes.map(normalizeRoute).filter(Boolean);
    return {
      routes,
      meta: payload?.meta && typeof payload.meta === "object" ? payload.meta : {},
    };
  }

  function normalizeRoute(rawRoute, routeIndex) {
    if (!rawRoute || typeof rawRoute !== "object") return null;

    const id = String(rawRoute.id ?? rawRoute.routeId ?? `route-${routeIndex + 1}`);
    const name = String(rawRoute.name ?? rawRoute.routeName ?? `线路 ${routeIndex + 1}`);
    const color = normalizeColor(rawRoute.color, routeIndex);
    const rawDirections = Array.isArray(rawRoute.directions) && rawRoute.directions.length
      ? rawRoute.directions
      : [{
          id: `${id}-direction-1`,
          name: rawRoute.direction || "线路方向",
          stops: rawRoute.stops || [],
          geometry: rawRoute.geometry,
          geometryStatus: rawRoute.geometryStatus,
        }];

    const directions = rawDirections.map((direction, directionIndex) =>
      normalizeDirection(direction, directionIndex, id, color),
    );

    inferMissingDirectionGeometry(directions);

    return { id, name, color, directions };
  }

  function normalizeDirection(rawDirection, directionIndex, routeId, routeColor) {
    const direction = rawDirection && typeof rawDirection === "object" ? rawDirection : {};
    const id = String(direction.id ?? `${routeId}-direction-${directionIndex + 1}`);
    const name = String(direction.name ?? direction.label ?? direction.direction ?? `方向 ${directionIndex + 1}`);
    const departureTime = cleanText(
      direction.departureTime
      ?? direction.time
      ?? direction.trips?.[0]?.departureTime,
    );
    const stops = (Array.isArray(direction.stops) ? direction.stops : [])
      .map((stop, stopIndex) => normalizeStop(stop, stopIndex, routeId, id));
    const geometry = normalizeGeometry(direction.geometry ?? direction.path);
    const tone = /下班/.test(name) || (!/上班/.test(name) && directionIndex % 2 === 1)
      ? "outbound"
      : "inbound";

    return {
      id,
      name,
      departureTime,
      geometry,
      geometryPending: isPendingGeometry(direction.geometryStatus),
      geometryInferred: false,
      tone,
      color: directionColor(routeColor, tone),
      stops,
    };
  }

  function inferMissingDirectionGeometry(directions) {
    const source = directions.find((direction) => direction.geometry.length >= 2);
    if (!source) return;

    directions.forEach((direction) => {
      if (direction.geometry.length >= 2 || direction.stops.length < 2) return;
      direction.geometry = [...source.geometry].reverse();
      direction.geometryPending = true;
      direction.geometryInferred = true;
    });
  }

  function normalizeStop(rawStop, stopIndex, routeId, directionId) {
    const stop = rawStop && typeof rawStop === "object" ? rawStop : { name: rawStop };
    const coordinatePair = Array.isArray(stop.coordinates) ? toLatLng(stop.coordinates) : null;
    const lat = toFiniteNumber(stop.lat ?? stop.latitude ?? coordinatePair?.[0]);
    const lng = toFiniteNumber(stop.lng ?? stop.lon ?? stop.longitude ?? coordinatePair?.[1]);
    const hasCoordinates = isValidCoordinate(lat, lng);
    const rawStatus = cleanText(stop.status ?? stop.coordinateStatus ?? stop.confidence);
    const status = !hasCoordinates
      ? "unresolved"
      : UNRESOLVED_WORDS.test(rawStatus)
        ? "unresolved"
        : CONFIRMED_WORDS.test(rawStatus) && !PENDING_WORDS.test(rawStatus)
          ? "confirmed"
          : "pending";
    const sequence = Number.isFinite(Number(stop.sequence)) ? Number(stop.sequence) : stopIndex + 1;
    const name = cleanText(stop.rawName ?? stop.name ?? stop.normalizedName ?? stop.stopName)
      || `站点 ${stopIndex + 1}`;
    const displayName = name;
    const geocoderLabel = cleanText(stop.displayName);
    const locationLabel = geocoderLabel && geocoderLabel !== name ? geocoderLabel : "";

    return {
      key: `${routeId}::${directionId}::${sequence}::${stopIndex}`,
      sequence,
      name,
      displayName,
      time: cleanText(stop.scheduledTime ?? stop.time ?? stop.arrivalTime ?? stop.departureTime),
      locationLabel,
      lat,
      lng,
      status,
      hasCoordinates,
    };
  }

  function normalizeGeometry(rawGeometry) {
    if (!rawGeometry) return [];
    const coordinates = Array.isArray(rawGeometry)
      ? rawGeometry
      : Array.isArray(rawGeometry.coordinates)
        ? rawGeometry.coordinates
        : [];

    return coordinates.map(toLatLng).filter(Boolean);
  }

  function toLatLng(value) {
    if (Array.isArray(value) && value.length >= 2) {
      const first = toFiniteNumber(value[0]);
      const second = toFiniteNumber(value[1]);
      if (first === null || second === null) return null;
      const pair = Math.abs(first) > 90 ? [second, first] : [first, second];
      return isValidCoordinate(pair[0], pair[1]) ? pair : null;
    }

    if (value && typeof value === "object") {
      const lat = toFiniteNumber(value.lat ?? value.latitude);
      const lng = toFiniteNumber(value.lng ?? value.lon ?? value.longitude);
      return isValidCoordinate(lat, lng) ? [lat, lng] : null;
    }

    return null;
  }

  function normalizeColor(value, index) {
    const color = typeof value === "string" ? value.trim() : "";
    if (/^#[0-9a-f]{6}$/i.test(color)) return color;
    return ROUTE_PALETTE[index % ROUTE_PALETTE.length];
  }

  function directionColor(baseColor, tone) {
    return tone === "outbound"
      ? mixHexColors(baseColor, "#ffffff", 0.4)
      : mixHexColors(baseColor, "#152235", 0.2);
  }

  function mixHexColors(source, target, amount) {
    const sourceValue = Number.parseInt(source.slice(1), 16);
    const targetValue = Number.parseInt(target.slice(1), 16);
    const mixChannel = (shift) => Math.round(
      ((sourceValue >> shift) & 255) * (1 - amount)
      + ((targetValue >> shift) & 255) * amount,
    );
    return `#${[16, 8, 0].map((shift) => mixChannel(shift).toString(16).padStart(2, "0")).join("")}`;
  }

  function cleanText(value) {
    return value === null || value === undefined ? "" : String(value).trim();
  }

  function toFiniteNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function isValidCoordinate(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  function isPendingGeometry(value) {
    const text = cleanText(value);
    if (!text) return false;
    if (PENDING_GEOMETRY_WORDS.test(text)) return true;
    if (CONFIRMED_GEOMETRY_WORDS.test(text)) return false;
    return true;
  }

  function renderRoutes() {
    state.routeLayers.clear();
    state.stopMarkers.clear();
    state.allBounds = window.L.latLngBounds([]);

    state.routes.forEach((route) => {
      const entry = {
        paths: [],
        markers: [],
        bounds: window.L.latLngBounds([]),
      };

      route.directions.forEach((direction) => {
        const validStops = direction.stops.filter((stop) => stop.hasCoordinates);
        const pathParts = getDirectionPathParts(direction);

        pathParts.forEach((part) => {
          const layers = createRoutePath(route, direction, part.latlngs, part.pending);
          entry.paths.push(...layers);
          part.latlngs.forEach((latlng) => entry.bounds.extend(latlng));
        });

        validStops.forEach((stop) => {
          const marker = createStopMarker(route, direction, stop);
          marker.addTo(state.map);
          entry.markers.push(marker);
          entry.bounds.extend([stop.lat, stop.lng]);
          state.stopMarkers.set(stop.key, marker);
        });
      });

      if (entry.bounds.isValid()) state.allBounds.extend(entry.bounds);
      state.routeLayers.set(route.id, entry);
    });
  }

  function getDirectionPathParts(direction) {
    if (direction.geometry.length >= 2) {
      const pending = direction.geometryPending || direction.stops.some((stop) => stop.status !== "confirmed");
      return [{ latlngs: direction.geometry, pending }];
    }

    const parts = [];
    let previous = null;
    direction.stops.forEach((stop) => {
      if (!stop.hasCoordinates) {
        previous = null;
        return;
      }

      if (previous) {
        parts.push({
          latlngs: [
            [previous.lat, previous.lng],
            [stop.lat, stop.lng],
          ],
          pending: previous.status !== "confirmed" || stop.status !== "confirmed",
        });
      }
      previous = stop;
    });
    return parts;
  }

  function createRoutePath(route, direction, latlngs, pending) {
    const casing = window.L.polyline(latlngs, {
      color: "#ffffff",
      weight: 8,
      opacity: 0.82,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
      className: "route-casing",
      pane: "routeCasingPane",
    }).addTo(state.map);

    const line = window.L.polyline(latlngs, {
      color: direction.color,
      weight: 4.5,
      opacity: 0.9,
      dashArray: pending ? "3 8" : direction.tone === "outbound" ? "14 8" : null,
      lineCap: "round",
      lineJoin: "round",
      className: "route-path",
      bubblingMouseEvents: false,
      pane: "routeLinePane",
    }).addTo(state.map);

    line.on("click", () => selectRoute(route.id, direction.id));
    const geometryNote = direction.geometryInferred ? " · 反向线路推断" : "";
    line.bindTooltip(`${route.name} · ${direction.name}${geometryNote}`, {
      sticky: true,
      direction: "top",
      opacity: 0.94,
    });

    return [
      { kind: "casing", layer: casing, directionId: direction.id, latlngs, pending },
      { kind: "line", layer: line, directionId: direction.id, latlngs, pending },
    ];
  }

  function createStopMarker(route, direction, stop) {
    const markerClass = stop.status === "confirmed" ? "" : " is-pending";
    const icon = window.L.divIcon({
      className: "route-stop-icon",
      html: `<span class="stop-marker${markerClass}" style="--route-color:${direction.color}"></span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
      popupAnchor: [0, -8],
    });

    const marker = window.L.marker([stop.lat, stop.lng], {
      icon,
      title: stop.displayName,
      keyboard: true,
      riseOnHover: true,
    });

    marker.bindPopup(createStopPopup(route, direction, stop), {
      closeButton: true,
      maxWidth: 260,
    });
    marker.on("click", () => selectRoute(route.id, direction.id, false));
    marker.on("add", () => syncMarkerVisualState(marker));
    marker.routeId = route.id;
    marker.directionId = direction.id;
    marker.stopKey = stop.key;
    return marker;
  }

  function createStopPopup(route, direction, stop) {
    const popup = document.createElement("div");
    popup.className = "stop-popup";

    const name = document.createElement("strong");
    name.textContent = stop.displayName;
    popup.appendChild(name);

    const routeName = document.createElement("span");
    routeName.className = "stop-popup-route";
    routeName.textContent = route.name;
    popup.appendChild(routeName);

    if (stop.locationLabel) {
      const location = document.createElement("span");
      location.className = "stop-popup-location";
      location.textContent = stop.locationLabel;
      popup.appendChild(location);
    }

    const details = document.createElement("dl");
    details.className = "stop-popup-grid";
    appendDefinition(details, "方向", direction.name);
    appendDefinition(details, "时间", stop.time || direction.departureTime || "未提供");
    popup.appendChild(details);

    if (stop.status !== "confirmed") {
      const status = document.createElement("span");
      status.className = "stop-popup-status";
      status.textContent = "坐标待确认";
      popup.appendChild(status);
    }

    return popup;
  }

  function appendDefinition(list, termText, detailText) {
    const term = document.createElement("dt");
    const detail = document.createElement("dd");
    term.textContent = termText;
    detail.textContent = detailText;
    list.append(term, detail);
  }

  function selectRoute(routeId, directionId, fit = true) {
    const route = getRoute(routeId);
    if (!route) return;

    state.selectedRouteId = route.id;
    state.selectedDirectionId = directionId || route.directions[0]?.id || null;
    updateMapSelection();
    renderRouteList();
    updatePanelHeading();

    if (fit) fitRoute(route.id, state.selectedDirectionId);
    if (isMobile()) setDrawerOpen(false);
  }

  function selectDirection(routeId, directionId) {
    state.selectedRouteId = routeId;
    state.selectedDirectionId = directionId;
    updateMapSelection();
    renderRouteList();
    updatePanelHeading();
    fitRoute(routeId, directionId);
    if (isMobile()) setDrawerOpen(false);
  }

  function clearSelection() {
    state.selectedRouteId = null;
    state.selectedDirectionId = null;
    updateMapSelection();
    renderRouteList();
    updatePanelHeading();
    fitAllRoutes(true);
  }

  function updateMapSelection() {
    state.routeLayers.forEach((entry, routeId) => {
      const selected = routeId === state.selectedRouteId;
      const muted = Boolean(state.selectedRouteId) && !selected;

      entry.paths.forEach((path) => {
        const selectedDirection = selected && path.directionId === state.selectedDirectionId;
        if (path.kind === "casing") {
          path.layer.setStyle({
            weight: selectedDirection ? 11 : selected ? 8 : muted ? 6 : 8,
            opacity: selectedDirection ? 0.94 : selected ? 0.64 : muted ? 0.28 : 0.82,
          });
        } else {
          path.layer.setStyle({
            weight: selectedDirection ? 7 : selected ? 5 : muted ? 3.5 : 4.5,
            opacity: selectedDirection ? 1 : selected ? 0.62 : muted ? 0.3 : 0.9,
          });
        }
        if (selected) path.layer.bringToFront();
      });

      entry.markers.forEach((marker) => {
        syncMarkerVisualState(marker);
      });
    });

    drawDirectionFlow();
  }

  function syncMarkerVisualState(marker) {
    const selectedRoute = marker.routeId === state.selectedRouteId;
    const selectedDirection = selectedRoute && marker.directionId === state.selectedDirectionId;
    const mutedRoute = Boolean(state.selectedRouteId) && !selectedRoute;
    const mutedDirection = selectedRoute && Boolean(state.selectedDirectionId) && !selectedDirection;
    const muted = mutedRoute || mutedDirection;
    marker.setOpacity(mutedDirection ? 0.5 : mutedRoute ? 0.35 : 1);
    marker.setZIndexOffset(selectedDirection ? 1000 : muted ? -100 : 0);
    const icon = marker.getElement();
    icon?.classList.toggle("is-selected", selectedDirection);
    icon?.classList.toggle("is-muted", muted);
  }

  function drawDirectionFlow() {
    if (state.flowGroup) {
      state.flowGroup.remove();
      state.flowGroup = null;
    }
    if (!state.selectedRouteId || !state.selectedDirectionId) return;

    const entry = state.routeLayers.get(state.selectedRouteId);
    if (!entry) return;
    state.flowGroup = window.L.layerGroup().addTo(state.map);

    entry.paths
      .filter((path) => path.kind === "line" && path.directionId === state.selectedDirectionId)
      .forEach((path) => {
        window.L.polyline(path.latlngs, {
          color: "#ffffff",
          weight: 2.4,
          opacity: 0.9,
          dashArray: "1 13",
          dashOffset: "0",
          lineCap: "round",
          interactive: false,
          className: "route-flow",
          pane: "routeFlowPane",
        }).addTo(state.flowGroup);
      });
  }

  function fitRoute(routeId, directionId) {
    const entry = state.routeLayers.get(routeId);
    if (!entry?.bounds?.isValid()) return;

    const directionBounds = window.L.latLngBounds([]);
    entry.paths
      .filter((path) => path.directionId === directionId)
      .forEach((path) => path.latlngs.forEach((latlng) => directionBounds.extend(latlng)));

    const bounds = directionBounds.isValid() ? directionBounds : entry.bounds;
    state.map.fitBounds(bounds, {
      padding: [34, 34],
      maxZoom: 14,
      animate: !state.reducedMotion,
      duration: 0.55,
    });
  }

  function fitAllRoutes(animate) {
    const bounds = state.allBounds?.isValid()
      ? state.allBounds
      : window.L.latLngBounds(FALLBACK_BOUNDS);
    state.map?.fitBounds(bounds, {
      padding: [28, 28],
      maxZoom: 13,
      animate: animate && !state.reducedMotion,
      duration: 0.55,
    });
  }

  function openStop(stopKey) {
    const marker = state.stopMarkers.get(stopKey);
    if (!marker) return;

    selectRoute(marker.routeId, marker.directionId, false);
    const targetZoom = Math.max(state.map.getZoom(), 14);
    state.map.flyTo(marker.getLatLng(), targetZoom, {
      animate: !state.reducedMotion,
      duration: 0.45,
    });
    window.setTimeout(() => marker.openPopup(), state.reducedMotion ? 0 : 320);
    if (isMobile()) setDrawerOpen(false);
  }

  function renderRouteList() {
    const previousScrollTop = elements.panelBody.scrollTop;
    elements.routeList.replaceChildren();

    if (!state.routes.length) {
      renderListMessage("暂无线路数据。", false);
      return;
    }

    state.routes.forEach((route, routeIndex) => {
      const item = document.createElement("li");
      const selected = route.id === state.selectedRouteId;
      const detailsId = `route-details-${routeIndex}`;
      const stopCount = route.directions.reduce((sum, direction) => sum + direction.stops.length, 0);
      const pendingCount = route.directions.reduce(
        (sum, direction) => sum + direction.stops.filter((stop) => stop.status !== "confirmed").length,
        0,
      );
      item.className = `route-item${selected ? " is-selected" : ""}`;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "route-select";
      button.dataset.action = "select-route";
      button.dataset.routeId = route.id;
      button.setAttribute("aria-expanded", String(selected));
      button.setAttribute("aria-controls", detailsId);

      const swatch = document.createElement("span");
      swatch.className = "route-swatch";
      swatch.style.setProperty("--route-inbound-color", route.directions[0]?.color || route.color);
      swatch.style.setProperty("--route-outbound-color", route.directions[1]?.color || route.directions[0]?.color || route.color);
      swatch.setAttribute("aria-hidden", "true");

      const copy = document.createElement("span");
      copy.className = "route-copy";
      const name = document.createElement("span");
      name.className = "route-name";
      name.textContent = route.name;
      const meta = document.createElement("span");
      meta.className = "route-meta";
      meta.textContent = `${route.directions.length} 个方向 · ${stopCount} 站次`;
      copy.append(name, meta);
      button.append(swatch, copy);

      if (pendingCount > 0) {
        const alert = document.createElement("span");
        alert.className = "route-alert";
        alert.textContent = `${pendingCount} 待确认`;
        button.appendChild(alert);
      }

      item.appendChild(button);
      if (selected) item.appendChild(renderRouteDetails(route, detailsId));
      elements.routeList.appendChild(item);
    });

    elements.panelBody.scrollTop = previousScrollTop;
    const selectedItem = elements.routeList.querySelector(".route-item.is-selected");
    selectedItem?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }

  function renderRouteDetails(route, detailsId) {
    const details = document.createElement("div");
    details.className = "route-details";
    details.id = detailsId;

    const tabs = document.createElement("div");
    tabs.className = "direction-tabs";
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", `${route.name}方向`);

    route.directions.forEach((direction) => {
      const tab = document.createElement("button");
      const selected = direction.id === state.selectedDirectionId;
      tab.type = "button";
      tab.className = "direction-tab";
      tab.dataset.action = "select-direction";
      tab.dataset.routeId = route.id;
      tab.dataset.directionId = direction.id;
      tab.setAttribute("aria-pressed", String(selected));
      tab.style.setProperty("--direction-color", direction.color);
      tab.classList.toggle("is-outbound", direction.tone === "outbound");
      const swatch = document.createElement("span");
      swatch.className = "direction-tab-swatch";
      swatch.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = direction.name;
      tab.append(swatch, label);
      tabs.appendChild(tab);
    });
    details.appendChild(tabs);

    const direction = route.directions.find((item) => item.id === state.selectedDirectionId)
      || route.directions[0];
    if (!direction) return details;

    const stopList = document.createElement("ol");
    stopList.className = "stop-list";
    direction.stops.forEach((stop) => {
      const listItem = document.createElement("li");
      const row = document.createElement(stop.hasCoordinates ? "button" : "div");
      row.className = "stop-row";
      if (stop.hasCoordinates) {
        row.type = "button";
        row.dataset.action = "select-stop";
        row.dataset.stopKey = stop.key;
        row.setAttribute("aria-label", `在地图中查看${stop.displayName}`);
      }

      const node = document.createElement("span");
      node.className = `stop-node${stop.status === "pending" ? " is-pending" : ""}${stop.status === "unresolved" ? " is-unresolved" : ""}`;
      node.style.setProperty("--route-color", direction.color);
      node.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "stop-name";
      name.textContent = stop.displayName;
      const time = document.createElement("span");
      time.className = "stop-time";
      time.textContent = stop.hasCoordinates ? (stop.time || "--:--") : "无坐标";
      row.append(node, name, time);
      listItem.appendChild(row);
      stopList.appendChild(listItem);
    });
    details.appendChild(stopList);
    return details;
  }

  function renderListMessage(message, isError) {
    elements.routeList.replaceChildren();
    const item = document.createElement("li");
    item.className = "route-empty";
    if (isError) item.setAttribute("role", "alert");
    item.textContent = message;
    elements.routeList.appendChild(item);
  }

  function updateMetrics() {
    const uniqueStops = new Set();
    state.routes.forEach((route) => {
      route.directions.forEach((direction) => {
        direction.stops.forEach((stop) => uniqueStops.add(stop.name.toLocaleLowerCase("zh-CN")));
      });
    });

    const routeCount = numericMeta("routeCount") ?? state.routes.length;
    const stopCount = numericMeta("uniqueStopCount") ?? uniqueStops.size;
    elements.routeCount.textContent = String(routeCount);
    elements.stopCount.textContent = String(stopCount);
    updatePanelHeading();
  }

  function updatePanelHeading() {
    const selectedRoute = getRoute(state.selectedRouteId);
    updateDirectionLegend(selectedRoute || state.routes[0]);
    if (selectedRoute) {
      elements.panelTitle.textContent = selectedRoute.name;
      elements.panelSummary.textContent = "已选择 · 展开可查看方向与站点";
      return;
    }

    elements.panelTitle.textContent = "班车线路";
    const resolved = Number(state.meta?.geocoding?.resolved);
    const total = Number(state.meta?.geocoding?.total);
    elements.panelSummary.textContent = Number.isFinite(resolved) && Number.isFinite(total)
      ? `${state.routes.length} 条线路 · ${resolved}/${total} 站点已定位`
      : `${state.routes.length} 条线路 · ${elements.stopCount.textContent} 个站点`;
  }

  function updateDirectionLegend(route) {
    if (!route) return;
    const inbound = route.directions.find((direction) => direction.tone === "inbound") || route.directions[0];
    const outbound = route.directions.find((direction) => direction.tone === "outbound") || route.directions[1] || inbound;
    elements.inboundLegend?.style.setProperty("--legend-color", inbound?.color || route.color);
    elements.outboundLegend?.style.setProperty("--legend-color", outbound?.color || route.color);
  }

  function numericMeta(key) {
    const value = Number(state.meta?.[key]);
    return Number.isFinite(value) ? value : null;
  }

  function getRoute(routeId) {
    return state.routes.find((route) => route.id === routeId);
  }

  function setDrawerOpen(open) {
    document.body.classList.toggle("drawer-open", open);
    elements.drawerToggle.setAttribute("aria-expanded", String(open));
    elements.drawerToggle.setAttribute("aria-label", open ? "收起线路列表" : "展开线路列表");
  }

  function isMobile() {
    return window.matchMedia("(max-width: 760px)").matches;
  }

  function hideMapStatus() {
    elements.mapStatus.classList.add("is-hidden");
    elements.mapStatus.classList.remove("is-error");
  }

  function showFatal(title, message, allowRetry = true) {
    elements.mapStatus.classList.remove("is-hidden");
    elements.mapStatus.classList.add("is-error");
    elements.mapStatus.replaceChildren();

    const wrapper = document.createElement("div");
    wrapper.className = "status-copy";
    const indicator = document.createElement("span");
    indicator.className = "loading-ring";
    indicator.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    const heading = document.createElement("strong");
    const detail = document.createElement("span");
    heading.textContent = title;
    detail.textContent = message;
    copy.append(heading, detail);

    if (allowRetry) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "status-retry";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => window.location.reload());
      copy.appendChild(retry);
    }

    wrapper.append(indicator, copy);
    elements.mapStatus.appendChild(wrapper);
    elements.mapStatus.setAttribute("role", "alert");
  }

  function showMapNotice(message) {
    elements.mapNoticeText.textContent = message;
    elements.mapNotice.hidden = false;
  }

  function hideMapNotice() {
    elements.mapNotice.hidden = true;
  }
})();
