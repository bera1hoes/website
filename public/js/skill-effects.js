// Class skill, mastery and artifact equip-skill effects on the Arena stats — a line-by-line port
// of SwissKnife's skill_effects.py (keep in sync; the function names match with camelCase). Also
// what the skill bar needs: which slotted skills stun (heroStuns) and each one's icon (skillIcon).
//
// A hero's own skills change its stats in ways no buff _stats block records: Wind Breaker's
// Evasion Boost is a permanent +27 Avoid, Night Lord's Shadow Shifter is +20 Avoid for 3s after
// 20% of the hits it takes, and Shadower's Smokescreen strips the *opponent's* Avoid/Accuracy.
// Worn artifacts' equip skills too: the Artifact buff's _stats are the owned-collection stats
// only, so Book of Ancient's +14% crit is in no _stats block either.
// heroSkillEffects() walks one hero's learned skills through the SkillEffectTable and returns
// each effect; callers roll the permanent self ones into the totals, show the conditional ones
// as "+ (x)", and list the enemy ones as debuffs on YOU. See skill_effects.py's docstring for how
// roots, follow-ups, mastery edits, recipients, arena conditions, conversions and descriptions
// work — notably that a description reads the whole chain from the learned skill to the op: a
// touch area holds its debuff only while the target stands in it (Smokescreen: "in its area, up
// to 20s"), a UsePassiveSkill window limits the passive it grants, and a buff expiring with a
// state lasts as long as that state. A stacking state counts every stack it can reach: one per
// bullet of a multi-tick cast (Swift Fire: 3), or its cap when it re-fires before its stacks lapse
// (Focused Fury: 10). Masteries that retime a skill (cooldown, proc chance, timer, duration) are
// applied to its record first (_retimed), so every description reads the edited timing.
//
// SkillEffectTable.json is written by SwissKnife's tools/export_arena_skills.py (the SkillTable
// subset this reads, projectile landings, state stack caps, names) — re-export it, don't edit it.

const SKILL_STATS = ['AvoidChance', 'HitChance', 'CriticalChance', 'CriticalResist', 'CriticalPower',
                     'Defence', 'PiercePower', 'Toughness', 'Weakness'];
// The data misspells some stat names (Smokescreen's accuracy debuff is "Hitchance").
const _SKILL_CANON = Object.fromEntries(SKILL_STATS.map(s => [s.toLowerCase(), s]));

const _STAT_OPS = new Set(['ModStat', 'ModStatR', 'ModStatOnTick']);
const _LINK_OPS = new Set(['UseSkill', 'UseSkillToTarget', 'UsePassiveSkill', 'CreateProjectile', 'FireProjectile']);
const _PROJECTILE_OPS = new Set(['CreateProjectile', 'FireProjectile']);
const _IMMEDIATE_LINKS = new Set(['UseSkill', 'UsePassiveSkill']);
// ModSkill / ModSkillR field -> the record (or op) field it edits: a mastery's timing changes.
const _TIMING_FIELDS = { SkillCoolTimeMs: 'CoolTimeMs', SkillTriggerRatio: 'TriggerRatio',
                         SkillTriggerTimeMs: 'TriggerTimeMs', DurationMs: 'DurationMs' };
const _MAX_DEPTH = 3;
const _FOREVER_MS = 99999999;
// Buffs whose PassiveSkillLevels list skill indices the hero owns. For Artifact they are the worn
// artifacts' equip skills, whose effects its _stats block does NOT include.
const _SKILL_BUFF_TYPES = ['SkillMastery', 'GuildNoblesseSkill', 'GuildMasterySkill', 'GuildMemberSkill',
                           'Artifact'];

const _SIDE = {
  Myself: 'self', TriggerSelf: 'self',
  Friend: 'ally', Ally: 'ally', RandomFriend: 'ally', NearFriend: 'ally', MinStatFriend: 'ally',
  Enemy: 'enemy', RandomEnemy: 'enemy', MinStatEnemy: 'enemy', TriggerTarget: 'enemy',
};
const _HIT_OPS = ['GetDamage', 'GetDot', 'Stun', 'Frozen'];
const _AREA_ANCHORS = new Set(['FiredTargetPlatform', 'FiredTargetGround', 'FiredMyselfPlatform',
                               'FiredMyselfGround', 'ProjectilePosition']);

