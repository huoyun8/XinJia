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
  targetUrl: "http://182.254.162.146/api/track",
  types: ["waybillnumber", "systemnumber", "customernumber"],
  timeoutMs: 8000
};

const NEXT_SLS_APIS = [
  "https://tracking.nextsls.com/rest/trace/tracking/lists?app=656d92f573f0427e8e5ca536&number=",
  "https://tracking.nextsls.com/rest/trace/tracking/lists?app=67204e5c73f04246486924cb&number="
];

app.options("/track", (req, res) => res.sendStatus(200));

function normNextsls(json, inputNo, channel) {
  const s = json.data.shipment;
  return {
    code: 0, msg: "查询成功", channel,
    data: {
      inputNo,
      carrier: s.outer_carrier_code || "",
      transNo: s.outer_carrier_tracking_number || "",
      country: s.country || "",
      postcode: s.postcode || "",
      status: s.status === "delivered" ? "delivered" : "transit",
      statusText: s.status === "delivered" ? "已签收" : "运输中",
      parcelCount: (s.parcel_count || s.parcel_count === 0) ? s.parcel_count : null,
      traces: (s.traces || []).map(t => ({ time: t.time || "", info: t.info || "", location: "" })),
      subOrders: []
    }
  };
}

function normScf(result, inputNo) {
  const d = result.data[0];
  const delivered = d.orderstatus === "Sign" || d.orderstatusName === "已签收";
  const subOrders = [];
  if (d.subOrderList && Array.isArray(d.subOrderList) && d.subOrderTrackItems) {
    for (const subNo of d.subOrderList) {
      const arr = d.subOrderTrackItems[subNo];
      if (arr && Array.isArray(arr) && arr.length) {
        subOrders.push({ no: subNo, traces: arr.map(t => ({ time: t.trackdate || "", info: t.info || "", location: t.location || "" })) });
      }
    }
  }
  return {
    code: 0, msg: "查询成功", channel: 3,
    data: {
      inputNo,
      carrier: "",
      transNo: d.waybillnumber || d.tracknumber || "",
      country: d.countrycode || "",
      postcode: d.postcode || "",
      status: delivered ? "delivered" : "transit",
      statusText: d.orderstatusName || d.orderstatus || "运输中",
      parcelCount: null,
      traces: (d.trackItems || []).map(t => ({ time: t.trackdate || "", info: t.info || "", location: t.location || "" })),
      subOrders
    }
  };
}

app.post("/track", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空", data: null });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查", data: null });

    for (let i = 0; i < NEXT_SLS_APIS.length; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
      try {
        const rawRes = await fetch(NEXT_SLS_APIS[i] + encodeURIComponent(inputNo), {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        clearTimeout(timer);
        const json = await rawRes.json();
        if (json && json.status === 1 && json.data && json.data.shipment) {
          return res.json(normNextsls(json, inputNo, i + 1));
        }
      } catch (err) { clearTimeout(timer); }
    }

    for (const type of CONFIG.types) {
      const postData = { authorization: { code: CONFIG.clientCode, token: CONFIG.apiToken }, datas: { [type]: [inputNo] } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
      const rawRes = await fetch(CONFIG.targetUrl, { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(postData) });
      clearTimeout(timer);
      const result = await rawRes.json();
      if (result.code === 0 && result.data && Array.isArray(result.data) && result.data.length > 0 && !result.data[0].errormsg) {
        return res.json(normScf(result, inputNo));
      }
    }

    return res.json({ code: 1, msg: "1/2/3渠道均未匹配到运单", data: null });
  } catch (err) {
    return res.json({ code: -99, msg: "中转服务异常:" + err.message, data: null });
  }
});

app.get("/", (req, res) => res.send("ok"));

app.listen(PORT, () => console.log(`服务启动成功，端口:${PORT}`));
