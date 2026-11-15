
const fs = require('fs');
const roster = JSON.parse(fs.readFileSync('data/users-roster.json', 'utf8'));
const scores = JSON.parse(fs.readFileSync('data/users-scores.json', 'utf8'));
const users = Array.isArray(roster) ? roster : roster.users;
const scored = Array.isArray(scores) ? scores : scores.scored;
const scoreMap = new Map(scored.map(s => [s.id, s.score]));
const common = users.filter(u => scoreMap.has(u.id));
console.log('roster keys: ' + (Array.isArray(roster) ? 'array' : Object.keys(roster).join(',')));
console.log('scores keys: ' + (Array.isArray(scores) ? 'array' : Object.keys(scores).join(',')));
console.log('roster count: ' + users.length + ', scored count: ' + scored.length);
console.log('common ids: ' + JSON.stringify(common.map(u => u.id)));
console.log('detail: ' + JSON.stringify(common.map(u => ({ id: u.id, name: u.name, tier: u.tier, score: scoreMap.get(u.id) }))));
const pro = common.filter(u => u.tier === 'pro');
console.log('pro: ' + JSON.stringify(pro.map(u => ({ id: u.id, name: u.name, tier: u.tier, score: scoreMap.get(u.id) }))));
