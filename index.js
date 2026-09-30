const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

// 跨域配置保持原样，兼容前端页面
app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS", "GET"]
}));
app.use(express.json({ limit: "10kb" }));

const CONFIG = {
  // 原有182内网接口配置
  clientCode: "20260928",
  apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
  targetUrl: "http://182.254.162.146/api/track",
  types: ["waybillnumber", "systemnumber", "customernumber"],
  timeoutMs: 8000,
  // 新增：本地120.79.98.64:1888 XML接口配置
  localApi: {
    host: "http://120.79.98.64:1888",
    path: "/prod-api/order/track/html/getTrackByTrackNoNumberList",
    secretkey: "n6VD8BDmTUhmoljTMT41Uw96%3D%3D"
  }
};

// OPTIONS预检
app.options("/", (req, res) => {
  res.sendStatus(200);
});

/**
 * 函数1：原有内网182接口查询逻辑（保留不变）
 */
async function queryOldApi(trackNo) {
  let lastResult = null;
  for (const type of CONFIG.types) {
    const postData = {
      authorization: { code: CONFIG.clientCode, token: CONFIG.apiToken },
      datas: { [type]: [trackNo] }
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    try {
      const rawRes = await fetch(CONFIG.targetUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData)
      });
      clearTimeout(timer);
      const result = await rawRes.json();
      lastResult = result;
      if (result.code === 0 && result.data && result.data.length > 0 && !result.data[0].errormsg) {
        return { success: true, data: result.data, source: "old_api" };
      }
    } catch (err) {
      clearTimeout(timer);
      console.log(`旧接口 ${type} 查询异常:`, err.message);
      continue;
    }
  }
  return { success: false, raw: lastResult, source: "old_api" };
}

/**
 * 函数2：新增本地120.79.98.64 XML接口查询 + XML转统一JSON结构
 */
async function queryLocalApi(trackNo) {
  try {
    // 拼接带鉴权secretkey的GET请求链接
    const urlParams = new URLSearchParams();
    urlParams.set("waybillStr", trackNo);
    urlParams.set("secretkey", CONFIG.localApi.secretkey);
    const fullUrl = `${CONFIG.localApi.host}${CONFIG.localApi.path}?${urlParams.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    const resp = await fetch(fullUrl, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP状态码${resp.status}`);

    const xmlText = await resp.text();
    // 简易XML文本解析（适配<AjaxResult>返回结构，无额外xml解析依赖）
    const extractXmlText = (xml, tag) => {
      const start = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return start ? start[1].trim() : "";
    };

    const rootCode = extractXmlText(xmlText, "code");
    const rootMsg = extractXmlText(xmlText, "msg");
    if (rootCode !== "200") throw new Error(`本地接口返回失败:${rootMsg}`);

    // 提取data内部字段
    const searchNumber = extractXmlText(xmlText, "searchNumber");
    const trackNumber = extractXmlText(xmlText, "trackNumber");
    const destination = extractXmlText(xmlText, "destination");
    const orderStatus = extractXmlText(xmlText, "orderStatus");
    const trackInfo = extractXmlText(xmlText, "trackInfo");
    const trackDate = extractXmlText(xmlText, "trackDate");
    const location = extractXmlText(xmlText, "location");

    // 无物流数据直接返回失败
    if (!trackInfo && !trackDate) {
      return { success: false, source: "local_api", msg: "本地渠道无轨迹数据" };
    }

    // 转换为和旧接口统一格式，前端无需修改渲染逻辑
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
    return { success: true, data: [formatItem], source: "local_api" };
  } catch (err) {
    console.log("本地120接口查询异常:", err.message);
    return { success: false, source: "local_api", msg: err.message };
  }
}

// 核心POST中转接口
app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到前端查询单号：", inputNo);

    // 单号校验（和前端校验规则保持一致）
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    // 并行同时请求两套上游接口，减少等待时间
    const [oldRes, localRes] = await Promise.all([
      queryOldApi(inputNo),
      queryLocalApi(inputNo)
    ]);

    // 合并所有渠道有效数据
    let mergeData = [];
    if (oldRes.success) mergeData = mergeData.concat(oldRes.data);
    if (localRes.success) mergeData = mergeData.concat(localRes.data);

    // 存在任意渠道有效数据，统一返回code=0
    if (mergeData.length > 0) {
      return res.json({
        code: 0,
        msg: "查询成功",
        data: mergeData,
        sourceTip: `有效渠道:${[oldRes.success && "内网渠道", localRes.success && "本地渠道"].filter(Boolean).join(",")}`
      });
    }

    // 两个渠道都无数据，返回空结果
    return res.json({
      code: -1,
      msg: "内网渠道、本地渠道均未查询到物流信息",
      data: [],
      detail: { oldErr: oldRes.raw?.msg || oldRes.msg, localErr: localRes.msg }
    });

  } catch (err) {
    console.error("中转服务全局异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message, data: [] });
  }
});

// 健康检测GET
app.get("/", (req, res) => {
  res.send("双渠道代理服务运行正常 | 内网182 + 本地120.79.98.64 XML接口");
});

// 拦截非POST请求
app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求" });
});

app.listen(PORT, () => {
  console.log(`双渠道中转代理启动成功，监听端口:${PORT}`);
  console.log("已接入渠道：");
  console.log("1. 原有内网接口 http://182.254.162.146/api/track");
  console.log("2. 本地XML接口 http://120.79.98.64:1888（携带固定secretkey鉴权）");
});
