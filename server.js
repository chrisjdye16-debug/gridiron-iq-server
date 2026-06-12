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
const WORK_DIR = path.join(DATA_DIR, 'work');
fs.mkdirSync(WORK_DIR, { recursive: true });

const PLAYS_FILE = path.join(DATA_DIR, 'plays.json');
let PLAYS = [];
try { PLAYS = JSON.parse(fs.readFileSync(PLAYS_FILE, 'utf8')); } catch (e) {}
const savePlays = () => fs.writeFileSync(PLAYS_FILE, JSON.stringify(PLAYS));

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

const SNAP_SYS = `You classify single frames from football game film. Respond ONLY with JSON: {"live": true|false}. "live"=true if the frame shows a real-time game view of ANY play about to start or in its first seconds: offense lined up at the line of scrimmage pre-snap, ball just snapped, kickoff alignment or kick just struck, punt formation, or field-goal formation. "live"=false for: replays (slow-motion, zoomed isolations, replay wipes/graphics), huddles, players walking between plays, crowd/sideline/coach/bench shots, commercials, halftime, full-screen score graphics, celebrations, injury stoppages.`;

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
function toPlay(j, videoT, jobId) {
  const st = j.situation || {}, d = j.defense || {}, rd = j.read || {}, conf = rd.confidence || {};
  const formation = nearest(j.formation, FORMATIONS) || 'Gun Spread 2x2';
  const playType = nearest(j.playType, PLAYTYPES) || 'Pass';
  const routes = {};
  if (j.routes) for (const [pos, r] of Object.entries(j.routes)) {
    const rr = nearest(r, ['Run Path', ...ROUTES]); if (rr) routes[pos] = rr;
  }
  const blitz = !!d.blitz;
  const gain = (j.result && typeof j.result.gain === 'number') ? Math.round(j.result.gain) : 0;
  return {
    id: PLAYS.reduce((m, p) => Math.max(m, p.id), 0) + 1,
    jobId, videoT: Math.round(videoT),
    q: (st.quarter >= 1 && st.quarter <= 4) ? st.quarter : 1,
    down: (st.down >= 1 && st.down <= 4) ? st.down : 1,
    dist: (st.dist >= 1 && st.dist <= 40) ? Math.round(st.dist) : 10,
    yard: (st.yardLine >= 1 && st.yardLine <= 99) ? Math.round(st.yardLine) : 50,
    hash: ['L', 'M', 'R'].includes(st.hash) ? st.hash : 'M',
    formation, personnel: PERSONNEL[formation] || '11',
    motion: nearest(j.motion, MOTIONS) || 'None',
    playType, concept: nearest(j.concept, [...RUN_CONCEPTS, ...PASS_CONCEPTS, ...ST_CONCEPTS]) || 'Inside Zone',
    routes,
    front: nearest(d.front, FRONTS) || 'Nickel 4-2-5',
    coverage: nearest(d.postSnapCoverage, COVERAGES) || 'Cover 3',
    preSnapShell: d.preSnapShell || null, rotation: d.rotation || null,
    blitz, blitzType: blitz ? (nearest(d.blitzType, BLITZ_TYPES) || 'Mike A-Gap') : 'None',
    blitzOrigin: blitz ? (d.blitzOrigin || null) : null, blitzPlayer: blitz ? (d.blitzPlayer || null) : null,
    rushers: d.rushers || (blitz ? 5 : 4), box: d.box || 7,
    gain, td: false, turnover: false,
    result: (j.result && j.result.description) ? j.result.description : (gain >= 0 ? '+' + gain + ' yds' : gain + ' yds'),
    summary: rd.summary || '', observations: rd.keyObservations || [],
    confidence: conf, playlists: []
  };
}

/* ---------------- jobs ---------------- */
const JOBS = {}; // id -> {status, log[], t, dur, found, scans, error, spentEst}
let processing = false;

