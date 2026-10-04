// ============================================================
// track-core.js — 三平台共用核心逻辑（netlify / render / 腾讯云函数）
// 只改这一个文件，三个平台重新部署即生效。纯 3 号渠道、只查自己的单。
// 兼容：优先用全局 fetch（Node 18+），不可用时回退内置 http 模块（老 Node/SCF）。
// ============================================================
const CONFIG = {
  clientCode: "20260928",
  apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
  host: "182.254.162.146",
  port: 80,
  targetUrl: "http://182.254.162.146/api/track",
  timeoutMs: 8000
};
const COUNTRY_NAMES = {
  AT:"奥地利",BE:"比利时",BG:"保加利亚",HR:"克罗地亚",CY:"塞浦路斯",
  CZ:"捷克",DK:"丹麦",EE:"爱沙尼亚",FI:"芬兰",FR:"法国",
  DE:"德国",GR:"希腊",HU:"匈牙利",IE:"爱尔兰",IT:"意大利",
  LV:"拉脱维亚",LT:"立陶宛",LU:"卢森堡",MT:"马耳他",NL:"荷兰",
  PL:"波兰",PT:"葡萄牙",RO:"罗马尼亚",SK:"斯洛伐克",SI:"斯洛文尼亚",
  ES:"西班牙",SE:"瑞典",US:"美国"
};

// ---------- 底层 HTTP 请求（fetch 优先，http 回退） ----------
const hasFetch = typeof fetch === "function";

// http 内置模块回退（老 Node / SCF 无全局 fetch 时使用）
function httpRequest(path, method, bodyStr, contentType, timeout) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    const options = {
      hostname: CONFIG.host, port: CONFIG.port, path, method,
      headers: { "Content-Type": contentType, "Content-Length": Buffer.byteLength(bodyStr) }
    };
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error("上游接口请求超时")));
    req.write(bodyStr);
    req.end();
  });
}

// JSON POST，/api/track 用（返回解析后的 JSON）
async function postJson(url, data) {
  if (hasFetch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    try {
      const raw = await fetch(url, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      return await raw.json();
    } finally { clearTimeout(timer); }
  }
  const path = url.replace(/^https?:\/\/[^/]+/, "") || "/";
  return JSON.parse(await httpRequest(path, "POST", JSON.stringify(data), "application/json", CONFIG.timeoutMs));
}

// form POST，/trackList 用（返回 {text, json}）
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
  const text = await httpRequest(path, "POST", bodyStr, "application/x-www-form-urlencoded", CONFIG.timeoutMs);
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { text, json };
}

// ---------- 业务逻辑 ----------
// 用 waybillnumber 类型查 /api/track（自己的单才命中）
async function queryApiTrack(waybillNumber) {
  const postData = { authorization: { code: CONFIG.clientCode, token: CONFIG.apiToken }, datas: { waybillnumber: [waybillNumber] } };
  const result = await postJson(CONFIG.targetUrl, postData);
  if (result.code === 0 && result.data && Array.isArray(result.data) && result.data.length > 0 && !result.data[0].errormsg) {
    return result.data[0];
  }
  return null;
}

// 自己的单：/api/track 状态+轨迹 + /trackList 邮编件数
function normScf(apiD, tlRec, inputNo) {
  const delivered = apiD.orderstatus === "Sign" || apiD.orderstatusName === "已签收";
  const subOrders = [];
  if (apiD.subOrderList && Array.isArray(apiD.subOrderList) && apiD.subOrderTrackItems) {
    for (const subNo of apiD.subOrderList) {
      const arr = apiD.subOrderTrackItems[subNo];
      if (arr && Array.isArray(arr) && arr.length) {
        subOrders.push({ no: subNo, traces: arr.map(t => ({ time: t.trackdate || "", info: t.info || "", location: t.location || "" })) });
      }
    }
  }
  const zip = tlRec || {};
  return {
    code: 0, msg: "查询成功", channel: 3,
    data: {
      inputNo,
      carrier: "",
      transNo: apiD.waybillnumber || apiD.tracknumber || "",
      country: COUNTRY_NAMES[(apiD.countrycode || "").toUpperCase()] || apiD.countrycode || "",
      postcode: (zip.zipcode || "").match(/^\d+/)?.[0] || "",
      status: delivered ? "delivered" : "transit",
      statusText: apiD.orderstatusName || apiD.orderstatus || "运输中",
      parcelCount: (zip.number !== undefined && zip.number !== null) ? zip.number : null,
      traces: (apiD.trackItems || []).map(t => ({ time: t.trackdate || "", info: t.info || "", location: t.location || "" })),
      subOrders
    }
  };
}

// 解析 /trackItem 返回的 HTML，提取完整轨迹（与182原网页折叠展开同源）
function parseTrackItemHtml(html) {
  const traces = [];
  const re = /<span class="trackdate"[^>]*>([^<]+)<\/span>\s*<span class="trackinfo">([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    traces.push({ time: (m[1] || "").trim(), info: (m[2] || "").replace(/\s+$/, "").replace(/\n+/g, " ").trim(), location: "" });
  }
  return traces;
}

// 别人的单：/trackList 邮编件数 + /trackItem 完整轨迹（状态降级"运输中"）
function normScfFallback(tlRec, traces, inputNo) {
  const country = COUNTRY_NAMES[(tlRec.countrycode || "").toUpperCase()] || tlRec.countryname || tlRec.countrycode || "";
  return {
    code: 0, msg: "查询成功", channel: 3,
    data: {
      inputNo,
      carrier: "",
      transNo: tlRec.tracknumber || tlRec.waybillnumber || "",
      country,
      postcode: (tlRec.zipcode || "").match(/^\d+/)?.[0] || "",
      status: "transit",
      statusText: "运输中",
      parcelCount: (tlRec.number !== undefined && tlRec.number !== null) ? tlRec.number : null,
      traces,
      subOrders: []
    }
  };
}

// 统一主入口：校验 + 查件，返回 {code, msg, data}
async function queryTrack(inputNoRaw) {
  try {
    const inputNo = (inputNoRaw || "").trim().toUpperCase();
    if (!inputNo) return { code: -2, msg: "运单号不能为空", data: null };
    if (inputNo.length < 5 || inputNo.length > 18) return { code: -2, msg: "单号长度需5-18位，请检查", data: null };
    // 先 /trackList 拿正确编号 + 邮编件数，同时判断单号是否存在
    const tl = await postForm("/trackList", { "searchList.waybillnumber": inputNo, searchLang: "zh" });
    if (!tl.json || tl.json.code !== 0 || !Array.isArray(tl.json.data) || !tl.json.data.length || tl.json.data[0].errormsg) {
      return { code: 1, msg: "3号渠道未匹配到运单", data: null };
    }
    const tlRec = tl.json.data[0];
    // 用 waybillnumber 查 /api/track → 自己的单命中（精确状态+轨迹）
    const apiD = await queryApiTrack(tlRec.waybillnumber || inputNo);
    if (apiD) {
      return normScf(apiD, tlRec, inputNo);
    }
    // 别人的单：/trackItem 拿完整轨迹（状态降级"运输中"）
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
  } catch (err) {
    return { code: -99, msg: "中转服务异常:" + err.message, data: null };
  }
}

module.exports = { queryTrack };