const _PER_STACK = /^\$CreatureStateCount\(\s*\w+\s*[;,]\s*(\w+)\s*\)\s*\*\s*(?:\(\s*0\s*-\s*(\d+(?:\.\d+)?)\s*\)|(-?\d+(?:\.\d+)?))$/;
// "x per-mille of the hero's final <stat>" (Book of Ancient: crit damage = 42% of crit rate), in its
// two spellings — the artifact helper and the plain expression Sharp Eyes uses.
const _FINAL_RATIO = /^(?:#GetFinalStatRatio\(\s*(\w+)\s*;\s*(-?\d+(?:\.\d+)?)\s*\)|\$CreatureFinalStat\(\s*UsedCreature\s*;\s*(\w+)\s*\)\s*\*\s*(-?\d+(?:\.\d+)?)\s*\/\s*1000)$/;
const _TRIGGER_SKILL = /\$Trigger\.SkillIndex\s*==\s*(\d+)/;
// One TickTimeMs entry (the client's SkillTickTimeData): "200" fires the record's ops, "300[3]" or
// "300[1:3]" only the ops named.
const _TICK = /^\s*\d+\s*(?:\[([\d:\s]*)\])?\s*$/;
const _STATE_COUNT = /\$CreatureStateCount\(\s*\w+\s*[;,]\s*(\w+)\s*\)\s*(==|<|>|>=)\s*(\d+)/;
// A threshold on one of the hero's own per-mille stats, for the condition text ("MP ≥ 50%").
const _FINAL_STAT_COND = /\$CreatureFinalStat\(\s*\w+\s*;\s*(\w+)\s*\)\s*(>=|<=|>|<)\s*(\d+)/;
const _FINAL_STAT_NAMES = { hpratio: 'HP', mpratio: 'MP', criticalchance: 'Crit' };
const _CLAUSE = /^\s*\$(\w+)\(([^)]*)\)\s*(==|!=|>=|<=|>|<)\s*(-?\d+)\s*$/;
const _CMP = { '==': (a, b) => a === b, '!=': (a, b) => a !== b, '>=': (a, b) => a >= b,
               '<=': (a, b) => a <= b, '>': (a, b) => a > b, '<': (a, b) => a < b };
const _PVE_DUNGEONS = new Set(['GuildBoss', 'GuildLeague', 'GuildTraining', 'GrowthDungeon', 'Campaign', 'WorldBoss']);
// Condition functions with a fixed value in an arena fight: no bosses, no guild-raid battle code,
// and exactly one enemy — each side is a single hero.
const _FIXED_IN_PVP = { CreatureIsBoss: 0, CreatureBossCount: 0, CheckBattleDefineCode: 0, CreatureEnemyCount: 1 };
const _NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// Python truthiness — the port relies on it where a field may be a list ([] is falsy there).
function _truthy(x) {
  if (x === null || x === undefined || x === false || x === 0 || x === '') return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x).length > 0;
  return true;
}

