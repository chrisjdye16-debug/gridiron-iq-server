'use strict';
/* ============================================================
   GRIDIRON IQ — Server-side film analysis engine
   Upload film (or paste a direct video URL). The server:
   1. extracts frames with ffmpeg
   2. detects live snaps with a fast AI pass (Haiku)
   3. runs a full 2-pass breakdown of every play (Opus/Sonnet)
   4. stores every play; the frontend streams them into analytics
   ============================================================ */
const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL_FULL = process.env.MODEL_FULL || 'claude-opus-4-8';
const MODEL_SCAN = process.env.MODEL_SCAN || 'claude-haiku-4-5-20251001';
const TWO_PASS = (process.env.TWO_PASS || 'true') === 'true';
const SCAN_STEP = parseInt(process.env.SCAN_STEP || '12', 10);   // seconds between scans
const POST_SKIP = parseInt(process.env.POST_SKIP || '26', 10);   // skip after a charted play
const MAX_PLAYS = parseInt(process.env.MAX_PLAYS || '250', 10);
const DATA_DIR = process.env.DATA_DIR || '/tmp/gridiron';
const WORK_DIR = path.join(DATA_DIR, 'work');   // scratch frames only — never film, never plays
fs.mkdirSync(WORK_DIR, { recursive: true });

/* ============================================================================
   MULTI-TENANT — one site, one school per path (/acu, /<school>, …)

   THE THING THAT MATTERS: the schools on this box play each other — same league,
   same conference. If a bug ever lets one program read another's charted
   film, that is not a support ticket — it ends the product. So tenancy is not a
   URL prefix bolted onto shared state; every tenant gets its own directory, its
   own plays file, its own film, its own clips, and its own signed session whose
   token is bound to that tenant. There is no code path that reads plays without
   naming a tenant, because there is no global PLAYS array anymore.

     DATA_DIR/tenants/<team>/plays.json
     DATA_DIR/tenants/<team>/film/
     DATA_DIR/tenants/<team>/clips/

   Passwords are per school: TEAM_PASSWORD_<ID>, e.g. TEAM_PASSWORD_ACU.
   A session minted for one school cannot open another's data — the team is inside
   the signature, not just the cookie name.
   ========================================================================= */
const TEAMS_FILE = path.join(__dirname, 'teams.json');
let TEAMS = {};
try {
  TEAMS = JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  delete TEAMS._readme;
} catch (e) { console.error('teams.json missing or invalid — no schools configured.'); }

const TENANT_IDS = Object.keys(TEAMS);
const isTenant = id => Object.prototype.hasOwnProperty.call(TEAMS, id);

const T = {};   // team id -> live state
function tenant(id) {
  if (T[id]) return T[id];
  const dir = path.join(DATA_DIR, 'tenants', id);
  const t = {
    id,
    dir,
    playsFile: path.join(dir, 'plays.json'),
    filmDir: path.join(dir, 'film'),
    clipDir: path.join(dir, 'clips'),
    PLAYS: [],
    JOBS: {},
    QUEUE: [],
    active: null,
    lastFilm: null,
  };
  fs.mkdirSync(t.filmDir, { recursive: true });
  fs.mkdirSync(t.clipDir, { recursive: true });
  try { t.PLAYS = JSON.parse(fs.readFileSync(t.playsFile, 'utf8')); } catch (e) {}
  T[id] = t;
  return t;
}
const savePlays = t => fs.writeFileSync(t.playsFile, JSON.stringify(t.PLAYS));
TENANT_IDS.forEach(tenant);   // warm every school on boot

/* ---------------- football dictionaries (kept in sync with frontend) ---------------- */
const FORMATIONS = ['Gun Trips Rt','Gun Trips Lt','Gun Spread 2x2','Gun Empty','Gun Bunch Rt','I-Form','Singleback Ace','Pistol Strong','Gun Wing Lt','Heavy Goal Line','Kickoff','Punt','Field Goal'];
const ROUTES = ['Hitch','Slant','Out','Dig','Comeback','Curl','Post','Corner','Go','Wheel','Drag','Screen','Flat','Seam','Block'];
const RUN_CONCEPTS = ['Inside Zone','Outside Zone','Power','Counter','Trap','Draw','Jet Sweep','QB Keep','Iso','Toss'];
const PASS_CONCEPTS = ['Mesh','Smash','Flood','Four Verts','Stick','Y-Cross','Shallow','Spacing','Dagger','Screen Game'];
const ST_CONCEPTS = ['Kickoff Return','Punt Return','Field Goal/XP','Onside Kick','Fake Punt','Fake FG'];
const FRONTS = ['4-3 Over','4-3 Under','3-4 Okie','Nickel 4-2-5','Dime 4-1-6','Bear 46','3-3 Stack','Goal Line 6-2'];
const COVERAGES = ['Cover 0','Cover 1','Cover 2','Cover 3','Cover 4 Quarters','Cover 6','2-Man','Tampa 2'];
const BLITZ_TYPES = ['None','Mike A-Gap','Will Edge','Sam Edge','Nickel Cat','Double A-Gap','Corner Cat','Safety Insert','Zero Pressure'];
const MOTIONS = ['None','Jet','Orbit','Short','Across','Shift TE'];
const PLAYTYPES = ['Run','Pass','RPO','Play Action','Screen'];
const PERSONNEL = {'Gun Trips Rt':'11','Gun Trips Lt':'11','Gun Spread 2x2':'10','Gun Empty':'00','Gun Bunch Rt':'11','I-Form':'21','Singleback Ace':'12','Pistol Strong':'12','Gun Wing Lt':'11','Heavy Goal Line':'22','Kickoff':'ST','Punt':'ST','Field Goal':'ST'};

