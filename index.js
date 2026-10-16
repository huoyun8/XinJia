const CONFIG = {
  host: "182.254.162.146",
  port: 80,
  timeoutMs: 8000,
  host101: "101.132.169.116",
  path101: "/public/v1/ordeSearch/trackInfoList"
};
const NEXTSLS = ["656d92f573f0427e8e5ca536", "67204e5c73f04246486924cb"];
const NEXTSLS_URL = "https://tracking.nextsls.com/rest/trace/tracking/lists";
const COUNTRY_NAMES = {
  AT:"奥地利",BE:"比利时",BG:"保加利亚",HR:"克罗地亚",CY:"塞浦路斯",
  CZ:"捷克",DK:"丹麦",EE:"爱沙尼亚",FI:"芬兰",FR:"法国",
  DE:"德国",GR:"希腊",HU:"匈牙利",IE:"爱尔兰",IT:"意大利",
  LV:"拉脱维亚",LT:"立陶宛",LU:"卢森堡",MT:"马耳他",NL:"荷兰",
  PL:"波兰",PT:"葡萄牙",RO:"罗马尼亚",SK:"斯洛伐克",SI:"斯洛文尼亚",
  ES:"西班牙",SE:"瑞典",US:"美国"
};
const SIGN_RE = /(已签收|签收成功|已妥投|妥投|已送达|送达|派送完成|delivered|Delivered|SIGNING_SUCCESS)/;

const hasFetch = typeof fetch === "function";
function httpRequest(host, port, path, method, bodyStr, contentType, timeout) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options = {
      hostname: host, port: port, path, method,
      headers: { "Content-Type": contentType, "Content-Length": Buffer.byteLength(bodyStr || "") }
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("上游接口请求超时")));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
async function postForm(path, params) {
  const bodyStr = new URLSearchParams(params).toString();
  if (hasFetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    try {
      const raw = await fetch("http://" + CONFIG.host + path, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: bodyStr });
      const text = await raw.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) {}
      return { text, json };
    } finally { clearTimeout(timer); }
  }
  const text = await httpRequest(CONFIG.host, CONFIG.port, path, "POST", bodyStr, "application/x-www-form-urlencoded", CONFIG.timeoutMs);
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { text, json };
}
function getJsonUrl(url, timeout) {
  if (hasFetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, { method: "GET", signal: controller.signal }).then(r => r.json()).finally(() => clearTimeout(timer));
  }
  const u = new URL(url);
  const mod = u.protocol === "https:" ? require("https") : require("http");
  return new Promise((resolve, reject) => {
    const req = mod.get(url, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); } });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("上游接口请求超时")));
  });
}
async function getJson101(inputNo) {
  return getJsonUrl("http://" + CONFIG.host101 + CONFIG.path101 + "?number=" + encodeURIComponent(inputNo), CONFIG.timeoutMs);
}
async function getJsonNextsls(appId, inputNo) {
  return getJsonUrl(NEXTSLS_URL + "?app=" + appId + "&number=" + encodeURIComponent(inputNo), CONFIG.timeoutMs);
}