// Python int(v), or null where it would raise.
function _int(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  const s = String(v).trim();
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

// Python's f"{x:g}" for the magnitudes the data uses.
function _g(x) { return String(Number(x.toPrecision(6))); }

// Evaluate a skill condition for an arena fight: true, false, or null (depends on the fight).
// finals ({ canonical stat: raw total }) is the hero's standing totals: a clause on its own final
// stat ("$CreatureFinalStat(UsedCreature;CriticalChance) < 1000") that they fail is false; one
// they pass stays null, since conditional buffs can still move the stat mid-fight.
function pvpTruth(cond, finals = null) {
  if (!cond) return true;
  const ors = [];
  for (const disjunct of cond.split('||')) {
    const ands = [];
    for (const clause of disjunct.split('&&')) {
      const m = _CLAUSE.exec(clause);
      let truth = null;
      if (m) {
        const fn = m[1], arg = m[2].trim();
        const cmp = _CMP[m[3]], bound = parseInt(m[4], 10);
        if (Object.hasOwn(_FIXED_IN_PVP, fn)) {
          truth = cmp(_FIXED_IN_PVP[fn], bound);
        } else if (fn === 'CheckDungeonType' && _PVE_DUNGEONS.has(arg)) {
          truth = cmp(0, bound);
        } else if (fn === 'CreatureFinalStat' && _truthy(finals)) {
          const at = arg.indexOf(';');
          const who = (at < 0 ? arg : arg.slice(0, at)).trim();
          const stat = at < 0 ? '' : arg.slice(at + 1).trim();
          const final = finals[_SKILL_CANON[stat.toLowerCase()]];
          if (who === 'UsedCreature' && final !== undefined && final !== null && !cmp(final, bound)) truth = false;
        }
      }
      ands.push(truth);
    }
    ors.push(ands.includes(false) ? false : ands.includes(null) ? null : true);
  }
  return ors.includes(true) ? true : ors.includes(null) ? null : false;
}

function _ops(record) { return record.Operations || []; }

// [skillId, linkOp, projectile] for every record this one launches. A projectile lands its
// SkillIndex, and so do its ChildProjectileIndices (Smokescreen's ally cloud), each yielded with
// the projectile row it lands through; a direct link yields projectile null.
function* _children(record, tables) {
  const projectiles = tables.skillProjectiles || {};
  for (const op of _ops(record)) {
    if (!_truthy(op) || !_LINK_OPS.has(op.Type)) continue;
    const target = _int((op.Values || [null])[0]);
    if (target === null) continue;
    if (!_PROJECTILE_OPS.has(op.Type)) {
      yield [target, op, null];
      continue;
    }
    const pending = [target], seen = new Set();
    while (pending.length) {
      const pid = pending.shift();
      if (seen.has(pid)) continue;
      seen.add(pid);
      const projectile = projectiles[String(pid)] || {};
      const landed = projectile.SkillIndex;
      for (const sid of Array.isArray(landed) ? landed : [landed])
        if (_int(sid) !== null) yield [_int(sid), op, projectile];
      for (const c of projectile.ChildProjectileIndices || []) if (_int(c) !== null) pending.push(c);
    }
  }
}

// [skillId, record, fromStart, hops] for a root and its follow-ups, root first (breadth-first).
// hops is the chain of links from the root: { record, op, projectile } — record's op launched the
// next record, through projectile (its row) or directly (null).
function* _walk(root, tables) {
  const skills = tables.skills || {};
  const seen = new Set();
  const queue = [[root, true, []]];
  while (queue.length) {
    const [sid, parentStart, hops] = queue.shift();
    const record = skills[String(sid)];
    if (seen.has(sid) || record === undefined) continue;
    seen.add(sid);
    const trigger = record.TriggerType;
    const fromStart = !hops.length
      ? trigger === 'OnStart'
      : parentStart && _IMMEDIATE_LINKS.has(hops[hops.length - 1].op.Type)
        && (trigger === undefined || trigger === null || trigger === 'OnStart');
    yield [sid, record, fromStart, hops];
    if (hops.length < _MAX_DEPTH)
      for (const [child, op, projectile] of _children(record, tables))
        queue.push([child, fromStart, [...hops, { record, op, projectile }]]);
  }
}

// [skillId, record, fromStart] for a root and its follow-ups (see _walk).
function* _family(root, tables) {
  for (const [sid, record, fromStart] of _walk(root, tables)) yield [sid, record, fromStart];
}

const _key = (a, b) => a + ':' + b;

// What a hero's always-on skills do to other skills' ops.
class _Edits {
  constructor(sources, tables) {
    this.enabled = new Map(); this.disabled = new Set();
    this.add = new Map(); this.ratio = new Map(); this.by = new Map();
    this.changed = new Map(); this.maxStack = new Map();
    // skill -> [[ModSkill | ModSkillR, record/op field, op no, TriggerTimeMs slot, delta]]
    this.timing = new Map();
    const skills = tables.skills || {};
    for (const src of sources)
      for (const op of _ops(skills[String(src)] || {}))
        if (_truthy(op)) this._read(src, op);
  }
  _read(src, op) {
    const kind = op.Type;
    const v = op.Values || [];
    const [first, second] = v.length >= 2 ? [_int(v[0]), _int(v[1])] : [null, null];
    const key = first !== null && second !== null ? _key(first, second) : null;
    if (kind === 'ModSkillEnabled' && key) {
      this.enabled.set(key, src);
    } else if (kind === 'ModSkillDisabled' && key) {
      this.disabled.add(key);
    } else if ((kind === 'ModSkill' || kind === 'ModSkillR') && key && v.length >= 4 && Object.hasOwn(_TIMING_FIELDS, v[2])) {
      const raw = String(v[3] ?? '').trim();
      if (!_NUMBER.test(raw)) return;
      const slot = v.length >= 5 ? _int(v[4]) : null;
      if (!this.timing.has(first)) this.timing.set(first, []);
      this.timing.get(first).push([kind, _TIMING_FIELDS[v[2]], second, slot, parseFloat(raw)]);
    } else if ((kind === 'ModSkill' || kind === 'ModSkillR') && key && v.length >= 4) {
      if (!(v[2] === 'ModStatAddValue' || (v[2] === 'Value' && v.length >= 5 && String(v[4]) === '1'))) return;
      const raw = String(v[3] ?? '').trim();
      if (!_NUMBER.test(raw)) return;
      const bucket = kind === 'ModSkill' ? this.add : this.ratio;
      bucket.set(key, (bucket.get(key) || 0) + parseFloat(raw));
      this.by.set(key, src);
    } else if (kind === 'ChangeSkill' && key) {
      this.changed.set(first, second);
    } else if (kind === 'ModStateMaxStack' && second !== null) {
      this.maxStack.set(String(v[0]), (this.maxStack.get(String(v[0])) || 0) + second);
    }
  }
  isOn(key, op) {
    if (this.disabled.has(key)) return false;
    return this.enabled.has(key) || !String(op.Flag || '').includes('Disabled');
  }
  // skills with these masteries' timing edits applied (see _retimed); the same object when there
  // are none.
  timed(skills) {
    if (!this.timing.size) return skills;
    const out = { ...skills };
    for (const [sid, mods] of this.timing)
      if (Object.hasOwn(skills, String(sid))) out[String(sid)] = _retimed(skills[String(sid)], mods);
    return out;
  }
}

// A table number after ModSkill adds, then ModSkillR ratios (per-mille), in whole units and its own
// type (the data mixes "30000" and 30000). Left alone when it isn't a plain number — Speed
// Mirage's chance is an expression — or is the data's forever.
function _retime(value, mods) {
  const base = _int(value);
  if (!mods.length || base === null || base >= _FOREVER_MS) return value;
  const add = mods.reduce((s, [kind, d]) => (kind === 'ModSkill' ? s + d : s), 0);
  const ratio = mods.reduce((s, [kind, d]) => (kind === 'ModSkillR' ? s + d : s), 0);
  const next = Math.max(Math.trunc((base + add) * (1000 + ratio) / 1000), 0);
  return typeof value === 'string' ? String(next) : next;
}

// A copy of record with a hero's mastery timing edits applied: cooldown (Magic Guard - Reuse: 30s
// -> 21s), proc chance (Venom - Chance: 50% -> 60%), each timer slot (Night Lord's Mark: every
// 2.5s -> 2s) and op durations — op 0, which no record uses, meaning all of them (Sharp Eyes -
// Persistence: 18s -> 27s). They change no value, but the descriptions read them, and so does
// whether a stacking state re-applies (_reapplied).
function _retimed(record, mods) {
  const pick = test => mods.filter(test).map(([kind, , , , delta]) => [kind, delta]);
  record = { ...record };
  for (const field of ['CoolTimeMs', 'TriggerRatio'])
    if (Object.hasOwn(record, field)) record[field] = _retime(record[field], pick(m => m[1] === field));
  if (Array.isArray(record.TriggerTimeMs))
    record.TriggerTimeMs = record.TriggerTimeMs.map((t, i) => _retime(t, pick(m => m[1] === 'TriggerTimeMs' && m[3] === i)));
  const ops = [..._ops(record)];
  ops.forEach((op, no) => {
    if (_truthy(op) && Object.hasOwn(op, 'DurationMs'))
      ops[no] = { ...op, DurationMs: _retime(op.DurationMs, pick(m => m[1] === 'DurationMs' && (m[2] === 0 || m[2] === no))) };
  });
  if (Object.hasOwn(record, 'Operations')) record.Operations = ops;
  return record;
}

// Scale an op amount by its skill level (slot 1 of ValueLevelFactors), to 0.1.
function _scaled(value, levelFactors, level, tables) {
  let col = null;
  const pairs = levelFactors || [];
  for (let i = 0; i < pairs.length - 1; i += 2)
    if (String(pairs[i]) === '1') { col = parseInt(pairs[i + 1], 10); break; }
  if (col === null) return value;
  const row = (tables.skillLevelFactor || {})[String(level)];
  const factor = row && col < row.length ? row[col] : 1000;
  const r = Math.floor(Math.abs(value) * factor / 1000 * 10) / 10;
  return value < 0 ? -r : r;
}

// Who an op lands on: 'self', 'ally' or 'enemy'.
function _side(record, op) {
  const ops = _ops(record);
  const fallback = _SIDE[String(record.SkillTargetType)] || 'enemy';
  for (let n = 0; n <= ops.length; n++) {
    const target = op.TargetType;
    if (target === 'Parent') {
      const parentNo = op.ParentOperationNo;
      if (!Number.isInteger(parentNo) || parentNo < 0 || parentNo >= ops.length || !_truthy(ops[parentNo]))
        return fallback;
      op = ops[parentNo];
      if (_HIT_OPS.some(p => String(op.Type).startsWith(p))) return 'enemy';
      continue;
    }
    if (target === undefined || target === null || _AREA_ANCHORS.has(target) || _truthy(op.RectAreaMm) || _truthy(op.RadiusMm))
      return fallback;
    return _SIDE[target] || fallback;
  }
  return fallback;
}

// How many times one cast runs op no: once per TickTimeMs entry that fires it (Swift Fire's three
// bullets are ["200", "400", "600"]). An op landing on whoever its parent hit (ParentOperationNo)
// runs as often as that parent. 1 without ticks.
function _runs(record, no) {
  const ops = _ops(record);
  for (let n = 0; n < ops.length; n++) {  // bounded: a Parent chain can't be longer than the op list
    const parent = no >= 0 && no < ops.length && _truthy(ops[no]) ? ops[no].ParentOperationNo : undefined;
    if (!Number.isInteger(parent) || parent === no) break;
    no = parent;
  }
  let runs = 0;
  for (const tick of record.TickTimeMs || []) {
    const m = _TICK.exec(String(tick));
    if (m && (m[1] === undefined || m[1].split(':').map(_int).includes(no))) runs++;
  }
  return Math.max(runs, 1);
}

function _secs(ms) { return _g((_int(ms) || 0) / 1000) + 's'; }

// An op's duration, or the duration of the op it lasts as long as (WatchOperationNo).
function _durationMs(op, ops) {
  if (op.DurationMs !== undefined && op.DurationMs !== null) return op.DurationMs;
  const watch = op.WatchOperationNo;
  if (Number.isInteger(watch) && watch >= 0 && watch < ops.length && _truthy(ops[watch])) return ops[watch].DurationMs ?? null;
  return null;
}

// Whether op can land again before an earlier application lapses — so a stacking state builds to
// its cap over the fight, not just what one firing lands. What paces it is the nearest record on
// the chain that fires on its own: a proc or timer re-fires as often as its cooldown (or period)
// allows, a cast as often as its cooldown, and an OnStart record only once. Focused Fury (+3 Acc
// for 6s after every skill cast) and Silver Pendant (15% per attack, 5s) re-apply; Swift Fire's
// 17s cooldown outlasts its 8s debuff, so only what one cast lands counts.
function _reapplied(hops, record, op) {
  const duration = _int(_durationMs(op, _ops(record)));
  if (!duration) return false;
  const chain = [...hops.map(h => h.record), record];
  let start = 0;
  for (let i = chain.length - 1; i >= 0; i--) if (_truthy(chain[i].TriggerType)) { start = i; break; }
  const trigger = chain[start].TriggerType;
  if (trigger === 'OnStart' || trigger === 'OnWaveStart') return false;
  let gap = Math.max(...chain.slice(start).map(r => _int(r.CoolTimeMs) || 0));
  if (trigger === 'OnTimer') {
    const period = _pushedBack(chain[start]) || _int((chain[start].TriggerTimeMs || [null])[0]) || 0;
    gap = Math.max(gap, period);
  }
  return gap < duration;
}

// Up for the rest of the fight: its own duration says so, and any op it lasts as long as
// (WatchOperationNo) is itself rest-of-fight and unconditional. Cursed Doll's Acc has no duration
// of its own and rides a rest-of-fight UsePassiveSkill; Crossbones' pierce rides a 12s buff.
function _lastsWholeFight(op, ops) {
  const own = op.DurationMs;
  if (own !== undefined && own !== null && (_int(own) || 0) < _FOREVER_MS) return false;
  const watch = op.WatchOperationNo;
  if (!_truthy(watch)) return own !== undefined && own !== null;
  if (!(Number.isInteger(watch) && watch >= 0 && watch < ops.length && _truthy(ops[watch]))) return false;
  const watched = ops[watch];
  return (_int(watched.DurationMs) || 0) >= _FOREVER_MS
    && pvpTruth(watched.EnableCondition) === true
    && !String(watched.Flag || '').includes('WatchCondition');
}

// A granted passive that RemovePassiveSkills itself fires once (Dark Evasion's CC guard).
function _removesItself(record) {
  const me = String(record.SkillIndex);
  return _ops(record).some(op => _truthy(op) && op.Type === 'RemovePassiveSkill'
    && (op.Values || []).map(String).includes(me));
}

// How far a timer pushes its own next trigger after firing (ModRemainTriggerTime naming itself),
// which is then its real period — the data's forever makes it a one-shot opener (Enrage,
// Elemental Adaptation). null when it doesn't.
function _pushedBack(record) {
  const me = String(record.SkillIndex);
  for (const op of _ops(record)) {
    const values = ((op || {}).Values || []).map(String);
    if (_truthy(op) && op.Type === 'ModRemainTriggerTime' && values[0] === me && values.length > 1) return _int(values[1]);
  }
  return null;
}

// A skill's name, or its parent's for an unnamed follow-up (92041 -> Assassin's Mark).
function _named(skillId, tables) {
  const names = tables.skillNames || {};
  if (Object.hasOwn(names, String(skillId))) return names[String(skillId)];
  const parent = _int(((tables.skills || {})[String(skillId)] || {}).FollowLevelIndex);
  return parent !== null ? (names[String(parent)] ?? null) : null;
}

// How record fires: "on cast", "every 15s", "25% on hit", "after casting Octopunch"... lasts is the
// duration of the op being described when it sits on this record (null otherwise): a timer
// re-applying it before it lapses reads "continuously" (Icy Soul Rock), and one re-applying a
// rest-of-fight op is a periodic re-check (Ring of Cycles).
function _triggerText(record, tables, lasts) {
  const trigger = record.TriggerType;
  const ratio = _int(record.TriggerRatio) || 1000;
  const chance = ratio < 1000 ? _g(ratio / 10) + '% ' : '';
  const cond = record.TriggerCondition || '';
  const by = _TRIGGER_SKILL.exec(cond);
  const named = by ? _named(parseInt(by[1], 10), tables) : null;
  let text;
  if (trigger === 'OnStart') text = 'from the start';
  else if (trigger === 'OnWaveStart') text = 'at battle start';  // the game's own wording (Rainbow-colored Snail Shell)
  else if (trigger === 'OnTimer') {
    const times = _truthy(record.TriggerTimeMs) ? record.TriggerTimeMs : [null];
    const every = times[0], period = _int(times[0]), dur = _int(lasts);
    const pushed = _pushedBack(record);
    if (pushed !== null && pushed >= _FOREVER_MS) text = 'at the start';
    else if (pushed) text = 'every ' + _secs(pushed);
    else if (dur !== null && dur >= _FOREVER_MS) text = _truthy(every) ? 're-checked every ' + _secs(every) : 'on a timer';
    else if (period && dur && period <= dur && times.length === 2) text = 'continuously';
    else text = _truthy(every) ? 'every ' + _secs(every) : 'on a timer';
  } else if (trigger === 'OnAttack' || trigger === 'OnHit') text = named ? `${chance}when ${named} hits` : chance + 'on hit';
  else if (trigger === 'OnTryAttack') text = chance + 'on attack';
  else if (trigger === 'OnDamage') text = chance + 'when hit';
  else if (trigger === 'OnActiveSkill') text = named ? `after casting ${named}` : 'after casting a skill';
  else if (trigger === 'OnState') {
    text = cond.includes('StateAttrFlag.CC') ? 'when crowd-controlled'
      : cond.includes('StateAttrFlag.Debuff') ? 'when debuffed' : 'on a status change';
  } else if (trigger === 'OnMiss') text = chance + 'when you miss';
  else if (trigger === undefined || trigger === null) text = 'on cast';
  else text = chance + 'on ' + trigger.replace(/^On/, '').toLowerCase();
  if (_removesItself(record)) text += ' (once)';
  return text;
}

// How long the skill's own state lasts: the finite duration of the op applying it.
function _stateLife(state, records) {
  for (const record of records)
    for (const op of _ops(record)) {
      const dur = _int((op || {}).DurationMs);
      if (_truthy(op) && op.State === state && dur && dur < _FOREVER_MS) return dur;
    }
  return null;
}

// Readable text for what a condition waits on; [] when there is nothing worth saying. Clauses an
// arena fight settles (pvpTruth), the trigger's own skill/CC test (in its trigger text), a guard
// against re-applying a state the skill itself applies (Venom, Cursed Doll) and a "while my state
// is up" bound (its duration is shown instead) all read as nothing.
function _conditionPhrases(cond, ownStates, records) {
  const phrases = [];
  for (let clause of (cond || '').split(/&&|\|\|/)) {
    clause = clause.trim();
    if (!clause || pvpTruth(clause) !== null) continue;
    if (clause.includes('$Trigger.SkillIndex') || clause.includes('StateAttrFlag.')) continue;
    const sc = _STATE_COUNT.exec(clause);
    if (sc && ownStates.has(sc[1]) && (sc[2] === '==' || sc[2] === '<' || _stateLife(sc[1], records))) continue;
    let phrase;
    const hp = /#HpRatioLess\((\d+)\)/.exec(clause);
    const final = _FINAL_STAT_COND.exec(clause);
    if (hp) phrase = `HP < ${_g(parseInt(hp[1], 10) / 10)}%`;
    else if (final && final[1].toLowerCase() in _FINAL_STAT_NAMES) {
      const cmp = { '>=': '≥', '<=': '≤' }[final[2]] || final[2];
      phrase = `${_FINAL_STAT_NAMES[final[1].toLowerCase()]} ${cmp} ${_g(parseInt(final[3], 10) / 10)}%`;
    } else if (clause.includes('AttrStateCount(TargetCreature;Buff)')) phrase = 'vs a buffed target';
    else if (clause.includes('AttrStateCount(TargetCreature;CC)')) phrase = 'vs a crowd-controlled target';
    else phrase = 'situational';
    if (!phrases.includes(phrase)) phrases.push(phrase);
  }
  return phrases;
}

// Short text for when a conditional effect is up, read along the chain from the learned skill to
// the op: "on cast, for 15s: 35% on hit, 10s, 30s cd". records is the learned skill's whole family
// and ownStates every state it applies — for a state-bound buff's duration and for telling a
// skill's own guards from real conditions. stackNote says how many stacks of a stacking state the
// value counts ("at 10 stacks", "stacks 3× per cast").
function _when(hops, record, op, tables, stacks, state, records, ownStates, stackNote = '') {
  const chain = [...hops.map(h => h.record), record];
  const duration = _durationMs(op, _ops(record));
  const forever = duration !== null && (_int(duration) || 0) >= _FOREVER_MS;

  let parts = [_triggerText(chain[0], tables, chain.length === 1 ? duration : null)];
  hops.forEach((hop, i) => {
    const nxt = chain[i + 1];
    if (hop.projectile !== null) {
      const moving = !_truthy(hop.projectile.IsTouchType) && !_truthy(hop.projectile.TickTimeMs);
      parts.push(moving ? 'when it hits' : hop.projectile.FollowTargetType === 'Myself' ? 'near the caster' : 'in its area');
    } else if (hop.op.Type === 'UsePassiveSkill') {
      const window = _int(_durationMs(hop.op, _ops(hop.record)));
      if (window && window < _FOREVER_MS) parts.push('for ' + _secs(window));
    }
    if (_truthy(nxt.TriggerType)) {  // a granted passive firing on its own trigger
      const text = _triggerText(nxt, tables, nxt === record ? duration : null);
      if (parts[parts.length - 1].startsWith('for ')) parts[parts.length - 1] += ': ' + text;
      else parts.push('then ' + text);
    }
  });
  // An always-on lead says nothing once something more specific follows it.
  if (parts.length > 1 && parts[0] === 'from the start') parts = [parts[1].replace(/^then /, ''), ...parts.slice(2)];

  const touch = [...hops].reverse().map(h => h.projectile)
    .find(p => _truthy(p) && _truthy(p.IsTouchType)) || null;
  const bound = _STATE_COUNT.exec(op.EnableCondition || '');
  const stateLife = bound && (bound[2] === '>' || bound[2] === '>=') && String(op.Flag || '').includes('ExpireOnConditionFail')
    ? _stateLife(bound[1], records) : null;
  if (forever && touch !== null) {
    // A touch area holds its debuff only while the target stands in it.
    const life = _int(touch.DurationTimeMs) || 0;
    if (life && life < _FOREVER_MS) parts.push('up to ' + _secs(life));
  } else if (forever && stateLife) parts.push(_secs(stateLife));
  else if (forever) {
    if (!parts.some(p => p.startsWith('re-checked'))) parts.push('rest of fight');
  } else if (_truthy(duration) && !parts.some(p => p.endsWith('continuously'))) parts.push(_secs(duration));

  if (stacks) parts.push(state && !/^\d+$/.test(state) ? `at ${stacks} ${state} stacks` : `at ${stacks} stacks`);
  if (stackNote) parts.push(stackNote);
  for (const cond of [op.EnableCondition, ...chain.map(r => r.TriggerCondition)])
    for (const p of _conditionPhrases(cond, ownStates, records)) if (!parts.includes(p)) parts.push(p);
  for (const r of chain) {
    const cooldown = _int(r.CoolTimeMs);
    if (cooldown && (r === chain[0] || _truthy(r.TriggerType)))
      parts.push(cooldown >= _FOREVER_MS ? 'once per fight' : _secs(cooldown) + ' cd');
  }
  return parts.join(', ');
}

// [roots, alwaysOn, levels] for one hero: every skill it can use in a fight, the always-on
// subset (passives, masteries, guild skills — whose edits apply), and each skill's level.
function _heroRoots(hero) {
  const levels = new Map();
  for (const info of [...(hero.ActiveSkillLearnedInfos || []), ...(hero.PassiveSkillLearnedInfos || [])]) {
    const sid = _int((info || {}).SkillIndex);
    if (sid !== null) levels.set(sid, Math.max(_int(info.SkillLevel) || 1, 1));
  }
  const slotted = [];
  for (const info of hero.ActiveSkillLearnedInfosInSlot || []) {
    const sid = _int((info || {}).SkillIndex);
    if (sid !== null && !slotted.includes(sid)) {
      slotted.push(sid);
      if (_truthy(info.SkillLevel)) levels.set(sid, Math.max(_int(info.SkillLevel) || 1, 1));
    }
  }
  const alwaysOn = [];
  for (const info of hero.PassiveSkillLearnedInfos || []) {
    const sid = _int((info || {}).SkillIndex);
    if (sid !== null) alwaysOn.push(sid);
  }
  for (const buff of hero.BuffInput?.HeroBuffInfoContainer?.BuffInfos || []) {
    if (!_SKILL_BUFF_TYPES.includes(buff.BuffType)) continue;
    for (const [skillId, level] of Object.entries(buff.PassiveSkillLevels || {})) {
      const sid = _int(skillId);
      if (sid !== null && !alwaysOn.includes(sid)) {
        alwaysOn.push(sid);
        if (!levels.has(sid)) levels.set(sid, Math.max(_int(level) || 1, 1));
      }
    }
  }
  return [[...slotted, ...alwaysOn], alwaysOn, levels];
}

// Every effect one hero's skills have on a SKILL_STATS stat, for an arena fight. Each is
// { stat, value, side, permanent, skill, source, via, state, when, scalesWith } — see
// skill_effects.SkillEffect. A conversion ("#GetFinalStatRatio(CriticalChance;420)") comes back
// with scalesWith set and value = the per-mille share, for the caller to take at the hero's total.
// finals (the hero's standing totals, see pvpTruth) can only drop effects, never make one
// permanent, so the totals don't depend on it.
function heroSkillEffects(hero, tables, finals = null) {
  if (!tables.skills || !Object.keys(tables.skills).length) return [];
  const [roots, alwaysOn, levels] = _heroRoots(hero);
  const edits = new _Edits(alwaysOn, tables);
  tables = { ...tables, skills: edits.timed(tables.skills) };
  const stateMax = tables.stateMaxStack || {};
  const effects = [];
  const done = new Set();  // a follow-up two roots share (a skill and its aura mastery) is one buff
  for (const root of roots) {
    const walked = edits.changed.has(root) ? edits.changed.get(root) : root;
    const family = [..._walk(walked, tables)];
    const records = family.map(([, record]) => record);
    const ownStates = new Set();
    for (const record of records) for (const op of _ops(record)) if (_truthy(op) && _truthy(op.State)) ownStates.add(op.State);
    for (const [sid, record, fromStart, hops] of family) {
      if (done.has(sid)) continue;
      done.add(sid);
      const follow = _int(record.FollowLevelIndex) || root;
      const level = levels.has(follow) ? levels.get(follow) : (levels.has(root) ? levels.get(root) : 1);
      const ops = _ops(record);
      ops.forEach((op, no) => {
        if (!_truthy(op) || !_STAT_OPS.has(op.Type)) return;
        const values = op.Values || [];
        const stat = values.length ? _SKILL_CANON[String(values[0]).toLowerCase()] : undefined;
        const key = _key(sid, no);
        if (!stat || !edits.isOn(key, op)) return;
        // Skips the creature it centres on; one hero a side leaves nobody else (Sharp Eyes' ally copy).
        if (String(op.Flag || '').includes('ExcludeTarget')) return;
        const enabledBy = edits.enabled.get(key);
        const truth = [pvpTruth(op.EnableCondition, finals), pvpTruth(record.TriggerCondition, finals)];
        if (truth.includes(false)) return;  // never holds in an arena fight (boss-only, guild-raid-only)
        const raw = values.length > 1 ? String(values[1]).trim() : '0';
        let stackState = null;
        let scalesWith = null;
        let amount;
        if (_NUMBER.test(raw)) {
          amount = parseFloat(raw);
        } else {
          const ratio = _FINAL_RATIO.exec(raw);
          const perStack = ratio ? null : _PER_STACK.exec(raw);
          if (ratio) {
            scalesWith = _SKILL_CANON[(ratio[1] || ratio[3]).toLowerCase()] || null;
            if (!scalesWith) return;  // a share of a stat we don't total; skip rather than guess
            amount = parseFloat(ratio[2] || ratio[4]);
          } else if (perStack) {
            stackState = perStack[1];
            amount = perStack[2] !== undefined ? -parseFloat(perStack[2]) : parseFloat(perStack[3]);
          } else {
            return;  // an expression we can't evaluate; skip rather than guess
          }
        }
        amount += edits.add.get(key) || 0;
        amount = _scaled(amount, op.ValueLevelFactors, level, tables);
        amount *= 1 + (edits.ratio.get(key) || 0) / 1000;
        let stacks = null;
        if (stackState) {
          stacks = Math.max(_int(stateMax[stackState]) || 1, 1) + (edits.maxStack.get(stackState) || 0);
          amount *= stacks;
        }
        // Each landing of a stacking state's op adds a stack, up to its cap: Swift Fire's three
        // bullets land three SwiftFire_Weakness stacks (MaxStack 3), and a proc that re-fires before
        // its stacks lapse builds to the cap (Focused Fury: 10).
        let stackNote = '';
        const applied = op.State;
        if (_truthy(applied) && stackState === null) {
          const cap = Math.max(_int(stateMax[applied]) || 1, 1) + (edits.maxStack.get(applied) || 0);
          let layers;
          if (cap > 1 && _reapplied(hops, record, op)) {
            layers = cap;
            stackNote = `at ${cap} stacks`;
          } else {
            layers = Math.min(_runs(record, no), cap);
            stackNote = layers > 1 ? `stacks ${layers}× per cast` : '';
          }
          amount *= layers;
        }
        if (!amount) return;
        const side = _side(record, op);
        // A WatchCondition op re-tests its condition; once the arena settles that condition
        // (no null in truth), it holds all fight (Reindeer's Spear's one-target pierce).
        const permanent = side === 'self' && fromStart && !truth.includes(null) && stacks === null
          && op.Type !== 'ModStatOnTick'
          && _lastsWholeFight(op, ops)
          && (_int(record.TriggerRatio) || 1000) >= 1000;
        const via = enabledBy !== undefined ? enabledBy : edits.by.get(key);
        const when = permanent ? '' : _when(hops, record, op, tables, stacks, stackState, records, ownStates, stackNote);
        // An op riding another's lifetime is that buff (Enrage's crit damage rides "Enrage").
        const watch = op.WatchOperationNo;
        const watched = Number.isInteger(watch) && watch >= 0 && watch < ops.length && _truthy(ops[watch]) ? ops[watch] : {};
        effects.push({
          stat: op.Type === 'ModStatR' ? stat + 'R' : stat,
          value: amount,
          side,
          permanent,
          skill: root,
          source: sid,
          via: via === undefined || via === null || via === root || via === sid ? null : via,
          state: op.State || watched.State || null,
          when: side === 'ally' ? 'ally buff, ' + when : when,
          scalesWith,
        });
      });
    }
  }
  return effects;
}

// Map { slotted skill: note } for each slotted active that stuns in an arena fight. A stun is a
// Stun op anywhere in the skill's family (Evil Eye's sits on follow-up 32021), switched on by the
// hero's own masteries the same way stat ops are: Covering Fire, Bolt Burst, Shadow Spark and
// Spiraling Vortex ship theirs Flag: Disabled until their "- Stun" mastery is learned, and a
// ChangeSkill mastery swaps in what the slot casts. The note reads "Stuns 1s", plus the mastery's
// name when one is what makes it stun.
function heroStuns(hero, tables) {
  const notes = new Map();
  if (!tables.skills || !Object.keys(tables.skills).length) return notes;
  const [, alwaysOn] = _heroRoots(hero);
  const edits = new _Edits(alwaysOn, tables);
  tables = { ...tables, skills: edits.timed(tables.skills) };
  for (const info of hero.ActiveSkillLearnedInfosInSlot || []) {
    const root = _int((info || {}).SkillIndex);
    if (root === null || notes.has(root)) continue;
    family: for (const [sid, record] of _family(edits.changed.has(root) ? edits.changed.get(root) : root, tables)) {
      const ops = _ops(record);
      for (let no = 0; no < ops.length; no++) {
        const op = ops[no];
        if (!_truthy(op) || op.Type !== 'Stun' || !edits.isOn(_key(sid, no), op)) continue;
        if (pvpTruth(op.EnableCondition) === false || pvpTruth(record.TriggerCondition) === false)
          continue;  // boss-only / guild-raid-only: never in an arena fight
        const duration = _int(op.DurationMs) ? ' ' + _secs(op.DurationMs) : '';
        const via = edits.enabled.get(_key(sid, no));
        notes.set(root, 'Stuns' + duration + (via !== undefined ? ` (${skillName(via, tables)})` : ''));
        break family;
      }
    }
  }
  return notes;
}

function skillName(skillId, tables) {
  return (tables.skillNames || {})[String(skillId)] || `skill ${skillId}`;
}

// A skill's "<Atlas>:<Sprite>" icon path. Most SkillTable rows leave SkillIconPath out, and the
// client then falls back to SkillIcon:<SkillIndex> (SkillData.GetSkillIconPath, literal
// "SkillIcon:{0}"), so this does too.
function skillIcon(skillId, tables) {
  return ((tables.skills || {})[String(skillId)] || {}).SkillIconPath || `SkillIcon:${skillId}`;
}
