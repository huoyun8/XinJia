const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { parseStringPromise } = require('xml2js');
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
    host: "http://120.79.98.64:7888",
    path: "/prod-api/order/track/html/getTrackByTrackNoNumberList",
    secretkey: "RoipOXsuEHxtskZtnG7u1w1=="
  }
};

app.options("/", (req, res) => {
  res.sendStatus(200);
});

// 清洗XML：截取从<AjaxResult>开始的内容，剔除前面脏字符
function cleanXml(raw) {
  const startTag = "<AjaxResult>";
  const idx = raw.indexOf(startTag);
  if (idx > -1) {
    return raw.slice(idx);
  }
  return raw;
}

async function queryLocalApi(trackNo) {
  try {
    const waybillStr = encodeURIComponent(trackNo);
    const sk = encodeURIComponent(CONFIG.localApi.secretkey);
    const fullUrl = `${CONFIG.localApi.host}${CONFIG.localApi.path}?waybillStr=${waybillStr}&secretkey=${sk}`;
    console.log("上游GET请求地址：", fullUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    const resp = await fetch(fullUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    console.log("上游HTTP状态码：", resp.status);
    const rawText = await resp.text();
    console.log("上游原始返回：", rawText);
    const xmlText = cleanXml(rawText);
    console.log("清洗后的XML：", xmlText);

    const xmlData = await parseStringPromise(xmlText);
    const ajax = xmlData.AjaxResult;
    const resCode = ajax.code[0];
    const msg = ajax.msg[0];
    console.log("解析结果 msg=",msg," code=",resCode);

    if(resCode !== "200"){
      throw new Error(`${msg}, code:${resCode}`);
    }
    const dataNode = ajax.data[0];
    const searchNumber = Array.isArray(dataNode.searchNumber) ? dataNode.searchNumber[0] : "";
    const orderId = Array.isArray(dataNode.orderId) ? dataNode.orderId[0] : "";
    const waybillNumber = Array.isArray(dataNode.waybillNumber) ? dataNode.waybillNumber[0] : "";
    const orderStatus = Array.isArray(dataNode.orderStatus) ? dataNode.orderStatus[0] : "";
    const trackNumber = Array.isArray(dataNode.trackNumber) ? dataNode.trackNumber[0] : "";
    const destination = Array.isArray(dataNode.destination) ? dataNode.destination[0] : "";
    const location = Array.isArray(dataNode.location) ? dataNode.location[0] : "";
    const trackInfo = Array.isArray(dataNode.trackInfo) ? dataNode.trackInfo[0] : "";
    const trackDate = Array.isArray(dataNode.trackDate) ? dataNode.trackDate[0] : "";

    return {
      success:true,
      msg:msg,
      data:[{
        searchNumber,
        orderId,
        waybillNumber,
        orderStatus,
        trackNumber,
        destination,
        location,
        trackInfo,
        trackDate
      }]
    };

  } catch (err) {
    console.error("查询捕获异常：", err);
    return { success: false, msg: err.message };
  }
}

app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到前端查询单号：", inputNo);

    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空", data: [] });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查", data: [] });

    const apiResult = await queryLocalApi(inputNo);
    if (apiResult.success) {
      return res.json({
        code: 0,
        msg: apiResult.msg,
        data: apiResult.data
      });
    } else {
      return res.json({
        code: -1,
        msg: apiResult.msg,
        data: []
      });
    }
  } catch (err) {
    console.error("中转服务全局异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message });
  }
});

app.get("/debug", async (req, res) => {
  const trackNo = req.query.no || "";
  if (!trackNo) return res.send("用法 /debug?no=单号");
  const ret = await queryLocalApi(trackNo);
  res.json(ret);
});

app.get("/", (req, res) => {
  res.send("中转服务运行正常");
});

app.all("*", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求", data: [] });
});

app.listen(PORT, () => {
  console.log(`中转服务启动成功，端口:${PORT}`);
});