function parseTrackItemHtml(html) {
  const traces = [];
  const re = /<span class="trackdate"[^>]*>([^<]+)<\/span>\s*<span class="trackinfo">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    traces.push({ time: (m[1] || "").trim(), info: (m[2] || "").replace(/\s+$/, "").replace(/\n+/g, " ").trim(), location: "" });
  }
  return traces;
}
function dedupTraces(list) {
  const out = [], seen = new Set();
  (list || []).forEach(t => {
    const key = (t.time || "") + "|" + (t.info || "");
    if (!seen.has(key)) { seen.add(key); out.push(t); }
  });
  return out.sort((a, b) => new Date(b.time) - new Date(a.time));
}
function normScfFallback(tlRec, traces, inputNo) {
  const country = COUNTRY_NAMES[(tlRec.countrycode || "").toUpperCase()] || tlRec.countryname || tlRec.countrycode || "";
  const delivered = traces.some(t => SIGN_RE.test(t.info || ""))
    || (tlRec.outinfo && SIGN_RE.test(tlRec.outinfo));
  return {
    code: 0, msg: "查询成功", channel: 3,
    data: {
      inputNo,
      carrier: "",
      transNo: tlRec.tracknumber || tlRec.waybillnumber || "",
      country,
      postcode: (tlRec.zipcode || "").match(/^\d+/)?.[0] || "",
      status: delivered ? "delivered" : "transit",
      statusText: delivered ? "已签收" : "运输中",
      parcelCount: (tlRec.number !== undefined && tlRec.number !== null) ? tlRec.number : null,
      traces,
      subOrders: []
    }
  };
}
function norm101(item, inputNo) {
  let traces = [];
  if (Array.isArray(item.trackEventsList) && item.trackEventsList.length) {
    traces = item.trackEventsList.map(t => ({ time: t.createTime || "", info: t.description || "", location: "" }));
  } else if (item.boxTrackInfoListMap) {
    for (const k in item.boxTrackInfoListMap) {
      const arr = item.boxTrackInfoListMap[k];
      if (Array.isArray(arr)) arr.forEach(t => traces.push({ time: t.createTime || "", info: t.description || "", location: "" }));
    }
  }
  traces = dedupTraces(traces);
  const statusTxt = (item.trackingStatus || item.statusValue || "").trim();
  const delivered = SIGN_RE.test(statusTxt) || traces.some(t => SIGN_RE.test(t.info || ""));
  const boxN = item.boxTrackInfoListMap ? Object.keys(item.boxTrackInfoListMap).length : 0;
  return {
    code: 0, msg: "查询成功", channel: 101,
    data: {
      inputNo,
      carrier: item.deliveryCompany || "",
      transNo: item.orderNo || "",
      country: item.country || "",
      postcode: (item.postCode || "").match(/^\d+/)?.[0] || "",
      status: delivered ? "delivered" : "transit",
      statusText: delivered ? "已签收" : (statusTxt || "运输中"),
      parcelCount: boxN > 0 ? boxN : null,
      traces,
      subOrders: []
    }
  };
}
function normNextsls(s, inputNo) {
  const delivered = s.status === "delivered" || (s.traces || []).some(t => SIGN_RE.test(t.info || ""));
  return {
    code: 0, msg: "查询成功", channel: 1,
    data: {
      inputNo,
      carrier: "",
      transNo: s.outer_carrier_tracking_number || "",
      country: s.country || "",
      postcode: s.postcode || "",
      status: delivered ? "delivered" : "transit",
      statusText: delivered ? "已签收" : "运输中",
      parcelCount: (s.parcel_count || s.parcel_count === 0) ? s.parcel_count : null,
      traces: dedupTraces((s.traces || []).map(t => ({ time: t.time || "", info: t.info || "", location: t.location || "" }))),
      subOrders: []
    }
  };
}
async function queryTrack3(inputNo) {
  const tl = await postForm("/trackList", { "searchList.waybillnumber": inputNo, searchLang: "zh" });
  if (!tl.json || tl.json.code !== 0 || !Array.isArray(tl.json.data) || !tl.json.data.length || tl.json.data[0].errormsg) {
    return { code: 1, msg: "3号渠道未匹配到运单", data: null };
  }
  const tlRec = tl.json.data[0];
  let traces = [];
  if (tlRec.pkid && tlRec.waybillnumber) {
    try {
      const r2 = await postForm("/trackItem", { orderpkid: tlRec.pkid, waybillnumber: tlRec.waybillnumber, searchLang: "zh" });
      traces = r2.text ? parseTrackItemHtml(r2.text) : [];
    } catch (e) { traces = []; }
  }
  if (!traces.length && tlRec.outinfo) {
    traces = [{ time: tlRec.outdate || "", info: tlRec.outinfo || "", location: tlRec.outdesc || "" }];
  }
  return normScfFallback(tlRec, traces, inputNo);
}
async function queryTrack101(inputNo) {
  const json = await getJson101(inputNo);
  if (!json || !json.flag || !Array.isArray(json.rows) || !json.rows.length) {
    return { code: 1, msg: (json && json.msg) || "101渠道未匹配到运单", data: null };
  }
  return norm101(json.rows[0], inputNo);
}
async function queryNextsls(appId, inputNo) {
  const json = await getJsonNextsls(appId, inputNo);
  if (!json || json.status !== 1 || !json.data || !json.data.shipment) {
    return { code: 1, msg: (json && json.info) || "nextsls未匹配到运单", data: null };
  }
  return normNextsls(json.data.shipment, inputNo);
}
async function queryTrack(inputNoRaw) {
  try {
    const inputNo = (inputNoRaw || "").trim().toUpperCase();
    if (!inputNo) return { code: -2, msg: "运单号不能为空", data: null };
    if (inputNo.length < 5 || inputNo.length > 18) return { code: -2, msg: "单号长度需5-18位，请检查", data: null };
    const hasTrace = r => r && r.code === 0 && r.data && Array.isArray(r.data.traces) && r.data.traces.length > 0;
    const hasData = r => r && r.code === 0 && r.data;
    const pool = [
      queryTrack3(inputNo).catch(() => ({ code: -99, msg: "3号渠道异常", data: null })),
      queryTrack101(inputNo).catch(() => ({ code: -99, msg: "101渠道异常", data: null })),
      queryNextsls(NEXTSLS[0], inputNo).catch(() => ({ code: -99, msg: "nextsls渠道异常", data: null })),
      queryNextsls(NEXTSLS[1], inputNo).catch(() => ({ code: -99, msg: "nextsls渠道异常", data: null }))
    ];
    const rs = await Promise.all(pool);
    for (const r of rs) { if (hasTrace(r)) return r; }
    for (const r of rs) { if (hasData(r)) return r; }
    return { code: 1, msg: "全部渠道均未匹配到运单", data: null };
  } catch (err) {
    return { code: -99, msg: "中转服务异常:" + err.message, data: null };
  }
}

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: HEADERS, body: "" };
  if (event.httpMethod === "GET") return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ code: 0, msg: "ok" }) };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ code: -1, msg: "仅支持POST" }) };
  try {
    const body = JSON.parse(event.body || "{}");
    const result = await queryTrack(body.trackNo || "");
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify(result) };
  } catch (err) {
    return { statusCode: 200, headers: HEADERS, body: JSON.stringify({ code: -99, msg: "中转服务异常:" + err.message, data: null }) };
  }
};

if (require.main === module) {
  const express = require("express");
  const cors = require("cors");
  const app = express();
  const PORT = process.env.PORT || 10000;
  app.use(cors({ origin: "*", allowedHeaders: ["Content-Type"], methods: ["POST", "GET", "OPTIONS"] }));
  app.use(express.json({ limit: "10kb" }));
  app.options("/track", (req, res) => res.sendStatus(200));
  app.post("/track", async (req, res) => {
    const result = await queryTrack(req.body.trackNo || "");
    res.json(result);
  });
  app.get("/", (req, res) => res.send("ok"));
  app.listen(PORT, () => console.log(`服务启动成功，端口:${PORT}`));
}