const SNAP_SYS = `You classify single frames from football game film. Respond ONLY with JSON: {"live": true|false}. "live"=true ONLY if the frame shows a snap that is about to happen or has just happened in a real game: BOTH teams clearly aligned on opposite sides of a line of scrimmage with the offense set (linemen in stance), OR the ball in the first 1-2 seconds of a live play. Require a clear offensive formation set at the LOS. "live"=false for ALL of: pre-game warmups, players milling/stretching/jogging with no set formation, huddles, players walking between plays, teams not yet aligned, replays (slow-motion, zoomed isolations, replay wipes/graphics), crowd/sideline/coach/bench shots, commercials, halftime, full-screen score graphics, celebrations, injury stoppages, timeouts. When unsure, answer false.`;

const AI_SYS = `You are an elite NFL film analyst with 25 years of experience breaking down All-22 and broadcast film. You are given sequential frames of ONE football play: the first frames are pre-snap alignment, the rest show the play developing after the snap.

METHOD — follow this order strictly:
1. RUN vs PASS first, before anything else. Read the offensive line: linemen firing forward/down-blocking/pulling = RUN. Linemen pass-setting (kick-sliding backward, hands up) = PASS. Confirm with the QB (handoff or QB keep = run; dropback holding ball = pass) and where the ball carrier is.
2. ROUTES only if it is a PASS. On a RUN play, every WR/TE assignment is "Block" — NEVER output pass routes on a run play. Receivers stalk-blocking are "Block". Jet/orbit motion is motion, not a route. Play Action = pass.
3. COVERAGE: count deep safeties in the FIRST frames (pre-snap shell: 2-high, 1-high, 0-high), then watch whether they rotate after the snap. Report both.
4. VALIDITY: if the frames show a replay, slow-motion zoom, broadcast graphic, huddle, celebration, or anything that is not one continuous live play, set ALL confidences to 0 and say so in the summary. Never invent details you cannot see.

Respond with ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{
 "reasoning": <max 60 words: what the OL did, what the QB did, where the ball went, what the safeties did>,
 "situation": {"quarter": <1-4 or null>, "down": <1-4 or null>, "dist": <number or null>, "yardLine": <1-99 measured from offense's own goal line, or null>, "hash": <"L","M","R" or null>} — READ the broadcast score bug whenever visible,
 "formation": <closest match from: ${FORMATIONS.join(', ')}>,
 "playType": <one of: ${PLAYTYPES.join(', ')}>,
 "concept": <from: ${RUN_CONCEPTS.join(', ')} OR ${PASS_CONCEPTS.join(', ')} OR ${ST_CONCEPTS.join(', ')}>,
 "motion": <one of: ${MOTIONS.join(', ')}>,
 "routes": {"X": <route>, "Z": <route>, "Y": <route>, "H": <route>, "RB": <route>} using only: ${ROUTES.join(', ')}, Run Path — include only positions you can identify,
 "defense": {"front": <closest from: ${FRONTS.join(', ')}>, "preSnapShell": <what safeties SHOWED pre-snap>, "postSnapCoverage": <closest from: ${COVERAGES.join(', ')}>, "rotation": <null or short description>, "blitz": <true/false>, "blitzType": <one of: ${BLITZ_TYPES.join(', ')}>, "blitzOrigin": <if blitz: "Field" (wide side), "Boundary" (short side), or "Interior" (A/B gap); else null>, "blitzPlayer": <if blitz: the position bringing pressure, e.g. "Mike LB","Will LB","Sam LB","Nickel","Strong Safety","Boundary Corner","Free Safety"; else null>, "rushers": <number>, "box": <number>},
 "result": {"gain": <estimated yards, integer>, "description": <short outcome>},
 "read": {"summary": <2-3 sentence scout-quality breakdown>, "keyObservations": [<3-5 short coach-relevant observations>], "confidence": {"formation": 0-1, "coverage": 0-1, "routes": 0-1}}
}
Rules: pick the CLOSEST allowed value when uncertain and lower the confidence. Omit unknown route positions rather than guessing.`;

const VERIFY_SYS = `You are the SENIOR film analyst double-checking a first-pass breakdown of the same play frames. Hunt specifically for: (1) pass routes reported on a RUN play; (2) wrong run/pass call; (3) pre-snap shell confused with post-snap coverage; (4) blitz miscount (5+ rushers = blitz); (5) situation misread; (6) invented details. If the first pass is fully correct, return it unchanged. Respond with ONLY the corrected JSON in the identical schema — no commentary.`;

