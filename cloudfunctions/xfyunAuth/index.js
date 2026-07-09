const crypto = require("crypto");

const HOST = "iat-api.xfyun.cn";
const PATH = "/v2/iat";

function response(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  };
}

exports.main = async (event) => {
  if (event && event.httpMethod === "OPTIONS") {
    return response(204, {});
  }

  const appId = process.env.XFYUN_APP_ID;
  const apiKey = process.env.XFYUN_API_KEY;
  const apiSecret = process.env.XFYUN_API_SECRET;

  if (!appId || !apiKey || !apiSecret) {
    return response(500, {
      error: "Missing XFYUN_APP_ID, XFYUN_API_KEY or XFYUN_API_SECRET environment variable.",
    });
  }

  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;
  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(signatureOrigin)
    .digest("base64");
  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  const url =
    `wss://${HOST}${PATH}?authorization=${encodeURIComponent(authorization)}` +
    `&date=${encodeURIComponent(date)}&host=${HOST}`;

  return response(200, { appId, url });
};
