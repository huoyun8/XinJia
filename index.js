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

app.options("/", (req, res) => res.sendStatus(200));

app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    console.log("收到查询单号：", inputNo);

    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    // ========== 接口1 串行查询 + 强制校验轨迹非空 ==========
    let api1ValidFormat = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), { signal: abortCtrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        // 必须同时满足：有运单 + 轨迹数组存在 + 轨迹长度大于0
        if (
          json.status === 1
          && json.data?.shipment?.length > 0
          && json.data.shipment[0].traces
          && Array.isArray(json.data.shipment[0].traces)
          && json.data.shipment[0].traces.length > 0
        ) {
          // 统一格式化，和接口3输出字段完全对齐 trackList / transNo
          api1ValidFormat = json.data.shipment.map(item => ({
            inputNo: inputNo,
            transNo: item.outer_carrier_tracking_number || "",
            trackList: item.traces,
            country: item.country || "",
            parcelCount: item.parcel_count || null,
            status: item.status || "transit"
          }));
        }
      }
    } catch (e) {
      console.log("【接口1】异常丢弃：", e.message);
    }
    if (api1ValidFormat) return res.json({ code: 0, data: api1ValidFormat });

    // ========== 接口2 串行查询 + 强制校验轨迹非空（你AJ263012这条存在这里） ==========
    let api2ValidFormat = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), { signal: abortCtrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        // 核心校验：运单存在 + 轨迹数组不为空
        if (
          json.status === 1
          && json.data?.shipment?.length > 0
          && json.data.shipment[0].traces
          && Array.isArray(json.data.shipment[0].traces)
          && json.data.shipment[0].traces.length > 0
        ) {
          api2ValidFormat = json.data.shipment.map(item => ({
            inputNo: inputNo,
            transNo: item.outer_carrier_tracking_number || "",
            trackList: item.traces,
            country: item.country || "",
            parcelCount: item.parcel_count || null,
            status: item.status || "transit"
          }));
        }
      }
    } catch (e) {
      console.log("【接口2】异常丢弃：", e.message);
    }
    // 接口2查到带轨迹数据，直接返回标准化结构给前端
    if (api2ValidFormat) return res.json({ code: 0, data: api2ValidFormat });

    // ========== 接口3 内网渠道查询 ==========
    console.log("接口1、2无带有效轨迹运单，进入接口3查询");
    const api3Cfg = CONFIG.api3;
    let api3FormatData = null;
    for (const type of api3Cfg.types) {
      try {
        const reqBody = {
          authorization: { code: api3Cfg.clientCode, token: api3Cfg.apiToken },
          datas: { [type]: [inputNo] }
        };
        const abortCtrl = new AbortController();
        const timer = setTimeout(() => abortCtrl.abort(), api3Cfg.timeoutMs);
        const resp = await fetch(api3Cfg.targetUrl, {
          method: "POST",
          signal: abortCtrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody)
        });
        clearTimeout(timer);
        if (!resp.ok) throw new Error(`HTTP${resp.status}`);
        const json = await resp.json();
        console.log(`【接口3-${type}】返回：`, json);
        if (
          json.code === 0
          && json.data?.length > 0
          && !json.data[0].errormsg
          && json.data[0].trackItems
          && Array.isArray(json.data[0].trackItems)
          && json.data[0].trackItems.length > 0
        ) {
          api3FormatData = [{
            inputNo: inputNo,
            transNo: json.data[0].tracknumber || "",
            trackList: json.data[0].trackItems,
            country: json.data[0].countrycode || "",
            parcelCount: null,
            status: json.data[0].orderstatus || "transit"
          }];
          break;
        }
      } catch (e) {
        console.log(`【接口3-${type}】异常丢弃：`, e.message);
        continue;
      }
    }
    if (api3FormatData) return res.json({ code: 0, data: api3FormatData });

    // 1/2/3 全部渠道都没有「带物流轨迹」的运单
    return res.json({ code: 3, msg: "单号错误，请核对" });
  } catch (globalErr) {
    console.error("中转服务全局异常：", globalErr);
    const msg = globalErr.name === "AbortError" ? "上游接口请求超时" : "中转服务异常";
    return res.json({ code: -99, msg, error: globalErr.message });
  }
});

app.get("/", (req, res) => res.send("修复版：接口1/2强制校验轨迹，统一输出trackList字段"));
app.all("/", (req, res) => res.json({ code: -1, msg: "仅支持POST查询请求" }));
app.listen(PORT, () => console.log(`服务启动完成，监听端口${PORT}`));
