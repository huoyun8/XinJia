# Render 中转查询接口

把「全球物流查询平台」的原生查询接口包装成一个可公网访问的中转 API。

## 1. 环境变量

| 变量 | 必填 | 说明 | 默认值 |
|---|---|---|---|
| `COOKIE` | 是 | 上游系统登录态 Cookie（不填则上游返回 401） | 无 |
| `ORIGIN_URL` | 否 | 上游系统地址 | `http://120.79.98.64:7888` |
| `UPSTREAM_PORT` | 否 | 上游端口（secretkey 加密明文） | `7888` |
| `PORT` | 否 | 本服务端口（Render 自动注入） | `3000` |

> `COOKIE` 为敏感登录凭证，建议在 Render 控制台以 **Secret / Environment Variable** 方式配置，不要写进仓库或公开。

## 2. 本地运行

```bash
npm install
COOKIE="Admin-Token=xxx; ..." npm start
```

## 3. 对外接口

### 查询（GET）
```
GET /api/track?numbers=1ZH8711V6814833154,1ZH8711V6803533132
```

### 查询（POST）
```
POST /api/track
Content-Type: application/json

{ "numbers": ["1ZH8711V6814833154", "1ZH8711V6803533132"] }
```

最多支持 **40** 个单号。

### 健康检查
```
GET /health
```
返回 `{"status":"ok","secretkey":"..."}`，可用于确认服务存活及当前端口下的密钥值。

## 4. 返回结构
```json
{
  "code": 200,
  "msg": "操作成功",
  "total": 2,
  "successCount": 2,
  "failCount": 0,
  "data": [
    {
      "code": 200,
      "searchNumber": "1ZH8711V6814833154",
      "customerNumber": "JXY32809",
      "waybillNumber": "MA00439737DK",
      "trackNumber": "1ZH8711V6814833154",
      "orderStatus": "已签收",
      "destination": "DK",
      "location": "SKAARUP FYN, DK",
      "trackInfo": "Delivered, DELIVERED",
      "trackDate": "2026-09-02 14:31:13",
      "trackInfoList": [ { "trackDateUtc8": "...", "info": "...", "location": "..." } ]
    }
  ]
}
```

## 5. 部署到 Render

1. 把本项目推到 GitHub/GitLab 仓库。
2. Render 控制台 → **New → Web Service** → 选择该仓库。
3. Runtime 选 **Node**，启动命令填 `npm start`。
4. 在 Environment 中添加变量 `COOKIE`（及其他可选变量）。
5. 部署完成后，即可通过 `https://<你的服务>.onrender.com/api/track?numbers=...` 调用。
