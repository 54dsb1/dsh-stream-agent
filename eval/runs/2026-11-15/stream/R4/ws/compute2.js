
const fs = require('fs');
const roster = JSON.parse(fs.readFileSync('data/users-roster.json', 'utf8'));
const scores = JSON.parse(fs.readFileSync('data/users-scores.json', 'utf8'));
const ru = Array.isArray(roster) ? roster : roster.users;
const sc = Array.isArray(scores) ? scores : scores.scored;
const scoreMap = new Map();
for (const s of sc) scoreMap.set(s.id, s.score);
const common = ru.filter(u => scoreMap.has(u.id));
const ids = common.map(u => u.id);
console.log('ROSTER_LEN ' + ru.length + ' SCORES_LEN ' + sc.length);
console.log('COMMON_COUNT ' + ids.length);
console.log('COMMON_IDS ' + JSON.stringify(ids));
const pro = common.filter(u => String(u.tier).toLowerCase() === 'pro').map(u => ({ id: u.id, name: u.name, tier: u.tier, score: scoreMap.get(u.id) }));
console.log('PRO_COUNT ' + pro.length);
console.log('PRO ' + JSON.stringify(pro));
