const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors({ origin: "*", allowedHeaders: ["Content-Type"], methods: ["POST", "GET", "OPTIONS"] }));
app.use(express.json({ limit: "10kb" }));
const CONFIG = {
  clientCode: "20260928",
  apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
  host: "182.254.162.146",
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
app.options("/track", (req, res) => res.sendStatus(200));
async function postJson(url, data) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const raw = await fetch(url, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    return await raw.json();
  } finally { clearTimeout(timer); }
}
async function postForm(path, params) {
  const body = new URLSearchParams(params);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    const raw = await fetch("http://" + CONFIG.host + path, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const text = await raw.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { text, json };
  } finally { clearTimeout(timer); }
}
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
app.post("/track", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空", data: null });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查", data: null });
    // 先 /trackList 拿正确编号 + 邮编件数，同时判断单号是否存在
    const tl = await postForm("/trackList", { "searchList.waybillnumber": inputNo, searchLang: "zh" });
    if (!tl.json || tl.json.code !== 0 || !Array.isArray(tl.json.data) || !tl.json.data.length || tl.json.data[0].errormsg) {
      return res.json({ code: 1, msg: "3号渠道未匹配到运单", data: null });
    }
    const tlRec = tl.json.data[0];
    // 用 waybillnumber 查 /api/track → 只认自己的单
    const apiD = await queryApiTrack(tlRec.waybillnumber || inputNo);
    if (apiD) {
      return res.json(normScf(apiD, tlRec, inputNo));
    }
    // 别人的单：不查 /trackItem，直接返回未匹配
    return res.json({ code: 1, msg: "3号渠道未匹配到运单", data: null });
  } catch (err) {
    return res.json({ code: -99, msg: "中转服务异常:" + err.message, data: null });
  }
});
app.get("/", (req, res) => res.send("ok"));
app.listen(PORT, () => console.log(`服务启动成功，端口:${PORT}`));
