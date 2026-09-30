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

// 全局接口配置
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

// 统一查询入口
app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号：", inputNo);

    // 单号基础校验
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    // ====================== 第一步：查询接口1 ======================
    let api1ValidList = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), { signal: abortCtrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json.status === 1 && json.data?.shipment?.length > 0) {
          api1ValidList = json.data.shipment;
        }
      }
    } catch (err) {
      console.log(`【接口1】异常丢弃：${err.message}`);
    }
    // 接口1查到数据，格式化后直接返回
    if (api1ValidList) {
      const formatData = api1ValidList.map(item => ({
        inputNo: inputNo,
        transNo: item.outer_carrier_tracking_number || "",
        trackList: item.traces || [],
        country: item.country || "",
        parcelCount: item.parcel_count || null,
        status: item.status || "transit"
      }));
      return res.json({ code: 0, data: formatData });
    }

    // ====================== 第二步：查询接口2 ======================
    let api2ValidList = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), { signal: abortCtrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const json = await resp.json();
        if (json.status === 1 && json.data?.shipment?.length > 0) {
          api2ValidList = json.data.shipment;
        }
      }
    } catch (err) {
      console.log(`【接口2】异常丢弃：${err.message}`);
    }
    // 接口2查到数据，格式化后直接返回
    if (api2ValidList) {
      const formatData = api2ValidList.map(item => ({
        inputNo: inputNo,
        transNo: item.outer_carrier_tracking_number || "",
        trackList: item.traces || [],
        country: item.country || "",
        parcelCount: item.parcel_count || null,
        status: item.status || "transit"
      }));
      return res.json({ code: 0, data: formatData });
    }

    // ====================== 第三步：查询接口3（内网三段式） ======================
    console.log("接口1、2无数据，进入接口3查询");
    const api3Cfg = CONFIG.api3;
    let api3FinalData = null;
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
        // 校验：存在运单 + 有轨迹才算有效
        if (json.code === 0 && json.data?.length > 0 && !json.data[0].errormsg && json.data[0].trackItems?.length > 0) {
          api3FinalData = {
            inputNo: inputNo,
            transNo: json.data[0].tracknumber || "",
            trackList: json.data[0].trackItems || [],
            country: json.data[0].countrycode || "",
            parcelCount: null,
            status: json.data[0].orderstatus || "transit"
          };
          break;
        }
      } catch (err) {
        console.log(`【接口3-${type}】异常丢弃：${err.message}`);
        continue;
      }
    }
    // 接口3查到有效数据返回
    if (api3FinalData) return res.json({ code: 0, data: [api3FinalData] });

    // 1/2/3全部渠道无有效运单
    return res.json({ code: 3, msg: "单号错误，请核对" });
  } catch (globalErr) {
    console.error("全局服务异常：", globalErr);
    const msg = globalErr.name === "AbortError" ? "上游接口请求超时" : "中转服务异常";
    return res.json({ code: -99, msg, error: globalErr.message });
  }
});

app.get("/", (req, res) => res.send("统一中转服务 串行查询1→2→3"));
app.all("/", (req, res) => res.json({ code: -1, msg: "仅支持POST查询请求" }));

app.listen(PORT, () => console.log(`服务启动，监听端口${PORT}`));
