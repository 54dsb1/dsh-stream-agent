
const fs = require("fs");
const out = [];
for (let i = 1; i <= 8; i++) {
  out.push("m" + i + ".txt = " + JSON.stringify(fs.readFileSync("modules/m" + i + ".txt", "utf8")));
}
out.push("summary.txt = " + JSON.stringify(fs.readFileSync("modules/summary.txt", "utf8")));
console.log(out.join("\n"));
