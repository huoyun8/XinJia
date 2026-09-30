const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS"]
}));
app.use(express.json({ limit: "10kb" }));

const CONFIG = {
  api1Url: "https://tracking.nextsls.com/rest/trace/tracking/lists?app=656d92f573f0427e8e5ca536&number=",
  api2Url: "https://tracking.nextsls.com/rest/trace/tracking/lists?app=67204e5c73f04246486924cb&number=",
  fetchTimeout: 7000,
  api3: {
    clientCode: "20260928",
    apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
    targetUrl: "http://182.254.162.146/api/track",
    types: ["waybillnumber", "systemnumber", "customernumber"],
    timeoutMs: 8000
  }
};

// 国家码映射
const COUNTRY_MAP = {
  "AT": "奥地利","BE": "比利时","BG": "保加利亚","HR": "克罗地亚","CY": "塞浦路斯",
  "CZ": "捷克","DK": "丹麦","EE": "爱沙尼亚","FI": "芬兰","FR": "法国",
  "DE": "德国","GR": "希腊","HU": "匈牙利","IE": "爱尔兰","IT": "意大利",
  "LV": "拉脱维亚","LT": "立陶宛","LU": "卢森堡","MT": "马耳他","NL": "荷兰",
  "PL": "波兰","PT": "葡萄牙","RO": "罗马尼亚","SK": "斯洛伐克","SI": "斯洛文尼亚",
  "ES": "西班牙","SE": "瑞典","US": "美国"
};

// 标准化包装 nextsls 1/2渠道
function formatOldShipment(rawShip, inputNo) {
  const trackList = Array.isArray(rawShip.traces) ? rawShip.traces.map(t => ({
    time: t.time || "",
    info: t.info || "",
    location: t.location || ""
  })) : [];
  return {
    queryNo: inputNo,
    transNo: rawShip.outer_carrier_tracking_number || "",
    country: rawShip.country ? (COUNTRY_MAP[rawShip.country.toUpperCase()] || rawShip.country) : "",
    parcelCount: rawShip.parcel_count ?? null,
    status: rawShip.status === "delivered" ? "已签收" : "运输中",
    trackList
  };
}

// 标准化包装 api3内网渠道
function formatApi3Ship(rawShip, inputNo) {
  const trackList = Array.isArray(rawShip.trackItems) ? rawShip.trackItems.map(t => ({
    time: t.trackdate || "",
    info: t.info || "",
    location: t.location || ""
  })) : [];
  const cc = (rawShip.countrycode || "").toUpperCase();
  const country = COUNTRY_MAP[cc] || rawShip.countrycode || "";
  const status = (rawShip.orderstatus === "Sign" || rawShip.orderstatusName === "已签收") ? "已签收" : "运输中";
  return {
    queryNo: inputNo,
    transNo: rawShip.tracknumber || "",
    country,
    parcelCount: null,
    status,
    trackList
  };
}

app.options("/", (req, res) => res.sendStatus(200));

app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    console.log("【查询单号】", inputNo);

    // 参数校验
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空", data: [] });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查", data: [] });

    // 1. 查询接口1
    let hitData = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json.status === 1 && Array.isArray(json.data?.shipment) && json.data.shipment.length > 0) {
          hitData = json.data.shipment.map(item => formatOldShipment(item, inputNo));
          console.log("✅ 命中接口1");
        }
      }
    } catch (e) {
      console.log("⚠️ 接口1异常跳过", e.message);
    }
    if (hitData) return res.json({ code: 0, msg: "", data: hitData });

    // 2. 查询接口2
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json.status === 1 && Array.isArray(json.data?.shipment) && json.data.shipment.length > 0) {
          hitData = json.data.shipment.map(item => formatOldShipment(item, inputNo));
          console.log("✅ 命中接口2");
        }
      }
    } catch (e) {
      console.log("⚠️ 接口2异常跳过", e.message);
    }
    if (hitData) return res.json({ code: 0, msg: "", data: hitData });

    // 3. 查询接口3 循环类型
    console.log("ℹ️ 1/2无运单，进入接口3");
    const api3Cfg = CONFIG.api3;
    for (const type of api3Cfg.types) {
      try {
        const body = { authorization: { code: api3Cfg.clientCode, token: api3Cfg.apiToken }, datas: { [type]: [inputNo] } };
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), api3Cfg.timeoutMs);
        const resp = await fetch(api3Cfg.targetUrl, {
          method: "POST",
          signal: ctrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP${resp.status}`);
        const json = await resp.json();
        if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0 && !json.data[0].errormsg) {
          hitData = json.data.map(item => formatApi3Ship(item, inputNo));
          console.log(`✅ 接口3-${type}命中`);
          break;
        }
      } catch (e) {
        console.log(`⚠️ 接口3-${type}异常`, e.message);
        continue;
      }
    }
    if (hitData) return res.json({ code: 0, msg: "", data: hitData });

    // 全部渠道无匹配
    return res.json({ code: 3, msg: "单号错误，请核对", data: [] });
  } catch (globalErr) {
    console.error("❌ 全局服务异常", globalErr);
    const msg = globalErr.name === "AbortError" ? "上游接口请求超时" : "中转服务异常";
    return res.json({ code: -99, msg, data: [] });
  }
});

app.get("/", (req, res) => res.send("统一标准化中转服务：1/2/3后端封装统一输出，前端只读标准data数组"));
app.all("/", (req, res) => res.json({ code: -1, msg: "仅支持POST查询", data: [] }));
app.listen(PORT, () => console.log("服务启动完成"));
