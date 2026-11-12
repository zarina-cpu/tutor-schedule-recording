const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const extra = { CARD_NUMBER: "8600 •••• •••• 1234" };
const map = {};
for (const line of fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i < 0) continue;
  let value = line.slice(i + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  map[line.slice(0, i).trim()] = value;
}
if (map.TELEGRAM_TUTOR_CHAT_ID) extra.TELEGRAM_CHAT_ID = map.TELEGRAM_TUTOR_CHAT_ID;
Object.assign(map, extra);

let ok = 0;
let fail = 0;
for (const name of Object.keys(map)) {
  const result = spawnSync(
    "npx",
    [
      "vercel",
      "env",
      "add",
      name,
      "--environment",
      "production,preview",
      "--force",
      "--yes",
      "--scope",
      "zarin4ik5551212-6365",
    ],
    { input: map[name], encoding: "utf8", shell: true }
  );
  if (result.status === 0) ok += 1;
  else {
    fail += 1;
    process.stderr.write(`${name} failed\n`);
    if (result.stderr) process.stderr.write(`${result.stderr.slice(0, 240)}\n`);
  }
}
console.log(`imported ${ok} failed ${fail} keys ${Object.keys(map).length}`);
