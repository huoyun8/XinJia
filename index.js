const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS", "GET"]
}));
app.use(express.json({ limit: "10kb" }));

const CONFIG = {
  timeoutMs: 8000,
  localApi: {
    host: "http://120.79.98.64:1888",
    path: "/prod-api/order/track/html/getTrackByTrackNoNumberList",
    secretkey: "n6VD8BDmTUhmoljTMT41Uw96%3D%3D"
  }
};

app.options("/", (req, res) => {
  res.sendStatus(200);
});

async function queryLocalApi(trackNo) {
  try {
    const urlParams = new URLSearchParams();
    urlParams.set("waybillStr", trackNo);
    urlParams.set("secretkey", CONFIG.localApi.secretkey);
    const fullUrl = `${CONFIG.localApi.host}${CONFIG.localApi.path}?${urlParams.toString()}`;
    console.log("上游完整请求地址：", fullUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    const resp = await fetch(fullUrl, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);
    console.log("上游HTTP状态码：", resp.status);
    if (!resp.ok) throw new Error(`HTTP状态码${resp.status}`);

    const xmlText = await resp.text();
    console.log("上游返回原始XML：", xmlText);

    const extractXmlText = (xml, tag) => {
      const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return match ? match[1].trim() : null;
    };

    const rootCode = extractXmlText(xmlText, "code");
    const rootMsg = extractXmlText(xmlText, "msg");
    console.log("解析code:", rootCode, "msg:", rootMsg);

    if(rootCode === null){
      throw new Error("返回内容不是预期XML，找不到<code>标签");
    }
    if (rootCode !== "200") throw new Error(`接口业务失败:${rootMsg}`);

    const searchNumber = extractXmlText(xmlText, "searchNumber");
    const trackNumber = extractXmlText(xmlText, "trackNumber");
    const destination = extractXmlText(xmlText, "destination");
    const orderStatus = extractXmlText(xmlText, "orderStatus");
    const trackInfo = extractXmlText(xmlText, "trackInfo");
    const trackDate = extractXmlText(xmlText, "trackDate");
    const location = extractXmlText(xmlText, "location");

    if (!trackInfo && !trackDate) {
      return { success: false, msg: "该单号暂无物流轨迹数据" };
    }

    const formatItem = {
      tracknumber: trackNumber,
      waybillnumber: searchNumber,
      countrycode: "",
      countryname: destination,
      orderstatus: orderStatus || "运输中",
      orderstatusName: orderStatus || "运输中",
      trackItems: [{ trackdate: trackDate, info: trackInfo, location }],
      subOrderList: [],
      subOrderTrackItems: {}
    };
    return { success: true, data: [formatItem] };
  } catch (err) {
    console.error("查询捕获异常：", err);
    return { success: false, msg: err.message };
  }
}

app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号：", inputNo);

    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    const apiRes = await queryLocalApi(inputNo);

    if (apiRes.success) {
      return res.json({
        code: 0,
        msg: "查询成功",
        data: apiRes.data
      });
    } else {
      return res.json({
        code: -1,
        msg: apiRes.msg,
        data: []
      });
    }
  } catch (err) {
    console.error("全局异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message, data: [] });
  }
});

app.get("/", (req, res) => {
  res.send("中转服务运行正常 | 仅对接接口：http://120.79.98.64:1888");
});

app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求" });
});

app.listen(PORT, () => {
  console.log(`中转服务启动成功，端口:${PORT}`);
});