async function processJob(id, file, isRemote) {
  const job = JOBS[id];
  const log = m => { job.log.push('[' + new Date().toISOString().slice(11, 19) + '] ' + m); if (job.log.length > 400) job.log.shift(); };
  try {
    job.status = 'probing';
    if (isRemote) log('Streaming film directly (no full download) — reading frames on demand.');
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
        log('🏈 Snap detected @ ' + Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') + ' — running breakdown…');
        try {
          const offsets = [-1.2, -0.4, 0.5, 1.3, 2.2, 3.2, 4.2];
          const frames = [];
          for (const off of offsets) frames.push(await extractFrame(file, t + off, tmp));
          const j = await breakdown(frames);
          const conf = (j.read && j.read.confidence) || {};
          if ((conf.formation || 0) >= 0.25) {
            const p = toPlay(j, t, id);
            PLAYS.push(p); savePlays(); job.found++;
            log('✅ Play ' + job.found + ': ' + p.formation + ' · ' + p.playType + ' ' + p.concept + ' vs ' + p.coverage + (p.blitz ? ' +BLITZ' : '') + ' → ' + p.result);
          } else log('Skipped low-confidence capture (replay/graphic).');
        } catch (e) { log('Breakdown error: ' + e.message.slice(0, 180)); }
        t += POST_SKIP;
      } else t += SCAN_STEP;
    }
    job.status = 'done'; job.t = job.dur;
    log('🏁 Finished: ' + job.found + ' plays charted from ' + job.scans + ' scans.');
  } catch (e) {
    job.status = 'error'; job.error = e.message.slice(0, 300); log('⛔ ' + job.error);
  } finally {
    processing = false;
    if (!isRemote) { try { fs.unlinkSync(file); } catch (e) {} }
  }
}

/* ---------------- http ---------------- */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname, { index: 'index.html' }));
const upload = multer({ dest: WORK_DIR, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

app.get('/api/health', (req, res) => res.json({ ok: true, keySet: !!API_KEY, model: MODEL_FULL, twoPass: TWO_PASS, plays: PLAYS.length }));
app.get('/api/plays', (req, res) => res.json(PLAYS));
app.delete('/api/plays', (req, res) => { PLAYS = []; savePlays(); res.json({ ok: true }); });

app.post('/api/jobs/url', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  if (processing) return res.status(429).json({ error: 'A film is already processing — wait for it to finish.' });
  const url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Provide a video URL (YouTube, Hudl, or a direct .mp4/.mov/.webm link).' });
  const id = crypto.randomBytes(6).toString('hex');
  const isYT = /youtube\.com|youtu\.be/.test(url);
  JOBS[id] = { id, status: 'downloading', log: [], t: 0, dur: 0, found: 0, scans: 0, spentEst: 0 };
  processing = true;
  res.json({ id });
  const dest = path.join(WORK_DIR, id + '-src');
  try {
    if (isYT) {
      JOBS[id].log.push('Fetching from YouTube via yt-dlp…');
      // cap at 720p to keep download/processing reasonable
      await run('yt-dlp', ['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4', '--no-playlist', '-o', dest + '.%(ext)s', url], 600000);
      const made = fs.readdirSync(WORK_DIR).find(f => f.startsWith(id + '-src.'));
      if (!made) throw new Error('yt-dlp produced no file');
      fs.renameSync(path.join(WORK_DIR, made), dest);
      JOBS[id].log.push('YouTube download complete (' + Math.round(fs.statSync(dest).size / 1048576) + ' MB).');
      processJob(id, dest, false);
    } else {
      // direct video URL — stream frames on demand with ffmpeg (no full download, any file size)
      processJob(id, url, true);
    }
  } catch (e) {
    let msg = e.message.slice(0, 300);
    if (isYT && /sign in|bot|429|403|confirm/i.test(msg)) msg = 'YouTube blocked this download from the server IP (common on cloud hosts). Download the film yourself and use Upload Film instead.';
    JOBS[id].status = 'error'; JOBS[id].error = msg; processing = false;
  }
});

app.post('/api/jobs/upload', upload.single('film'), (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  if (processing) return res.status(429).json({ error: 'A film is already processing — wait for it to finish.' });
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  const id = crypto.randomBytes(6).toString('hex');
  JOBS[id] = { id, status: 'queued', log: ['Upload received: ' + Math.round(req.file.size / 1048576) + ' MB'], t: 0, dur: 0, found: 0, scans: 0, spentEst: 0 };
  processing = true;
  res.json({ id });
  processJob(id, req.file.path);
});

app.get('/api/jobs/:id', (req, res) => {
  const j = JOBS[req.params.id];
  if (!j) return res.status(404).json({ error: 'no such job' });
  res.json({ id: j.id, status: j.status, t: j.t, dur: j.dur, found: j.found, scans: j.scans, spentEst: j.spentEst, error: j.error || null, log: j.log.slice(-25) });
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const j = JOBS[req.params.id]; if (j) j.cancel = true;
  res.json({ ok: true });
});

app.listen(PORT, () => console.log('GRIDIRON IQ server on :' + PORT + ' | key set: ' + !!API_KEY + ' | model: ' + MODEL_FULL));
