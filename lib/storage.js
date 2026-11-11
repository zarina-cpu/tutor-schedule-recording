const BUCKET = "assets";

let clientPromise;

async function filesClient() {
  if (!clientPromise) {
    clientPromise = Promise.all([import("files-sdk"), import("files-sdk/neon")]).then(
      ([{ Files }, { neon }]) => new Files({ adapter: neon({ bucket: BUCKET }) })
    );
  }
  return clientPromise;
}

async function putJson(key, data) {
  const files = await filesClient();
  await files.upload(key, Buffer.from(JSON.stringify(data), "utf8"), {
    contentType: "application/json",
  });
  return key;
}

async function getJson(key) {
  const files = await filesClient();
  const file = await files.download(key);
  const text = typeof file.text === "function" ? await file.text() : Buffer.from(await file.arrayBuffer()).toString("utf8");
  return JSON.parse(text);
}

async function putText(key, text, contentType) {
  const files = await filesClient();
  await files.upload(key, Buffer.from(String(text), "utf8"), {
    contentType: contentType || "text/plain",
  });
  return key;
}

async function getText(key) {
  const files = await filesClient();
  const file = await files.download(key);
  if (typeof file.text === "function") return file.text();
  return Buffer.from(await file.arrayBuffer()).toString("utf8");
}

async function objectUrl(key, expiresIn) {
  const files = await filesClient();
  return files.url(key, { expiresIn: expiresIn || 3600 });
}

module.exports = {
  BUCKET,
  filesClient,
  putJson,
  getJson,
  putText,
  getText,
  objectUrl,
};
