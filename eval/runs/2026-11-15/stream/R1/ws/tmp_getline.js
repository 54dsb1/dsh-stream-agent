
const fs = require('fs');
const t = fs.readFileSync('data/big-report.md', 'utf8');
const lines = t.split(/\r?\n/);
let n = lines.length;
if (n > 0 && lines[n - 1] === '') n--;
console.log('TOTAL=' + n);
console.log('LINE137_START');
console.log(lines[136]);
console.log('LINE137_END');
