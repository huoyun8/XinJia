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
    console.log("【查询单号】", inputNo);

    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    // ===================== 接口1 =====================
    let api1Format = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), { signal: abortCtrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        console.log("【接口1原始返回】", JSON.stringify(json,null,2));
        // 强校验：shipment存在，并且traces是数组，并且数组长度>0
        const shipmentList = json.data?.shipment;
        if (json.status === 1 && Array.isArray(shipmentList) && shipmentList.length > 0) {
          const firstShip = shipmentList[0];
          const traceArr = firstShip.traces;
          if (Array.isArray(traceArr) && traceArr.length > 0) {
            api1Format = shipmentList.map(item => ({
              inputNo: inputNo,
              transNo: item.outer_carrier_tracking_number || "",
              trackList: item.traces,
              country: item.country || "",
              parcelCount: item.parcel_count ?? null,
              status: item.status || "transit"
            }));
            console.log("✅ 命中接口1（带有效轨迹）", inputNo);
          }else{
            console.log("⚠️ 接口1查到运单，但轨迹为空，跳过，继续查询下一个接口");
          }
        }
      }
    } catch (e) {
      console.log("【接口1异常跳过】", e.message);
    }
    if (api1Format) return res.json({ code: 0, data: api1Format });

    // ===================== 接口2 =====================
    let api2Format = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), { signal: abortCtrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        console.log("【接口2原始返回】", JSON.stringify(json,null,2));
        const shipmentList = json.data?.shipment;
        if (json.status === 1 && Array.isArray(shipmentList) && shipmentList.length > 0) {
          const firstShip = shipmentList[0];
          const traceArr = firstShip.traces;
          if (Array.isArray(traceArr) && traceArr.length > 0) {
            api2Format = shipmentList.map(item => ({
              inputNo: inputNo,
              transNo: item.outer_carrier_tracking_number || "",
              trackList: item.traces,
              country: item.country || "",
              parcelCount: item.parcel_count ?? null,
              status: item.status || "transit"
            }));
            console.log("✅ 命中接口2（带有效轨迹）", inputNo);
          }else{
            console.log("⚠️ 接口2查到运单，但轨迹为空，跳过，继续查询下一个接口");
          }
        }
      }
    } catch (e) {
      console.log("【接口2异常跳过】", e.message);
    }
    if (api2Format) return res.json({ code: 0, data: api2Format });

    // ===================== 接口3 内网渠道 =====================
    console.log("ℹ️ 接口1/2无有效轨迹，进入接口3查询");
    const api3Cfg = CONFIG.api3;
    let api3Format = null;
    for (const type of api3Cfg.types) {
      try {
        const body = { authorization: { code: api3Cfg.clientCode, token: api3Cfg.apiToken }, datas: { [type]: [inputNo] } };
        const abortCtrl = new AbortController();
        const timer = setTimeout(() => abortCtrl.abort(), api3Cfg.timeoutMs);
        const resp = await fetch(api3Cfg.targetUrl, {
          method: "POST",
          signal: abortCtrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        clearTimeout(timer);
        console.log(`【接口3-${type} HTTP状态】`,resp.status);
        if (!resp.ok) throw new Error(`HTTP${resp.status}`);
        const json = await resp.json();
        console.log(`【接口3-${type}返回】`, JSON.stringify(json,null,2));
        if (
          json.code === 0
          && json.data?.length > 0
          && !json.data[0].errormsg
          && Array.isArray(json.data[0].trackItems)
          && json.data[0].trackItems.length > 0
        ) {
          api3Format = [{
            inputNo: inputNo,
            transNo: json.data[0].tracknumber || "",
            trackList: json.data[0].trackItems,
            country: json.data[0].countrycode || "",
            parcelCount: null,
            status: json.data[0].orderstatus || "transit"
          }];
          console.log("✅ 命中接口3（带有效轨迹）");
          break;
        }else{
          console.log(`⚠️接口3-${type}查询无有效轨迹`);
        }
      } catch (e) {
        console.log(`❌【接口3-${type}异常】`, e.message);
        continue;
      }
    }
    if (api3Format) return res.json({ code: 0, data: api3Format });

    // 全部渠道都没有带轨迹的数据
    return res.json({ code: 3, msg: "单号错误，请核对" });
  } catch (globalErr) {
    console.error("全局服务异常", globalErr);
    const msg = globalErr.name === "AbortError" ? "上游接口请求超时" : "中转服务异常";
    return res.json({ code: -99, msg, error: globalErr.message });
  }
});

app.get("/", (req, res) => res.send("修复版：严格校验轨迹数组，空轨迹自动跳过，打印完整日志"));
app.all("/", (req, res) => res.json({ code: -1, msg: "仅支持POST查询请求" }));
app.listen(PORT, () => console.log(`服务启动完成，端口${PORT}`));
