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

// 渠道配置
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

/**
 * 格式化渠道1、渠道2 nextsls 数据
 * @param {object} raw 原始shipment单条
 * @param {string} inputNo 用户输入查询单号
 * @returns 统一标准结构
 */
function formatOldShipment(raw, inputNo) {
  const trackList = Array.isArray(raw.traces)
    ? raw.traces.map(item => ({
        time: item.time || "",
        info: item.info || "",
        location: item.location || ""
      }))
    : [];

  return {
    queryNo: inputNo,
    transNo: raw.outer_carrier_tracking_number || "",
    country: raw.country ? (COUNTRY_MAP[raw.country.toUpperCase()] || raw.country) : "",
    parcelCount: raw.parcel_count ?? null,
    status: raw.status === "delivered" ? "已签收" : "运输中",
    trackList
  };
}

/**
 * 格式化渠道3内网接口数据
 * @param {object} raw api3单条运单
 * @param {string} inputNo 用户输入查询单号
 * @returns 统一标准结构
 */
function formatApi3Ship(raw, inputNo) {
  const trackList = Array.isArray(raw.trackItems)
    ? raw.trackItems.map(item => ({
        time: item.trackdate || "",
        info: item.info || "",
        location: item.location || ""
      }))
    : [];

  const countryCode = (raw.countrycode || "").toUpperCase();
  const countryText = COUNTRY_MAP[countryCode] || raw.countrycode || "";
  const isSign = raw.orderstatus === "Sign" || raw.orderstatusName === "已签收";

  return {
    queryNo: inputNo,
    transNo: raw.tracknumber || "",
    country: countryText,
    parcelCount: null,
    status: isSign ? "已签收" : "运输中",
    trackList
  };
}

// OPTIONS预检跨域
app.options("/", (req, res) => res.sendStatus(200));

app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    console.log("【查询单号】", inputNo);

    // 参数校验
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空", data: [] });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查", data: [] });

    let standardResult = null;

    // 1. 优先查询接口1（增强异常捕获，分层容错）
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), {
        signal: abortCtrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 Node-Fetch Service" }
      });
      clearTimeout(timer);
      // 非200状态码直接抛出跳过
      if (!resp.ok) throw new Error(`API1 HTTP ${resp.status}`);
      const json = await resp.json();
      // 严格判断数据结构存在
      if (json && json.status === 1 && json.data && Array.isArray(json.data.shipment) && json.data.shipment.length > 0) {
        standardResult = json.data.shipment.map(item => formatOldShipment(item, inputNo));
        console.log("✅ 命中渠道1，已标准化包装");
      }
    } catch (e) {
      console.log("⚠️ 渠道1请求异常，自动跳过：", e.message);
    }
    if (standardResult) return res.json({ code: 0, msg: "", data: standardResult });

    // 2. 查询接口2（同容错增强）
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), {
        signal: abortCtrl.signal,
        headers: { "User-Agent": "Mozilla/5.0 Node-Fetch Service" }
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`API2 HTTP ${resp.status}`);
      const json = await resp.json();
      if (json && json.status === 1 && json.data && Array.isArray(json.data.shipment) && json.data.shipment.length > 0) {
        standardResult = json.data.shipment.map(item => formatOldShipment(item, inputNo));
        console.log("✅ 命中渠道2，已标准化包装");
      }
    } catch (e) {
      console.log("⚠️ 渠道2请求异常，自动跳过：", e.message);
    }
    if (standardResult) return res.json({ code: 0, msg: "", data: standardResult });

    // 3. 查询接口3 循环类型（增加请求头、状态容错、JSON解析捕获）
    console.log("ℹ️ 1/2无运单，进入接口3");
    const api3Cfg = CONFIG.api3;
    for (const type of api3Cfg.types) {
      try {
        const postBody = {
          authorization: { code: api3Cfg.clientCode, token: api3Cfg.apiToken },
          datas: { [type]: [inputNo] }
        };
        const abortCtrl = new AbortController();
        const timer = setTimeout(() => abortCtrl.abort(), api3Cfg.timeoutMs);
        const resp = await fetch(api3Cfg.targetUrl, {
          method: "POST",
          signal: abortCtrl.signal,
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 Node-Fetch Service"
          },
          body: JSON.stringify(postBody)
        });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`API3 ${type} HTTP ${resp.status}`);
        // 单独捕获JSON解析失败
        let json;
        try {
          json = await resp.json();
        } catch (parseErr) {
          throw new Error(`JSON解析失败: ${parseErr.message}`);
        }
        if (json.code === 0 && Array.isArray(json.data) && json.data.length > 0 && !json.data[0].errormsg) {
          standardResult = json.data.map(item => formatApi3Ship(item, inputNo));
          console.log(`✅ 接口3 ${type} 命中`);
          break;
        }
      } catch (e) {
        console.log(`⚠️ 接口3 ${type} 异常，切换下一类查询：`, e.message);
        continue;
      }
    }
    if (standardResult) return res.json({ code: 0, msg: "", data: standardResult });

    // 全部渠道无匹配
    return res.json({ code: 3, msg: "单号错误，请核对", data: [] });
  } catch (globalErr) {
    console.error("❌ 全局服务异常", globalErr);
    const msg = globalErr.name === "AbortError" ? "上游接口请求超时" : "中转服务异常";
    return res.json({ code: -99, msg, data: [] });
  }
});

app.get("/", (req, res) => res.send("标准化统一中转服务 | 1→2→3串行查询，输出统一结构"));
app.all("/", (req, res) => res.json({ code: -1, msg: "仅支持POST查询", data: [] }));
app.listen(PORT, () => console.log("服务启动完成"));