/* ---------------- helpers ---------------- */
function run(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs || 120000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr ? String(stderr).slice(-400) : err.message));
      resolve(String(stdout));
    });
  });
}
async function ffprobeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(out.trim()) || 0;
}
async function extractFrame(file, t, outPath) {
  await run('ffmpeg', ['-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=1024:-2', '-q:v', '4', '-y', outPath]);
  return fs.readFileSync(outPath).toString('base64');
}
function nearest(val, list) {
  if (!val) return null;
  const v = String(val).toLowerCase();
  let hit = list.find(x => x.toLowerCase() === v); if (hit) return hit;
  hit = list.find(x => x.toLowerCase().includes(v) || v.includes(x.toLowerCase())); return hit || null;
}
async function callClaude(model, system, content, maxTok) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTok || 1800, system, messages: [{ role: 'user', content }] })
  });
  if (!res.ok) throw new Error('Anthropic API ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  let txt = (data.content && data.content[0] && data.content[0].text) || '';
  return txt.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
}
const img = b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });

async function classifyFrame(b64) {
  const txt = await callClaude(MODEL_SCAN, SNAP_SYS, [img(b64), { type: 'text', text: 'Classify this frame.' }], 60);
  const m = txt.match(/"live"\s*:\s*(true|false)/i);
  return m ? m[1].toLowerCase() === 'true' : false;
}
async function breakdown(frames) {
  const ctx = 'Frames are sequential through one play. Read the broadcast graphics for situation when visible. Analyze the play.';
  let j = JSON.parse(await callClaude(MODEL_FULL, AI_SYS, [...frames.map(img), { type: 'text', text: ctx }], 1800));
  if (TWO_PASS) {
    try {
      j = JSON.parse(await callClaude(MODEL_FULL, VERIFY_SYS, [...frames.map(img), { type: 'text', text: 'Context: ' + ctx + '\n\nFirst-pass breakdown to verify:\n' + JSON.stringify(j) }], 1800));
    } catch (e) { /* keep first pass */ }
  }
  return j;
}
/*
  HONESTY CONTRACT (do not "fix" this by adding defaults back):

  A field the model could not read is `null` — NEVER a plausible-looking guess.

  This used to silently coerce unreadable plays to Gun Spread 2x2 / Pass /
  Cover 3 / Nickel 4-2-5 / 1st & 10 at the 50. That doesn't lose information,
  it FABRICATES it: every unreadable snap cast a phantom vote for those exact
  values, systematically inflating them in the coverage donut, the formation
  bars, the front distribution and the D&D matrix. A coach game-planning off
  "they play Cover 3 on 40% of snaps" had no way to know how much of that 40%
  was really the engine shrugging.

  Null instead. Analytics skip nulls and report a denominator ("38 of 41 snaps
  read"). Unreadable fields land in `unknown[]` and flag the play for review,
  where a coach can correct it in one click. Showing our work is the product.
*/
const CORE_FIELDS = ['formation', 'playType', 'concept', 'coverage', 'front', 'down', 'dist'];
const LOW_CONF = 0.55; // below this, a read is a suggestion, not a fact

