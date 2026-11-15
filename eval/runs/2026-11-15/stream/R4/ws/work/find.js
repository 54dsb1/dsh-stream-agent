
const fs = require('fs');
const r = JSON.parse(fs.readFileSync('data/users-roster.json', 'utf8')).users;
const s = JSON.parse(fs.readFileSync('data/users-scores.json', 'utf8')).scored;
const m = new Map(r.map(u => [u.id, u]));
const inter = s.filter(x => m.has(x.id));
console.log('roster=' + r.length + ' scored=' + s.length);
console.log(JSON.stringify(inter.map(x => ({ id: x.id, score: x.score, tier: m.get(x.id).tier, name: m.get(x.id).name }))));
console.log('pro=' + JSON.stringify(inter.filter(x => m.get(x.id).tier === 'pro').map(x => ({ id: x.id, score: x.score }))));
