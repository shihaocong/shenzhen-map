# 深圳园区班车路线地图

一个无需地图 Key 的静态路线可视化页面。页面使用 Leaflet 渲染交互图层，并以 CARTO Positron（基于 OpenStreetMap 数据）作为真实地理底图。

当前数据来自 `深圳园区班车线路表26-3-30.xlsx`：23 条命名线路、43 个有站点的方向、111 个清洗合并后的唯一站点。111 个站点均已定位，43 个方向均已生成完整道路几何；其中 39 个缺失坐标由人工提供的高德 GCJ-02 坐标转换为 WGS84。

## 本地运行

需要通过 HTTP 服务器打开页面，直接双击 `index.html` 会使浏览器阻止读取 JSON 数据。

```bash
python3 -m http.server 8000
```

然后访问 `http://localhost:8000`。

页面本身无需构建和安装依赖，但首次加载需要联网获取 Leaflet 资源和 CARTO 地图瓦片。

## 数据文件

页面读取 `data/routes.json`，核心结构如下：

```json
{
  "meta": {
    "routeCount": 2,
    "uniqueStopCount": 12
  },
  "routes": [
    {
      "id": "route-1",
      "name": "线路名称",
      "color": "#0072b2",
      "directions": [
        {
          "id": "route-1-outbound",
          "name": "去程",
          "departureTime": "07:30",
          "geometry": {
            "type": "LineString",
            "coordinates": [[114.05, 22.55], [114.1, 22.6]]
          },
          "geometryStatus": "approximate",
          "stops": [
            {
              "sequence": 1,
              "name": "站点名称",
              "time": "07:30",
              "lat": 22.55,
              "lng": 114.05,
              "status": "approximate"
            }
          ]
        }
      ]
    }
  ]
}
```

`geometry.coordinates` 使用 GeoJSON 顺序 `[经度, 纬度]`。站点 `status` 建议使用 `confirmed`、`approximate` 或 `unresolved`；待确认坐标会在地图中显示为虚线路段和菱形站点。

## 重新构建数据

解析工作簿但不联网：

```bash
node scripts/build-route-data.mjs --parse-only
```

重新执行地理编码与道路规划需要联网，并会复用 `data/geocode-cache.json` 与 `data/osrm-cache.json` 中已有的可靠结果：

```bash
node scripts/build-route-data.mjs
```

人工核验坐标保存在 `data/manual-geocodes.json`。当原始工作簿暂时不可用时，可以基于已解析数据重新生成路线：

```bash
node scripts/build-route-data.mjs --existing-data
```