function toPlay(tn, j, videoT, jobId, filmSrc) {
  const st = j.situation || {}, d = j.defense || {}, rd = j.read || {}, conf = rd.confidence || {};
  const unknown = [];
  const u = (name, val) => { if (val === null || val === undefined) unknown.push(name); return val ?? null; };

  const formation = u('formation', nearest(j.formation, FORMATIONS));
  const isST = ['Kickoff', 'Punt', 'Field Goal'].includes(formation);
  const playType = u('playType', nearest(j.playType, PLAYTYPES));

  // HARD RULE 1: concept must match play type — no "Pass Inside Zone" mismatches.
  // If it can't be read, it stays null; we don't invent "Inside Zone"/"Stick".
  const rawConcept = nearest(j.concept, [...RUN_CONCEPTS, ...PASS_CONCEPTS, ...ST_CONCEPTS]);
  const conceptIsRun = RUN_CONCEPTS.includes(rawConcept);
  const conceptIsPass = PASS_CONCEPTS.includes(rawConcept);
  let concept = null;
  if (isST) concept = nearest(j.concept, ST_CONCEPTS);
  else if (playType === 'Run') concept = conceptIsRun ? rawConcept : null;
  else if (playType === 'Screen') concept = 'Screen Game';
  else if (playType) concept = conceptIsPass ? rawConcept : null; // Pass / PA / RPO
  u('concept', concept);

  // HARD RULE 2: on a run play, every receiver assignment is Block (no phantom routes)
  const routes = {};
  if (j.routes) for (const [pos, r] of Object.entries(j.routes)) {
    let rr = nearest(r, ['Run Path', ...ROUTES]);
    if (!rr) continue;
    if (playType === 'Run' && pos !== 'RB' && pos !== 'FB') rr = 'Block';
    routes[pos] = rr;
  }

  const blitz = typeof d.blitz === 'boolean' ? d.blitz : null;
  const gain = (j.result && typeof j.result.gain === 'number') ? Math.round(j.result.gain) : null;
  const inRange = (v, lo, hi) => (typeof v === 'number' && v >= lo && v <= hi) ? Math.round(v) : null;

  // Situation is read off the frames (scoreboard bug, chains, field markings).
  // On raw sideline film there is often no scoreboard at all — so these are the
  // fields most likely to be null, and the ones that most distort tendencies
  // when faked. Left null on purpose. The coach can set them in review.
  const down = u('down', inRange(st.down, 1, 4));
  const dist = u('dist', inRange(st.dist, 1, 40));

  const play = {
    id: tn.PLAYS.reduce((m, p) => Math.max(m, p.id), 0) + 1,   // ids are per-school
    jobId, videoT: Math.round(videoT),
    q: inRange(st.quarter, 1, 4),
    down, dist,
    yard: inRange(st.yardLine, 1, 99),
    hash: ['L', 'M', 'R'].includes(st.hash) ? st.hash : null,
    formation,
    personnel: formation ? (PERSONNEL[formation] || null) : null,
    motion: nearest(j.motion, MOTIONS), // null == not read; 'None' == read, no motion
    playType, concept,
    routes,
    front: u('front', nearest(d.front, FRONTS)),
    coverage: u('coverage', nearest(d.postSnapCoverage, COVERAGES)),
    preSnapShell: d.preSnapShell || null, rotation: d.rotation || null,
    blitz,
    blitzType: blitz ? (nearest(d.blitzType, BLITZ_TYPES) || null) : (blitz === false ? 'None' : null),
    blitzOrigin: blitz ? (d.blitzOrigin || null) : null,
    blitzPlayer: blitz ? (d.blitzPlayer || null) : null,
    rushers: inRange(d.rushers, 1, 11),
    box: inRange(d.box, 1, 11),
    gain, td: false, turnover: false,
    result: (j.result && j.result.description) ? j.result.description
          : (gain === null ? null : (gain >= 0 ? '+' + gain + ' yds' : gain + ' yds')),
    summary: rd.summary || '', observations: rd.keyObservations || [],
    confidence: conf,
    // bind the clip source to THIS job's film, in THIS tenant. Never a global —
    // a global "last film" would point one school's play at another's video.
    playlists: [], filmSrc: filmSrc || tn.lastFilm,

    // review metadata — drives the low-confidence queue and the "corrected" badge
    unknown,
    minConf: Math.min(...[conf.formation, conf.coverage, conf.routes].map(c => typeof c === 'number' ? c : 1)),
    corrected: false,
  };

  // Flag for human review if anything core is missing or any read is shaky.
  play.needsReview = unknown.some(f => CORE_FIELDS.includes(f)) || play.minConf < LOW_CONF;
  return play;
}

/* ---------------- jobs ---------------- */
/*
  FILM RETENTION, per school.

  processJob used to `fs.unlinkSync(file)` the uploaded film the moment charting
  finished — which silently broke /api/clip for every upload, because cutting a
  play clip means seeking back into the source video. Play cutups are the single
  biggest reason this runs on a real server instead of in a browser, and they
  were dead on the main intake path.

  Film now lives on the persistent disk, inside its own school's directory. Each
  school keeps its most recent KEEP_FILMS games; pruning one school never touches
  another's film.
*/
const KEEP_FILMS = parseInt(process.env.KEEP_FILMS || '5', 10);
function pruneFilm(tn) {
  try {
    const files = fs.readdirSync(tn.filmDir)
      .map(f => ({ f, p: path.join(tn.filmDir, f), t: fs.statSync(path.join(tn.filmDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(KEEP_FILMS).forEach(({ f, p }) => {
      try {
        fs.unlinkSync(p);
        const jid = f.split('.')[0];
        // drop that film's cached clips too — clips are regenerable, film isn't
        fs.readdirSync(tn.clipDir).forEach(c => {
          const play = tn.PLAYS.find(x => 'clip-' + x.id + '.mp4' === c);
          if (play && play.jobId === jid) { try { fs.unlinkSync(path.join(tn.clipDir, c)); } catch (e) {} }
        });
      } catch (e) {}
    });
  } catch (e) {}
}
const filmExists = src => !!src && (/^https?:\/\//.test(src) || fs.existsSync(src));

/*
  QUEUE — per school, and FAIR across schools.

  Frame extraction is CPU-bound, so the box still charts exactly one film at a
  time. But with several schools on one service, a naive global FIFO means
  Tarleton sits behind ACU's three-hour game. So the scheduler round-robins:
  each school has its own queue, and we take the next film from the school that
  has waited longest. One program can never starve another off the box.
*/
let RUNNING = null;   // {team, id} currently charting — one at a time, box-wide
let RR = 0;           // round-robin cursor across tenants

function enqueue(tn, id, file, isRemote) {
  tn.QUEUE.push({ id, file, isRemote });
  const job = tn.JOBS[id];
  job.status = 'queued';
  restatQueue();
  if (job.queuePos > 0) job.log.push('Queued — ' + job.queuePos + ' film(s) ahead of you.');
  pump();
}
function restatQueue() {
  // Position counts everything ahead of you across ALL schools, so the number a
  // coach sees is the truth about his wait, not a per-school fiction.
  let ahead = RUNNING ? 1 : 0;
  const ids = Object.keys(T);
  const depth = Math.max(...ids.map(k => T[k].QUEUE.length), 0);
  const order = [];
  for (let i = 0; i < depth; i++) for (const k of ids) if (T[k].QUEUE[i]) order.push(T[k].QUEUE[i].id);
  order.forEach((jid, i) => {
    for (const k of ids) if (T[k].JOBS[jid]) T[k].JOBS[jid].queuePos = i + ahead;
  });
}
function pump() {
  if (RUNNING) return;
  const ids = Object.keys(T).filter(k => T[k].QUEUE.length);
  if (!ids.length) return;
  const pick = ids[RR % ids.length];            // round-robin: fair across schools
  RR = (RR + 1) % Math.max(ids.length, 1);
  const tn = T[pick];
  const next = tn.QUEUE.shift();
  RUNNING = { team: pick, id: next.id };
  restatQueue();
  processJob(tn, next.id, next.file, next.isRemote)
    .catch(() => {})
    .finally(() => { RUNNING = null; restatQueue(); pump(); });
}

async function processJob(tn, id, file, isRemote) {
  const job = tn.JOBS[id];
  job.queuePos = 0;
  const log = m => { job.log.push('[' + new Date().toISOString().slice(11, 19) + '] ' + m); if (job.log.length > 400) job.log.shift(); };
  try {
    job.status = 'probing';
    if (isRemote) log('Streaming film directly (no full download) — reading frames on demand.');
    tn.lastFilm = file;   // per school — never a global
    const dur = await ffprobeDuration(file);
    if (!dur) throw new Error('Could not read video duration — unsupported file?');
    job.dur = Math.round(dur);
    log('Film loaded: ' + Math.round(dur / 60) + ' min. Scanning for snaps every ' + SCAN_STEP + 's.');
    job.status = 'processing';
    let t = 0, errs = 0;
    const tmp = path.join(WORK_DIR, id + '-f.jpg');
    while (t < dur - 4 && job.found < MAX_PLAYS && !job.cancel) {
      job.t = Math.round(t); job.scans++;
      let liveFlag = false;
      try {
        const frame = await extractFrame(file, t, tmp);
        liveFlag = await classifyFrame(frame);
        errs = 0;
        job.spentEst = +(job.scans * 0.002 + job.found * (TWO_PASS ? 0.06 : 0.03)).toFixed(2);
      } catch (e) {
        errs++; log('Scan error @' + Math.round(t) + 's: ' + e.message.slice(0, 160));
        if (errs >= 4) throw new Error('Repeated errors — aborting: ' + e.message.slice(0, 200));
        await new Promise(r => setTimeout(r, 2500)); continue;
      }
      if (liveFlag) {
        log('Snap detected @ ' + Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') + ' — running breakdown…');
        try {
          const offsets = [-1.2, -0.4, 0.5, 1.3, 2.2, 3.2, 4.2];
          const frames = [];
          for (const off of offsets) frames.push(await extractFrame(file, t + off, tmp));
          const j = await breakdown(frames);
          const conf = (j.read && j.read.confidence) || {};
          // require solid formation AND coverage confidence so junk/transition frames are rejected
          if ((conf.formation || 0) >= 0.45 && (conf.coverage || 0) >= 0.25) {
            const p = toPlay(tn, j, t, id, file);
            tn.PLAYS.push(p); savePlays(tn); job.found++;
            if (p.needsReview) job.review = (job.review || 0) + 1;
            const or_ = v => v == null ? '?' : v; // null reads print as '?', never as a guess
            log((p.needsReview ? '[review] ' : '[ok] ') + 'Play ' + job.found + ': ' + or_(p.formation) + ' · ' + or_(p.playType) + ' ' + or_(p.concept)
              + ' vs ' + or_(p.coverage) + (p.blitz ? ' +BLITZ' : '') + ' → ' + or_(p.result)
              + (p.needsReview ? '  [needs review: ' + (p.unknown.join(', ') || 'low confidence') + ']' : ''));
          } else log('Skipped low-confidence capture @' + Math.floor(t/60) + ':' + String(Math.floor(t%60)).padStart(2,'0') + ' (not a clean live snap).');
        } catch (e) { log('Breakdown error: ' + e.message.slice(0, 180)); }
        t += POST_SKIP;
      } else t += SCAN_STEP;
    }
    job.status = 'done'; job.t = job.dur;
    log('Finished: ' + job.found + ' plays charted from ' + job.scans + ' scans.'
      + (job.review ? '  ' + job.review + ' play(s) flagged for review.' : ''));
  } catch (e) {
    job.status = 'error'; job.error = e.message.slice(0, 300); log('Error: ' + job.error);
  } finally {
    // pump() releases the box in its .finally(), so a thrown job can't wedge the
    // queue shut. And we do NOT delete the film — /api/clip seeks back into it to
    // cut play cutups. Retention is pruneFilm(), scoped to this school.
    if (!isRemote) pruneFilm(tn);
  }
}


/* ============================================================================
   HTTP — every data route is scoped to a school: /api/:team/...

   AUTH. A coach's charted film is the most sensitive asset his program owns, and
   the schools on this box play each other. So:

     - Each school has its own password: TEAM_PASSWORD_<ID>
       (env var = TEAM_PASSWORD_ + upper-cased team id).
     - The session token is SIGNED WITH THE TEAM IN IT. A cookie minted for one
       school fails validation against another — you can't rename a cookie, replay
       one, or walk a path across the line. The team is inside the HMAC.
     - Cookies are per-team (giq_s_<id>).

   A school with no password set is OPEN, and says so — in its health payload and
   as a red bar across its UI. Silent insecurity is how a game plan ends up on a
   rival's screen.
   ========================================================================= */
const app = express();
app.use(express.json({ limit: '2mb' }));

// Declared up here on purpose: `upload.single(...)` is evaluated when the route
// is REGISTERED, not when it's called. Declaring it below the routes throws a
// TDZ ReferenceError at boot — which `node --check` happily passes.
const upload = multer({ dest: WORK_DIR, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const pwFor = id => process.env['TEAM_PASSWORD_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_')] || '';
const cookieFor = id => 'giq_s_' + id;

// The team is part of what we sign. This is the whole isolation guarantee.
const sign = (team, exp) => crypto.createHmac('sha256', SECRET).update(team + '|' + exp).digest('hex');
const makeToken = team => { const exp = Date.now() + 30 * 864e5; return `${exp}.${sign(team, exp)}`; };
function validToken(team, tok) {
  if (!tok) return false;
  const [exp, sig] = String(tok).split('.');
  if (!exp || !sig || Date.now() > +exp) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(team, exp));   // team-bound
  return a.length === b.length && crypto.timingSafeEqual(a, b);   // timing-safe
}
const readCookie = (req, id) => {
  const m = (req.headers.cookie || '').match(new RegExp(cookieFor(id) + '=([^;]+)'));
  return m ? m[1] : null;
};
const authed = (req, id) => !pwFor(id) || validToken(id, readCookie(req, id));

/* Resolve :team once, reject unknown schools, attach the tenant. Nothing
   downstream can touch data without having gone through here. */
function withTeam(req, res, next) {
  const id = String(req.params.team || '').toLowerCase();
  if (!isTenant(id)) return res.status(404).json({ error: 'No such team: ' + id });
  req.teamId = id;
  req.tn = tenant(id);
  next();
}
/* And nothing past this point runs without a session for THAT school. */
function requireAuth(req, res, next) {
  if (authed(req, req.teamId)) return next();
  res.status(401).json({ error: 'Not signed in.' });
}

const api = express.Router({ mergeParams: true });
app.use('/api/:team', withTeam, api);

/* ---- open before sign-in: only the door and the school's public branding ---- */
api.get('/auth', (req, res) => res.json({
  team: req.teamId,
  authRequired: !!pwFor(req.teamId),
  authed: authed(req, req.teamId),
}));
api.post('/login', (req, res) => {
  const want = pwFor(req.teamId);
  if (!want) return res.json({ ok: true, authRequired: false });
  const got = String((req.body || {}).password || '');
  const a = Buffer.from(want), b = Buffer.from(got);
  if (!(a.length === b.length && crypto.timingSafeEqual(a, b)))
    return res.status(401).json({ error: 'Wrong password.' });
  res.setHeader('Set-Cookie',
    `${cookieFor(req.teamId)}=${makeToken(req.teamId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 864e5 / 1000}` +
    (process.env.RENDER ? '; Secure' : ''));
  res.json({ ok: true });
});
api.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${cookieFor(req.teamId)}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});
/*
  Public: THIS school's name and brand colors, and nothing else.

  This used to also return `all` — every school on the box — so the UI could show
  a switcher. That was a demo feature that leaked into the product. A coach at ACU
  must never learn that another program is also a customer: it exposes the client list to
  a conference rival, and it makes his own tool look like a shared portal instead
  of his program's software. One school in, one school out. Never enumerate.
*/
api.get('/branding', (req, res) => res.json({
  active: req.teamId,
  team: TEAMS[req.teamId],
}));

/* ---- everything below requires a session for THIS school ---- */
api.use(requireAuth);

api.get('/schema', (req, res) => res.json({
  formations: FORMATIONS, routes: ROUTES, fronts: FRONTS, coverages: COVERAGES,
  blitzTypes: BLITZ_TYPES, motions: MOTIONS, playTypes: PLAYTYPES, personnel: PERSONNEL,
  runConcepts: RUN_CONCEPTS, passConcepts: PASS_CONCEPTS, stConcepts: ST_CONCEPTS,
  editable: EDITABLE, lowConf: LOW_CONF,
}));

api.get('/health', (req, res) => {
  const tn = req.tn;
  res.json({
    ok: true, team: req.teamId, keySet: !!API_KEY, model: MODEL_FULL, twoPass: TWO_PASS,
    plays: tn.PLAYS.length,
    needsReview: tn.PLAYS.filter(p => p.needsReview).length,
    corrected: tn.PLAYS.filter(p => p.corrected).length,
    queued: tn.QUEUE.length,
    charting: !!(RUNNING && RUNNING.team === req.teamId),
    boxBusy: !!RUNNING,
    passwordSet: !!pwFor(req.teamId),
  });
});

api.get('/plays', (req, res) => res.json(req.tn.PLAYS));
api.delete('/plays', (req, res) => { req.tn.PLAYS = []; savePlays(req.tn); res.json({ ok: true }); });

api.get('/clip/:playId', async (req, res) => {
  const tn = req.tn;
  const p = tn.PLAYS.find(x => String(x.id) === String(req.params.playId));
  if (!p) return res.status(404).json({ error: 'no such play' });
  const src = p.filmSrc || tn.lastFilm;
  if (!filmExists(src)) return res.status(410).json({
    error: 'The film for this play is no longer on the server.',
    detail: `Only the ${KEEP_FILMS} most recent games are kept so the disk doesn't fill up. The charted plays and all their data are intact — it's just the video clip that's gone.`,
    fix: 'Re-upload this game to watch its clips again, or raise KEEP_FILMS and add disk.',
  });
  const out = path.join(tn.clipDir, 'clip-' + p.id + '.mp4');
  try {
    if (!fs.existsSync(out)) {
      const start = Math.max(0, (p.videoT || 0) - 3);
      await run('ffmpeg', ['-ss', String(start), '-i', src, '-t', '14', '-vf', 'scale=854:-2',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-an', '-movflags', '+faststart', '-y', out], 120000);
    }
    res.sendFile(out);
  } catch (e) {
    res.status(500).json({ error: 'clip generation failed: ' + e.message.slice(0, 200) });
  }
});

/*
  A Hudl WATCH page is HTML, not a video stream — ffmpeg can't demux it, and
  yt-dlp ships no Hudl extractor. Hudl film is auth-gated, and Hudl's own docs
  warn that tools circumventing their access controls risk suspending the COACH's
  account. So we don't scrape and we never ask for a Hudl password. We recognise a
  watch link and hand back the three-click path to Hudl's own download link —
  which IS a direct video URL and works here today.
*/
const HUDL_WATCH = /(^|\/\/)(www\.)?hudl\.com\/(video|film|watch|embed|v)\//i;
const HUDL_HELP = {
  error: "That's a Hudl watch link — it's a web page, not a video file, so it can't be read directly (and Hudl blocks tools that try).",
  fix: 'Hudl can hand you a real download link in three clicks:',
  steps: [
    'Open the game in Hudl and click into the video',
    'Click Details, then the three dots under the title',
    'Choose "Download Video" — or "Email Video Download Link"',
    'Upload the downloaded file below, or paste the download link here',
  ],
  note: 'Downloading a game you have access to is a normal, supported Hudl feature. If the option is greyed out, your team admin has downloads switched off and can re-enable them.',
};

api.post('/jobs/url', async (req, res) => {
  const tn = req.tn;
  if (!API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Paste a direct video link (.mp4/.mov/.webm), a Hudl download link, or a YouTube URL.' });
  if (HUDL_WATCH.test(url)) return res.status(422).json(HUDL_HELP);

  const id = crypto.randomBytes(6).toString('hex');
  const isYT = /youtube\.com|youtu\.be/.test(url);
  tn.JOBS[id] = { id, status: isYT ? 'downloading' : 'queued', log: [], t: 0, dur: 0, found: 0, scans: 0, spentEst: 0, review: 0 };
  res.json({ id });
  const dest = path.join(tn.filmDir, id + '.mp4');
  try {
    if (isYT) {
      tn.JOBS[id].log.push('Fetching from YouTube via yt-dlp…');
      await run('yt-dlp', ['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4',
        '--no-playlist', '-o', dest, url], 600000);
      if (!fs.existsSync(dest)) throw new Error('yt-dlp produced no file');
      tn.JOBS[id].log.push('YouTube download complete (' + Math.round(fs.statSync(dest).size / 1048576) + ' MB).');
      enqueue(tn, id, dest, false);
    } else {
      enqueue(tn, id, url, true);   // stream frames on demand; no full download
    }
  } catch (e) {
    let msg = e.message.slice(0, 300);
    if (isYT && /sign in|bot|429|403|confirm/i.test(msg))
      msg = 'YouTube blocked this download from the server IP (common on cloud hosts). Download the film yourself and use Upload instead.';
    tn.JOBS[id].status = 'error'; tn.JOBS[id].error = msg;
  }
});

api.post('/jobs/upload', upload.single('film'), (req, res) => {
  const tn = req.tn;
  if (!API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const id = crypto.randomBytes(6).toString('hex');

  // Straight onto this school's film directory. /api/:team/clip seeks back into
  // it all season; it is never deleted at end of job.
  const ext = (path.extname(req.file.originalname || '') || '.mp4').slice(0, 6);
  const dest = path.join(tn.filmDir, id + ext);
  try { fs.renameSync(req.file.path, dest); }
  catch (e) {
    try { fs.copyFileSync(req.file.path, dest); fs.unlinkSync(req.file.path); }
    catch (e2) { return res.status(500).json({ error: 'could not store film: ' + e2.message.slice(0, 160) }); }
  }
  tn.JOBS[id] = { id, status: 'queued', log: ['Upload received: ' + Math.round(req.file.size / 1048576) + ' MB'],
                  t: 0, dur: 0, found: 0, scans: 0, spentEst: 0, review: 0 };
  res.json({ id });
  enqueue(tn, id, dest, false);
});

api.get('/jobs/:id', (req, res) => {
  const j = req.tn.JOBS[req.params.id];
  if (!j) return res.status(404).json({ error: 'no such job' });
  res.json({ id: j.id, status: j.status, t: j.t, dur: j.dur, found: j.found, scans: j.scans,
             spentEst: j.spentEst, error: j.error || null, queuePos: j.queuePos || 0,
             review: j.review || 0, log: j.log.slice(-25) });
});
api.post('/jobs/:id/cancel', (req, res) => {
  const j = req.tn.JOBS[req.params.id]; if (j) j.cancel = true;
  res.json({ ok: true });
});

/*
  THE CORRECTION LOOP — why a coach should trust this over a black box.
  Plays the engine wasn't sure about surface in a review queue instead of being
  quietly averaged into the tendencies. Fix a label and the scouting screens
  recompute off the corrected value. A corrected play is pinned and never returns
  to the queue.
*/
const EDITABLE = ['q', 'down', 'dist', 'yard', 'hash', 'formation', 'personnel', 'motion',
                  'playType', 'concept', 'front', 'coverage', 'blitz', 'blitzType', 'gain', 'result'];

api.patch('/plays/:id', (req, res) => {
  const tn = req.tn;
  const p = tn.PLAYS.find(x => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: 'no such play' });
  const applied = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!EDITABLE.includes(k)) continue;
    p[k] = v; applied.push(k);
    const i = p.unknown.indexOf(k);
    if (i > -1) p.unknown.splice(i, 1);
  }
  if (!applied.length) return res.status(400).json({ error: 'no editable fields in patch', editable: EDITABLE });
  p.corrected = true;                                   // a human said so
  p.confidence = { formation: 1, coverage: 1, routes: 1 };
  p.minConf = 1;
  p.needsReview = p.unknown.some(f => CORE_FIELDS.includes(f));
  savePlays(tn);
  res.json({ ok: true, applied, play: p });
});

api.get('/review', (req, res) => {
  const tn = req.tn;
  const queue = tn.PLAYS.filter(p => p.needsReview)
    .sort((a, b) => (a.minConf - b.minConf) || (b.unknown.length - a.unknown.length));
  res.json({ total: tn.PLAYS.length, needsReview: queue.length,
             corrected: tn.PLAYS.filter(p => p.corrected).length, queue });
});


/* ---------------- pages ---------------- */
// /acu — that school's app. The client reads the team off the path.
app.get('/:team', (req, res, next) => {
  const id = String(req.params.team).toLowerCase();
  if (!isTenant(id)) return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.use(express.static(__dirname, { index: false }));

/*
  ROOT — deliberately says nothing.

  This used to render a picker listing every school on the box. That was wrong in
  a way that costs deals: a coach who lands on the bare domain would see that his
  conference rivals are also customers. It exposes the client list, and it makes
  his program's tool look like a shared portal.

  A coach only ever receives his own deep link (/acu). The root is a nameless
  front door. It enumerates nothing.
*/
app.get('/', (req, res) => {
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Gridiron IQ</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@800&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
body{margin:0;min-height:100vh;background:#0a0d12;color:#f3f7fb;display:flex;align-items:center;
 justify-content:center;text-align:center;font-family:system-ui,sans-serif;
 background-image:radial-gradient(1200px 600px at 80% -10%,rgba(79,140,255,.08),transparent 60%)}
h1{font-family:"Saira Condensed",sans-serif;font-weight:800;font-size:34px;text-transform:uppercase;margin:0}
p{color:#69788a;font-size:12px;font-family:"JetBrains Mono",monospace;letter-spacing:.22em;text-transform:uppercase;margin:8px 0 0}
</style></head><body><div>
<h1>Gridiron IQ</h1><p>Film Intelligence Platform</p>
</div></body></html>`);
});

app.listen(PORT, () => {
  console.log('GRIDIRON IQ on :' + PORT + ' | key: ' + (API_KEY ? 'set' : 'MISSING') + ' | model: ' + MODEL_FULL);
  TENANT_IDS.forEach(id => {
    const pw = pwFor(id);
    console.log(`  /${id.padEnd(12)} ${TEAMS[id].school.padEnd(22)} ` +
      (pw ? 'password set' : 'OPEN — set TEAM_PASSWORD_' + id.toUpperCase() + ' before sharing this link'));
  });
});
