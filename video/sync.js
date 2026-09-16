/*
 * sync.js — ドラレコ映像 / OBDログ / GPX / NMEA を共通の絶対時刻軸に載せる
 *
 * 環境非依存の ES モジュール。ブラウザ（再生アプリ）と Node（検証・書き出し）の双方から使う。
 * 手法・根拠は embedded/knowledge/dashcam-obd-time-sync.md を参照。
 *
 * 設計方針:
 *  - データから導出できる量はすべて導出する（クリップ長・NMEAリード・アンカー・オフセット）。
 *  - 機器依存で毎回測れない量だけをプロファイル定数にする（C_VIDEO）。
 *  - 時刻はすべて「UTC epoch 秒(小数)」で扱う。日付跨ぎ・ローカル時刻機種を回避する。
 *  - 推定値には必ず残差と妥当性フラグを付け、解けない場合は黙って通さない。
 */

import { CAL, decode2920, powers, MIN_BYTES } from '../lib/did2920.js';

export { CAL };   // 従来どおり sync.js からも取れるようにしておく

const MP4_EPOCH_OFFSET = 2082844800; // 1904-01-01 → 1970-01-01 [s]

export const DEFAULT_PROFILE = {
  name: 'generic',
  // 映像 t=0 の絶対時刻 = A + cVideo。実測 +0.4±0.6s のため既定 0。
  // GPS同期時計の校正撮影を行ったらここを更新する（1フレーム=33ms精度で確定できる）。
  cVideo: 0.0,
  cVideoSource: 'default(unmeasured)',
};

/*
 * 機種判定用の署名センテンス。NMEA の独自センテンスで見分ける。
 * $JK* は OEM の JVCKENWOOD 由来。Honda 純正 DRH-224SD（前後2カメラセット,
 * 品番 08E30-PM5-C04A）で実測・校正した。SoC は Ambarella（MP4 の encoder タグ）。
 */
const PROFILES = [
  { name: 'honda-drh-224sd', signatures: ['$GTRIP', '$JKTMD', '$JKLLA'], cVideo: 0.0, cVideoSource: 'measured +0.4±0.6s → adopt 0' },
];

// ---------------------------------------------------------------- utilities

/** 昇順配列 xs に対する線形補間。範囲外・欠測跨ぎは null。 */
export function interpAt(xs, ys, x, maxGap = 3) {
  if (!xs.length) return null;
  let lo = 0, hi = xs.length - 1;
  if (x < xs[0] || x > xs[hi]) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid;
  }
  const dx = xs[hi] - xs[lo];
  if (dx <= 0) return ys[lo];
  if (dx > maxGap) return null;
  const w = (x - xs[lo]) / dx;
  return ys[lo] + (ys[hi] - ys[lo]) * w;
}

function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * 111320;
  const dx = (lon2 - lon1) * 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** 位置列 → 区間中心時刻の速度[km/h]。ドップラ遅延を避けるため位置差分を使う。 */
export function speedFromPositions(pts, maxGap = 3) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    if (dt <= 0 || dt > maxGap) continue;
    const d = haversineMeters(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    out.push({ t: (pts[i].t + pts[i - 1].t) / 2, v: (d / dt) * 3.6 });
  }
  return out;
}

// ---------------------------------------------------------------- NMEA

/*
 * NMEA のチェックサム検証。`$` と `*` の間を XOR したものが `*XX` と一致する。
 *
 * **切れた行を確実に弾くために要る。** 先頭 4KB だけ読む使い方をすると最後の行が
 * 途中で切れ、フィールドが短いまま解釈されてしまう。実測（2026-08-10, SDカード）では
 * 日付フィールド `100826` が `1008` に切れ、dd=10/mo=08/yy='' → **2000-08-10** と解釈され、
 * 26年前の幻のセッションが一覧に現れた。フィールド長を個別に検査するより、
 * チェックサムで一括して弾く方が漏れが無い。
 * チェックサムを持たないセンテンス（$GSENS/$GTRIP/$JK*）には適用しない。
 */
function nmeaChecksumOk(line) {
  const i = line.lastIndexOf('*');
  if (i < 1 || line.length < i + 3) return false;
  let c = 0;
  for (let k = 1; k < i; k++) c ^= line.charCodeAt(k);
  return c === parseInt(line.slice(i + 1, i + 3), 16);
}

function dmToDeg(v, hemi) {
  const f = parseFloat(v);
  if (!isFinite(f)) return NaN;
  const d = Math.floor(f / 100);
  const deg = d + (f - d * 100) / 60;
  return hemi === 'S' || hemi === 'W' ? -deg : deg;
}

/**
 * NMEA を解析。$GPRMC の date+time から絶対 epoch を作るので日付跨ぎに強い。
 * $GSENS は時刻フィールドを持たないため、前後の測位センテンスの間を等分して時刻を推定する
 * （推定であることを isEstimated で明示）。
 */
export function parseNmea(text) {
  const fixes = [];
  const gsensRaw = [];
  const signatures = new Set();
  const seen = new Set();
  // hhmmss.ss → {alt, ns, hdop}（$GPGGA。$GPRMC は標高も測位品質も持たない）
  // ns/hdop は坑口での測位劣化を弾くのに要る（fillTrackGaps 参照）。
  const alt = new Map();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('$')) continue;
    const tag = line.slice(0, 6);
    const p = line.split(',');
    if (tag === '$GPGGA') {
      if (!nmeaChecksumOk(line)) continue;
      const a = parseFloat(p[9]), sep = parseFloat(p[11]);
      // p[11] は受信機が使ったジオイド高。標高の基準面を直すのに要る（applyGeoid 参照）
      if (p[1] && p[6] !== '0') alt.set(p[1], { alt: isFinite(a) ? a : null, ns: +p[7],
                                                hdop: parseFloat(p[8]), sep: isFinite(sep) ? sep : null });
    } else if (tag === '$GPRMC') {
      if (!nmeaChecksumOk(line)) continue;
      if (p.length < 10 || !p[1] || p[9].length !== 6) continue;
      const hh = +p[1].slice(0, 2), mm = +p[1].slice(2, 4), ss = parseFloat(p[1].slice(4));
      const dd = +p[9].slice(0, 2), mo = +p[9].slice(2, 4), yy = +p[9].slice(4, 6);
      if (!isFinite(hh) || !isFinite(dd)) continue;
      const t = Date.UTC(2000 + yy, mo - 1, dd, hh, mm, 0) / 1000 + ss;
      /*
       * **status=V（測位無効）でも時刻の基準としては使う。**
       * 受信機は位置を失っても GPS 時刻は保持しており、$GPRMC の時刻・日付は埋まっている。
       * $GSENS は時刻を持たず前後の測位センテンスの間を等分して時刻を割り当てるので、
       * 有効測位だけを基準にすると**トンネル内で基準が1つも無くなり IMU が全部落ちる**
       * （実測: 関越トンネル内のクリップで $GSENS 1190〜1210 行に対し gsens 0件）。
       * 位置が要る fixes には積まず、時刻の基準としてだけ使う。
       */
      if (p[2] === 'A') {
        const lat = dmToDeg(p[3], p[4]), lon = dmToDeg(p[5], p[6]);
        if (isFinite(lat) && isFinite(lon) && !seen.has(t)) {
          seen.add(t);
          fixes.push({ t, lat, lon, spd: (parseFloat(p[7]) || 0) * 1.852, ele: null, ns: null, hdop: null, _tk: p[1] }); // knot → km/h
        }
      }
      gsensRaw.push({ mark: t });
    } else if (tag === '$GSENS') {
      const x = parseFloat(p[1]), y = parseFloat(p[2]), z = parseFloat(p[3]);
      if (isFinite(x) && isFinite(y) && isFinite(z)) gsensRaw.push({ acc: [x, y, z] });
    } else if (line.startsWith('$GT') || line.startsWith('$JK')) {
      signatures.add(tag);
    }
  }
  fixes.sort((a, b) => a.t - b.t);
  // 標高を突合。$GPGGA が $GPRMC の前後どちらに来るかは機器依存なので、全部読んでから割り当てる
  for (const f of fixes) {
    const a = alt.get(f._tk);
    if (a !== undefined) { f.ele = a.alt; f.ns = a.ns; f.hdop = a.hdop; f.sep = a.sep; }
    delete f._tk;
  }
  // $GSENS に時刻を割り当て（測位センテンス間を等分）
  const gsens = [];
  let pend = [];
  let prevMark = null;
  for (const r of gsensRaw) {
    if (r.mark !== undefined) {
      if (prevMark !== null && pend.length) {
        for (let i = 0; i < pend.length; i++) {
          gsens.push({ t: prevMark + ((r.mark - prevMark) * (i + 0.5)) / pend.length, acc: pend[i], isEstimated: true });
        }
      }
      prevMark = r.mark; pend = [];
    } else pend.push(r.acc);
  }
  return { fixes, gsens, signatures: [...signatures] };
}

// ---------------------------------------------------------------- GPX

export function parseGpx(text) {
  const pts = [];
  const re = /<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g;
  let m;
  while ((m = re.exec(text))) {
    const tm = /<time>([^<]+)<\/time>/.exec(m[3]);
    if (!tm) continue;
    const t = Date.parse(tm[1]) / 1000;
    if (!isFinite(t)) continue;
    const el = /<ele>([-\d.]+)<\/ele>/.exec(m[3]);
    pts.push({ t, lat: +m[1], lon: +m[2], ele: el ? +el[1] : null });
  }
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

// ---------------------------------------------------------------- OBD log

/** ISO-TP 表示のフレーム群を連結。フレーム10以降はコロン区切りが無い形式に対応。 */
function reassembleFrames(rest) {
  const frames = new Map();
  for (const tok of rest.trim().split(/\s+/)) {
    let m = /^(\d+):([0-9A-Fa-f]+)$/.exec(tok);
    if (m) { frames.set(+m[1], m[2]); continue; }
    // コロン無し: 先頭2桁がフレーム番号 + CF ペイロード7バイト（例 1000003A7FFF00E0）。
    // 14桁ちょうどに限定しないと単フレーム応答（415B45...）を誤って拾う。
    m = /^(\d{2})([0-9A-Fa-f]{14})$/.exec(tok);
    if (m) { frames.set(+m[1], m[2]); continue; }
  }
  if (!frames.size) return null;
  const idx = [...frames.keys()].sort((a, b) => a - b);
  // 連番欠けは不完全として捨てる
  for (let i = 0; i < idx.length; i++) if (idx[i] !== i) return null;
  const hex = idx.map((i) => frames.get(i)).join('');
  const n = hex.length >> 1;
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const s16 = (b, i) => { const v = u16(b, i); return v >= 32768 ? v - 65536 : v; };

/**
 * fl4obd の webapp ログを解析。
 * オフセット規約: webapp の位置 = ロガーの位置 + 2（W[0..2] = 62 29 20）。
 *
 * timeMode: 'ok'=応答受信時刻（既定） / 'midpoint'=tx と ok の中点。
 * 実測では両者で照合残差が同一（0.4686 vs 0.4692 km/h）＝どちらが真の採取時刻かはデータから
 * 決まらず、δ が 0.25s ずれるだけ。ストリーム毎に実測オフセットを当てる方式なのでこの曖昧さは
 * 吸収される（'ok' で δ=-2.354s、GPX位置由来の -2.40s と 0.05s で一致する）。よって既定は 'ok'。
 */
export function parseObdLog(text, { timeMode = 'ok' } = {}) {
  const lines = text.split(/\r?\n/);
  const gen = /Generated:\s*(\S+)/.exec(text);
  const genT = gen ? Date.parse(gen[1]) / 1000 : NaN;
  if (!isFinite(genT)) throw new Error('OBDログに Generated ヘッダが無く日付を決定できない');
  const genDayStart = Math.floor(genT / 86400) * 86400;
  const genTod = genT - genDayStart;

  const samples = [];   // 2920 由来（車速・rpm 等）
  const speedPid = [];  // PID 0D 由来のフォールバック車速
  const soc = [];
  const dids = new Set();
  let lastTx = null, nTx = 0, nOk = 0, nBad = 0;

  for (const line of lines) {
    const h = /^\[(\d\d):(\d\d):(\d\d(?:\.\d+)?)\]\s*\[(\w+)\s*\]\s*(.*)$/.exec(line);
    if (!h) continue;
    let tod = +h[1] * 3600 + +h[2] * 60 + parseFloat(h[3]);
    // 日付跨ぎ: Generated 時刻より後の時刻は前日
    let t = genDayStart + tod;
    if (tod > genTod + 60) t -= 86400;
    const tag = h[4], rest = h[5];

    if (tag === 'tx') { lastTx = t; nTx++; continue; }
    if (tag !== 'ok') continue;
    nOk++;
    const ts = timeMode === 'midpoint' && lastTx !== null && t - lastTx < 5 ? (t + lastTx) / 2 : t;
    lastTx = null;

    const arrow = rest.indexOf('←');
    if (arrow < 0) continue;
    let body = rest.slice(arrow + 1).trim();

    // 宣言長プレフィックス（例 "06F"）。決め打ちせず読む。
    let declared = null;
    const lm = /^([0-9A-Fa-f]{3,4})\s+(?=\d)/.exec(body);
    if (lm) { declared = parseInt(lm[1], 16); body = body.slice(lm[0].length); }

    // マルチフレーム表示は必ずコロン付きのフレーム番号を含む。単フレーム応答と確実に区別する。
    if (declared !== null || /(^|\s)\d{1,2}:/.test(body)) {
      const W = reassembleFrames(body);
      if (!W) { nBad++; continue; }
      if (declared !== null && W.length < declared) { nBad++; continue; }
      if (W[0] === 0x62) {
        const did = u16(W, 1);
        dids.add(did);
        if (did === 0x2920 && W.length >= MIN_BYTES) {
          // W[98]==0xF8 は 2920 の固定バイト。あれば健全性チェックとして使う。
          if (W.length > 98 && W[98] !== 0xf8) { nBad++; continue; }
          const f = decode2920(W);      // フィールド定義は lib/did2920.js に一本化
          if (f) samples.push({ t: ts, ...f });
        }
      }
      continue;
    }

    // 単フレーム応答（同一応答が複数回並ぶことがある）
    const tok = body.split(/\s+/)[0];
    if (!/^[0-9A-Fa-f]{4,}$/.test(tok)) continue;
    const b0 = parseInt(tok.substr(0, 2), 16), b1 = parseInt(tok.substr(2, 2), 16);
    if (b0 === 0x41) {
      if (b1 === 0x0d) speedPid.push({ t: ts, v: parseInt(tok.substr(4, 2), 16) });
      else if (b1 === 0x5b) soc.push({ t: ts, v: (parseInt(tok.substr(4, 2), 16) * 100) / 255 });
    }
  }
  samples.sort((a, b) => a.t - b.t);
  speedPid.sort((a, b) => a.t - b.t);
  return { samples, speedPid, soc, dids: [...dids].sort(), stats: { nTx, nOk, nBad }, generatedAt: genT };
}

// ---------------------------------------------------------------- 派生量（パワーフロー用）


/** 遷移モード(10/30/60)を「次の安定モード＝行先」へ寄せて modeR を付ける。 */
export function resolveModes(samples) {
  const stable = (m) => m === 20 || m === 40 || m === 50 || m === 70;
  const nextS = new Array(samples.length);
  let ns = -1;
  for (let i = samples.length - 1; i >= 0; i--) { if (stable(samples[i].mode)) ns = samples[i].mode; nextS[i] = ns; }
  let ps = -1;
  for (let i = 0; i < samples.length; i++) {
    if (stable(samples[i].mode)) { ps = samples[i].mode; samples[i].modeR = samples[i].mode; }
    else samples[i].modeR = nextS[i] >= 0 ? nextS[i] : ps >= 0 ? ps : samples[i].mode;
  }
  return samples;
}

/**
 * 生の 2920 サンプルからパワーフロー描画に必要な派生量を計算する。
 * SOC は実測 5B が来たら再アンカーし、その間を ∫Pbat で前進させる（表示専用）。
 */
export function deriveTelemetry(obd) {
  const socAnchors = obd.soc || [];
  let ai = 0, socR = NaN, prevT = null;
  resolveModes(obd.samples);
  for (const s of obd.samples) {
    while (ai < socAnchors.length && socAnchors[ai].t <= s.t) { socR = socAnchors[ai].v; ai++; } // 実測5Bで再アンカー
    Object.assign(s, powers(s));   // peng / pgen / pdrive / psys
    if (!isNaN(socR) && prevT != null) {
      const dt = (s.t - prevT) / 3600; // s → h
      if (dt > 0 && dt < 0.02) socR += CAL.SOC_K * s.pbat * dt;
    }
    prevT = s.t;
    s.soc = isNaN(socR) ? NaN : +socR.toFixed(2);
  }
  return obd;
}

/** 車速系列を選ぶ。2920 が無ければ PID 0D にフォールバックする。 */
export function obdSpeedSeries(obd) {
  if (obd.samples.length > 20) return { series: obd.samples.map((s) => ({ t: s.t, v: s.vsp })), source: '22_2920' };
  if (obd.speedPid.length > 20) return { series: obd.speedPid, source: '01_0D' };
  return { series: [], source: 'none' };
}

// ---------------------------------------------------------------- MP4 metadata

/**
 * MP4 の moov/mvhd から creation_time と duration を読む。
 * reader: async (offset, length) => ArrayBuffer （File.slice / fs.read の両対応）
 * creation_time はローカル時刻を書く機種があるため、セッション組成の順序付けにのみ使い、
 * 絶対時刻の基準には NMEA を用いる（tzUncertain フラグで明示）。
 */
export async function parseMp4Meta(reader, fileSize) {
  const readBoxesFrom = async (start, limit) => {
    let off = start;
    while (off < limit) {
      const hdr = new DataView(await reader(off, 16));
      if (hdr.byteLength < 8) return null;
      let size = hdr.getUint32(0);
      const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
      let hsize = 8;
      if (size === 1) { size = Number(hdr.getBigUint64(8)); hsize = 16; }
      else if (size === 0) size = limit - off;
      if (type === 'moov') return { off: off + hsize, size: size - hsize };
      if (size <= 0) return null;
      off += size;
    }
    return null;
  };
  const moov = await readBoxesFrom(0, fileSize);
  if (!moov) throw new Error('moov ボックスが見つからない');
  // moov 内の mvhd を探す
  let off = moov.off;
  const end = moov.off + moov.size;
  while (off < end) {
    const hdr = new DataView(await reader(off, 8));
    if (hdr.byteLength < 8) break;
    const size = hdr.getUint32(0);
    const type = String.fromCharCode(hdr.getUint8(4), hdr.getUint8(5), hdr.getUint8(6), hdr.getUint8(7));
    if (type === 'mvhd') {
      const d = new DataView(await reader(off + 8, 32));
      const ver = d.getUint8(0);
      let created, timescale, duration;
      if (ver === 1) {
        created = Number(d.getBigUint64(4)); timescale = d.getUint32(20); duration = Number(d.getBigUint64(24));
      } else {
        created = d.getUint32(4); timescale = d.getUint32(12); duration = d.getUint32(16);
      }
      return {
        creationTime: created - MP4_EPOCH_OFFSET,
        duration: timescale > 0 ? duration / timescale : NaN,
        timescale,
      };
    }
    if (size <= 0) break;
    off += size;
  }
  throw new Error('mvhd ボックスが見つからない');
}

// ---------------------------------------------------------------- offset estimation

/**
 * src(t) ≈ ref(t+δ) となる δ を探す。粗→細の2段スイープ＋放物線頂点で精密化。
 * 妥当性: サンプル数と「谷のコントラスト」を検定し、平坦なら ok=false を返す。
 */
export function estimateOffset(src, ref, opts = {}) {
  const { range = 15, coarse = 0.5, fine = 0.02, moveThreshold = 5, minSamples = 200, minContrast = 0.15 } = opts;
  if (src.length < minSamples / 4 || ref.length < 10) {
    return { ok: false, reason: 'サンプル不足', delta: NaN, residual: NaN, n: 0 };
  }
  const rt = ref.map((r) => r.t), rv = ref.map((r) => r.v);
  const cost = (d) => {
    const e = [];
    for (const s of src) {
      const r = interpAt(rt, rv, s.t + d);
      if (r === null) continue;
      if (Math.max(s.v, r) < moveThreshold) continue;
      e.push(Math.abs(s.v - r));
    }
    return e.length ? { c: median(e), n: e.length } : { c: NaN, n: 0 };
  };
  const scan = (lo, hi, step) => {
    const out = [];
    for (let d = lo; d <= hi + 1e-9; d += step) out.push({ d, ...cost(d) });
    return out.filter((r) => isFinite(r.c));
  };
  let grid = scan(-range, range, coarse);
  if (!grid.length) return { ok: false, reason: '重なり区間が無い', delta: NaN, residual: NaN, n: 0 };
  let best = grid.reduce((a, b) => (b.c < a.c ? b : a));
  const worst = grid.reduce((a, b) => (b.c > a.c ? b : a));
  const fineGrid = scan(best.d - coarse * 2, best.d + coarse * 2, fine);
  if (fineGrid.length) best = fineGrid.reduce((a, b) => (b.c < a.c ? b : a));
  // 放物線頂点
  let delta = best.d;
  const i = fineGrid.findIndex((r) => r.d === best.d);
  if (i > 0 && i < fineGrid.length - 1) {
    const [a, b, c] = [fineGrid[i - 1], fineGrid[i], fineGrid[i + 1]];
    const den = a.c - 2 * b.c + c.c;
    if (Math.abs(den) > 1e-12) {
      const sub = (0.5 * (a.c - c.c)) / den;
      if (Math.abs(sub) <= 1) delta = b.d + sub * fine;
    }
  }
  const contrast = worst.c > 0 ? (worst.c - best.c) / worst.c : 0;
  const ok = best.n >= minSamples && contrast >= minContrast;
  return {
    ok, delta, residual: best.c, n: best.n, contrast,
    reason: ok ? null : best.n < minSamples ? 'サンプル不足' : '谷が平坦（走行変化が乏しい）',
  };
}

// ---------------------------------------------------------------- sessions & anchor

/*
 * クリップの並び・連続性は creation_time + duration で判定する（NMEA ではない）。
 *
 * NMEA を使うと、測位が無いクリップ（トンネル）や先頭の測位が遅れたクリップで
 * 見かけの切れ目ができ、1本の録画が複数セッションに割れる。実測（2026-08-10、
 * 190クリップ）では 16 セッションに分断され、OBD 2時間13分に対し採用は 59 分だった。
 *
 * creation_time はローカル時刻を書く機種があるため絶対時刻としては信用できないが、
 * ここで使うのはクリップ間の差だけで、一定のオフセットは差し引きで消える。
 * 絶対時刻（アンカー A）は従来どおり NMEA から求める。
 */
const clipStart = (c) => c.creationTime;
const clipEnd = (c) => c.creationTime + c.duration;

/**
 * 時間的に重複するクリップを1本に絞る。
 * 多チャンネル機（前方/後方カメラが同名）や、EVENT/PARKING に同じ映像が複製される機種を
 * ディレクトリ名に依存せず汎用的に扱うため、重複は「時間の重なり」で判定する。
 * 優先順位は channelRank（小さいほど優先。呼び出し側が設定）→ 名前。
 */
export function dedupeOverlaps(clips, { overlapRatio = 0.5 } = {}) {
  const sorted = [...clips].sort(
    (a, b) => clipStart(a) - clipStart(b) || (a.channelRank ?? 0) - (b.channelRank ?? 0) || String(a.name).localeCompare(String(b.name))
  );
  // 重複したときに残す方の優先順位: 長く覆っている → channelRank が小さい → 名前。
  // 「先に来た方を残す」だと、EVENT の短い抜粋が本編を追い出す（下記）。
  const better = (a, b) =>
    a.duration - b.duration || (b.channelRank ?? 0) - (a.channelRank ?? 0) || String(b.name).localeCompare(String(a.name));
  const kept = [], dropped = [];
  for (const c of sorted) {
    const last = kept[kept.length - 1];
    // 重複＝同じ時間帯を覆っていること。固定の許容値では判定できない：
    // creation_time は1秒分解能で、連続録画でも隣接クリップの切れ目が実測 -3.00〜+12.43s
    // ばらつく（2026-08-10, 191クリップ）。旧 tol=0.5s では 28 件の正当な連続クリップを
    // 重複として捨て、その穴でセッションがさらに分断されていた。
    // 短い方の尺の半分を超えて重なる場合だけ重複とみなす。
    if (last && clipEnd(last) - clipStart(c) > overlapRatio * Math.min(c.duration, last.duration)) {
      // EVENT/PARKING の抜粋は NORMAL 本編と部分的に重なる。開始が early というだけで
      // 20秒の抜粋が120秒の本編を追い出すと、そこに穴が空いてセッションが分断される
      // （実測 2026-08-10 05:52: EVENT 20s が NORMAL 120s を追い出し 108s の穴）。
      if (better(c, last) > 0) { dropped.push(kept.pop()); kept.push(c); }
      else dropped.push(c);
      continue;
    }
    kept.push(c);
  }
  return { clips: kept, dropped };
}

/** 録画の連続性でクリップをセッションに分割する。測位の有無には依存しない。 */
export function groupSessions(clips, gapTol = 10) {
  const sorted = [...clips].sort((a, b) => clipStart(a) - clipStart(b));
  const out = [];
  let cur = [];
  for (const c of sorted) {
    if (cur.length && clipStart(c) - clipEnd(cur[cur.length - 1]) > gapTol) { out.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * セッションのアンカー A（連続動画 t=0 の絶対UTC）を求める。
 *   a_k = NMEA先頭(k) − S0(k)  の外れ値を除いた平均。
 * NMEA のみを使うので creation_time がローカル時刻の機種でも正しく求まる。
 * セッション先頭クリップは挙動が異なることがあるため、インデックス決め打ちではなく
 * 残差の外れ値として自動的に除外する。
 */
export function computeAnchor(session, { outlierTol = 1.5 } = {}) {
  /*
   * S0 は「連続動画の先頭からの秒」。尺を足すだけだと実際の録画の切れ目を表現できず、
   * 切れ目より前のクリップの a が系統的にずれて、まとめて外れ値として捨てられる
   * （実測 2026-08-10: 8s と 9s の切れ目があり、18本中14本が除外された）。
   * creation_time の差が尺を超える分だけ S0 を進める。
   * ただし creation_time は1秒分解能でジッタが実測 ±3s あるため、それ以下は詰めて扱う
   * （連続区間内では尺の累積のままにして、ジッタを S0 に持ち込まない）。
   */
  const GAP_MIN = 3;
  let acc = 0, prev = null;
  const rows = session.map((c) => {
    if (prev) {
      const g = c.creationTime - (prev.creationTime + prev.duration);
      acc += prev.duration + (g > GAP_MIN ? g : 0);
    }
    prev = c;
    return { clip: c, S0: acc, a: Number.isFinite(c.nmeaFirst) ? c.nmeaFirst - acc : NaN };
  });
  const totalDuration = prev ? acc + prev.duration : 0;
  // 測位の無いクリップ（トンネル等）はアンカーの材料にならないが、S0 は尺で決まるので
  // セッションからは外さない。A さえ決まれば、測位が無くても正しい時刻に置ける。
  const withFix = rows.filter((r) => Number.isFinite(r.a));
  const noFix = rows.filter((r) => !Number.isFinite(r.a)).map((r) => r.clip.name);
  const med = median(withFix.map((r) => r.a));
  const kept = withFix.filter((r) => Math.abs(r.a - med) <= outlierTol);
  const excluded = withFix.filter((r) => Math.abs(r.a - med) > outlierTol).map((r) => ({ name: r.clip.name, a: r.a }));
  const use = kept.length ? kept : withFix;
  const A = use.length ? use.reduce((s, r) => s + r.a, 0) / use.length : NaN;
  const sd = use.length ? Math.sqrt(use.reduce((s, r) => s + (r.a - A) ** 2, 0) / use.length) : NaN;
  // NMEA先頭 − creation_time（機種特性。診断用に実測する。定数化しない）
  const leads = session.map((c) => c.nmeaFirst - c.creationTime).filter(isFinite);
  return {
    A, sd, sem: sd / Math.sqrt(Math.max(use.length, 1)),
    nUsed: use.length, excluded, noFix,
    sessionDuration: totalDuration,
    nmeaLead: median(leads),
    clips: rows.map((r) => ({ name: r.clip.name, S0: r.S0, duration: r.clip.duration })),
  };
}

export function detectProfile(signatures) {
  for (const p of PROFILES) if (p.signatures.some((s) => signatures.includes(s))) return p;
  return DEFAULT_PROFILE;
}

// ---------------------------------------------------------------- manifest

/**
 * 同期マニフェストを構築する。
 * clips: [{name, creationTime, duration, nmeaFirst, nmeaLast, fixes:[...]}]
 */
export function buildManifest({ clips: inputClips, obd, gpx, profile = null, notes = [] }) {
  const signatures = [...new Set(inputClips.flatMap((c) => c.signatures || []))];
  const prof = profile || detectProfile(signatures);
  const { clips, dropped } = dedupeOverlaps(inputClips);

  const sessions = groupSessions(clips);
  // OBD は任意。無い場合はドラレコ単体（映像＋NMEA）の同期として成立する。
  const hasObd = !!(obd && obd.samples && obd.samples.length);
  const obdSpan = hasObd
    ? [obd.samples[0].t, obd.samples[obd.samples.length - 1].t]
    : [NaN, NaN];
  // OBD 区間と最も重なるセッションを選ぶ
  /*
   * OBD 区間との重なりは NMEA（真の UTC）で測る。creation_time はローカル時刻を書く
   * 機種があり、絶対時刻どうしの比較には使えない（クリップ間の差なら消えるオフセットが、
   * OBD との比較では消えない）。測位が1つも無いセッションだけ creation_time に落とす。
   */
  const sessionSpan = (s) => {
    const first = s.map((c) => c.nmeaFirst).filter(Number.isFinite);
    const last = s.map((c) => c.nmeaLast).filter(Number.isFinite);
    if (first.length) return [Math.min(...first), Math.max(...last)];
    return [clipStart(s[0]), clipEnd(s[s.length - 1])];
  };
  let session = sessions[0], bestOv = -1;
  for (const s of sessions) {
    const [a, b] = sessionSpan(s);
    // OBD が無ければ「最も長いセッション」を採る。選ぶ手掛かりが尺しかないため。
    const score = hasObd ? Math.min(b, obdSpan[1]) - Math.max(a, obdSpan[0])
                         : s.reduce((t, c) => t + c.duration, 0);
    if (score > bestOv) { bestOv = score; session = s; }
  }
  const anchor = computeAnchor(session);
  const sessFixes = session.flatMap((c) => c.fixes).sort((a, b) => a.t - b.t);

  // 基準（真値）: NMEA の位置差分速度と位置
  const refSpeed = speedFromPositions(sessFixes);
  const { series: obdSpeed, source: obdSpeedSource } = hasObd ? obdSpeedSeries(obd) : { series: [], source: 'なし' };
  const dObd = hasObd ? estimateOffset(obdSpeed, refSpeed, { moveThreshold: 5 })
                      : { ok: false, reason: 'OBDなし', delta: NaN, residual: NaN, n: 0 };

  let dGpx = { ok: false, reason: 'GPXなし', delta: NaN, residual: NaN, n: 0 };
  /*
   * マップ・標高は常に NMEA を使う。GPX は検証専用。
   *
   * このアプリはドラレコ映像がある区間しか出力せず、NMEA の無いクリップは
   * そもそも採用しないので、「NMEA が無くて GPX に助けられる」状況が構造的に無い。
   * そのうえで実測（2026-08-10, 133分・約7400点ずつ）では:
   *   位置差分速度 vs OBD  NMEA 中央0.5/95%1.6 km/h   GPX 中央0.4/95%1.4 km/h
   *   走行中の座標凍結     NMEA 0/6918 (0%)          GPX 52/7052 (0.7%)
   *   標高の垂直速度 sd    NMEA 0.58 m/s             GPX 0.78 m/s
   *   標高レンジ           NMEA 38〜680m             GPX 72〜724m
   * 位置精度は同等（むしろ GPX がわずかに良い）が、GPX は測位を失うと座標を凍結し、
   * 標高は約40m高い＝ジオイド補正されていない疑いが濃い（日本のジオイド高と一致）。
   * NMEA は品質指標(衛星数/HDOP)が付き、映像と同一受信機なので時刻オフセットの
   * 推定も1つ減る。よって既定を NMEA に固定した。
   * dGpx は引き続き計算する。位置同士の照合残差は時刻合わせが正しいことの独立な裏取りになる。
   */
  const mapSource = 'nmea';
  if (gpx && gpx.length > 20) {
    // 位置同士で照合（微分を挟まないため最も素性が良い）
    const rt = sessFixes.map((f) => f.t);
    const cost = (d) => {
      const e = [];
      for (const p of gpx) {
        const la = interpAt(rt, sessFixes.map((f) => f.lat), p.t + d);
        const lo = interpAt(rt, sessFixes.map((f) => f.lon), p.t + d);
        if (la === null || lo === null) continue;
        e.push(haversineMeters(p.lat, p.lon, la, lo));
      }
      return e.length ? { c: median(e), n: e.length } : { c: NaN, n: 0 };
    };
    // 位置照合は距離[m]なので estimateOffset を使わず専用に走らせる
    let best = null, worst = null;
    for (let d = -15; d <= 15; d += 0.1) {
      const r = { d, ...cost(d) };
      if (!isFinite(r.c)) continue;
      if (!best || r.c < best.c) best = r;
      if (!worst || r.c > worst.c) worst = r;
    }
    if (best && best.n > 200) {
      const contrast = worst.c > 0 ? (worst.c - best.c) / worst.c : 0;
      dGpx = { ok: contrast >= 0.3, delta: best.d, residual: best.c, n: best.n, contrast, unit: 'm', reason: contrast >= 0.3 ? null : '谷が平坦' };
    }
    // dGpx.ok でも mapSource は切り替えない（上記コメント参照）。GPX は検証専用。
  }

  const videoStart = anchor.A + prof.cVideo;
  const videoEnd = videoStart + anchor.sessionDuration;
  const nmeaStart = sessFixes[0].t, nmeaEnd = sessFixes[sessFixes.length - 1].t;
  // OBD をドラレコ時間軸へ載せた区間
  const obdShift = dObd.ok ? dObd.delta : 0;
  const obdStart = obdSpan[0] + obdShift, obdEnd = obdSpan[1] + obdShift;
  // OBD が無ければ共通区間は 映像∩NMEA
  const start = hasObd ? Math.max(videoStart, nmeaStart, obdStart) : Math.max(videoStart, nmeaStart);
  const end = hasObd ? Math.min(videoEnd, nmeaEnd, obdEnd) : Math.min(videoEnd, nmeaEnd);

  const warnings = [...notes];
  if (hasObd && !dObd.ok) warnings.push(`OBD↔NMEA オフセットが解けない（${dObd.reason}）。同期は信頼できない。`);
  if (gpx && gpx.length > 20 && !dGpx.ok) warnings.push('GPX↔NMEA オフセットが解けない。');
  if (prof.cVideoSource.startsWith('default')) warnings.push('cVideo が未校正（既定0、±0.6s）。GPS同期時計の撮影で確定できる。');
  const info = [];
  if (dropped.length) info.push(`時間重複で除外したクリップ ${dropped.length}本（多チャンネル/複製）。`);
  if (sessions.length > 1) info.push(hasObd
    ? `セッション ${sessions.length}件を検出し、OBD区間と最も重なる1件を採用した。`
    : `セッション ${sessions.length}件を検出し、最も長い1件を採用した。`);
  if (anchor.noFix.length) info.push(`測位の無いクリップ ${anchor.noFix.length}本（トンネル等）を尺で配置した。`);
  /*
   * δ_obd と δ_gpx の突き合わせ。OBDログと GPX は同じスマホの同じ時計で記録されるので
   * 両者は一致するはず。δ_obd は車速（微分を経由）、δ_gpx は位置（微分なし）から独立に
   * 解いているため、一致すれば δ_obd が正しいことの独立な裏取りになる。
   * δ_obd は表示・グラフ・途絶補完の全てが依存する最重要パラメータなので、ここが
   * 食い違うなら他を疑う前にまずこれを疑う。実測は 0.01s / 0.10s（2セッション）。
   */
  if (dObd.ok && dGpx.ok) {
    const gap = Math.abs(dObd.delta - dGpx.delta);
    if (gap > 0.5) warnings.push(`時刻合わせが2経路で食い違う（車速由来 ${dObd.delta.toFixed(2)}s / 位置由来 ${dGpx.delta.toFixed(2)}s、差 ${gap.toFixed(2)}s）。同期が信頼できない。`);
    else info.push(`時刻合わせを GPX で独立検証（車速由来と位置由来の差 ${gap.toFixed(2)}s）。`);
  }
  if (anchor.excluded.length) warnings.push(`アンカーから除外: ${anchor.excluded.slice(0, 5).map((e) => e.name).join(', ')}${anchor.excluded.length > 5 ? ` 他${anchor.excluded.length - 5}本` : ''}`);
  if (hasObd && Math.abs(obdShift) > 60) warnings.push(`スマホ時計オフセットが異常に大きい（${obdShift.toFixed(1)}s）。要確認。`);
  if (!(end > start)) warnings.push(hasObd ? '映像・NMEA・OBD の共通区間が存在しない。' : '映像と NMEA の共通区間が存在しない。');

  return {
    generated: new Date().toISOString(),
    profile: { name: prof.name, cVideo: prof.cVideo, cVideoSource: prof.cVideoSource, signatures },
    session: {
      anchorUtc: anchor.A,
      videoStartUtc: videoStart,
      duration: anchor.sessionDuration,
      anchorSd: anchor.sd, anchorSem: anchor.sem, anchorNUsed: anchor.nUsed,
      nmeaLeadMeasured: anchor.nmeaLead,
      excludedFromAnchor: anchor.excluded,
      noFixClips: anchor.noFix,
      clips: anchor.clips,
    },
    offsets: {
      // 時刻変換: 動画時間 S = (t_phone + delta) − videoStartUtc
      obd: { delta: dObd.delta, residual: dObd.residual, unit: 'km/h', n: dObd.n, contrast: dObd.contrast, ok: dObd.ok, source: obdSpeedSource, measured: true },
      gpx: { delta: dGpx.delta, residual: dGpx.residual, unit: dGpx.unit || 'm', n: dGpx.n, contrast: dGpx.contrast, ok: dGpx.ok, measured: !!dGpx.ok },
      video: { delta: prof.cVideo, measured: !prof.cVideoSource.startsWith('default'), note: prof.cVideoSource },
    },
    window: { startUtc: start, endUtc: end, durationSec: end - start },
    coverage: {
      video: [videoStart, videoEnd],
      nmea: [nmeaStart, nmeaEnd],
      obd: hasObd ? [obdStart, obdEnd] : null,
    },
    data: { hasObd, obdDids: hasObd ? obd.dids : [], obdStats: hasObd ? obd.stats : null, mapSource,
            nFixes: sessFixes.length, nObd: hasObd ? obd.samples.length : 0, nGpx: gpx ? gpx.length : 0,
            nClipsInput: inputClips.length, nClipsDeduped: clips.length, nSessions: sessions.length },
    info,
    warnings,
  };
}

/** 絶対UTC → 連続動画時間 S、および (クリップ, クリップ内秒) への変換 */
export function makeTimeline(manifest) {
  const clips = manifest.session.clips;
  const vs = manifest.session.videoStartUtc;
  return {
    utcToS: (utc) => utc - vs,
    sToUtc: (S) => vs + S,
    phoneToS: (t, which = 'obd') => t + (manifest.offsets[which].ok ? manifest.offsets[which].delta : 0) - vs,
    locate: (S) => {
      for (const c of clips) if (S >= c.S0 && S < c.S0 + c.duration) return { clip: c.name, offset: S - c.S0 };
      return null;
    },
  };
}

// ---------------------------------------------------------------- 測位途絶の補完
/*
 * トンネル等で測位が途切れた区間を、OBD の車速と道路形状から埋める。
 *
 * 前提と根拠（2026-08-10 関越トンネル 往復で実測）:
 *  - 車速の積分と OSRM の経路長は 11km で 0.18% 一致する。位置は数 m で復元できる。
 *  - 端点の測位は信用できない。進入側は坑口内 140m まで解が出るが衛星4個/HDOP6.3 で
 *    標高が壊れる。脱出側は坑口外 44m で再獲得するが受信機が未収束で標高が 6.4m 飛ぶ。
 *    前者は HDOP、後者は滑らかさでしか捕まらないので両方で判定する。
 *  - トンネルの同定は不要。端点と進行方位さえあれば経路は一意に決まる。
 */

/** 参照車速。位置の妥当性判定に使う。 */
export function makeSpeedAt(obdSamples, obdDelta = 0) {
  const sp = obdSamples.filter((x) => Number.isFinite(x.vsp)).map((x) => ({ t: x.t + obdDelta, v: x.vsp }));
  if (!sp.length) return () => null;
  return (t) => {
    if (t < sp[0].t || t > sp[sp.length - 1].t) return null;
    let lo = 0, hi = sp.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sp[m].t <= t) lo = m; else hi = m; }
    const w = sp[hi].t > sp[lo].t ? (t - sp[lo].t) / (sp[hi].t - sp[lo].t) : 0;
    return sp[lo].v + (sp[hi].v - sp[lo].v) * w;
  };
}

/**
 * 補完すべき区間の [前, 後] インデックス対を返す。
 *
 * **時間の欠落だけでは足りない。** 端末が測位を失っても最後の既知位置を返し続ける
 * ことがあり、その場合は点が 1 秒間隔で出続けるので時間では検出できない。
 * 実測（2026-08-09 関越 北行き, Pixel 10）では 5 分半にわたり座標が完全に同一のまま
 * 点が出続け、時間基準では「途絶ゼロ」だった。
 * よって位置が車速と整合しない区間も途絶として扱う。
 */
export function findTrackGaps(fixes, minGap = 10, speedAt = null, { maxSpdDev = 25 } = {}) {
  const out = [];
  const bad = new Array(fixes.length).fill(false);
  if (speedAt) {
    for (let i = 1; i < fixes.length; i++) {
      const dt = fixes[i].t - fixes[i - 1].t;
      if (dt <= 0 || dt > 30) continue;
      const ref = speedAt((fixes[i].t + fixes[i - 1].t) / 2);
      if (ref == null) continue;
      const v = (haversineMeters(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon) / dt) * 3.6;
      // 区間の終端側だけを不良にする。凍結列なら最後の実位置が端点として残る
      if (Math.abs(v - ref) > maxSpdDev) bad[i] = true;
    }
  }
  let i = 1;
  while (i < fixes.length) {
    if (fixes[i].t - fixes[i - 1].t >= minGap || bad[i]) {
      let a = i - 1; while (a > 0 && bad[a]) a--;
      let b = i;     while (b < fixes.length - 1 && bad[b]) b++;
      if (fixes[b].t - fixes[a].t >= minGap) out.push([a, b]);
      i = b + 1;
    } else i++;
  }
  /*
   * 隣接・近接する途絶は繋げる。間に挟まった数点は端点として信用できない
   * （トンネルを出た直後に数秒だけ良い点が出て、また凍結する例が実測であった）。
   * 分けたまま解こうとすると、凍結点を端点にした経路探索が破綻する（実測 1.3km の
   * 区間に 53.7km の経路が返った）。
   */
  const merged = [];
  for (const g of out) {
    const last = merged[merged.length - 1];
    if (last && (g[0] - last[1] <= 3 || fixes[g[0]].t - fixes[last[1]].t <= 5)) last[1] = g[1];
    else merged.push([...g]);
  }
  return merged;
}

/**
 * 境界から内側へ、信用できない測位を剥がして端点を選ぶ。
 * side='tail' は途絶の手前側（末尾へ向かって剥がす）、'head' は復帰側。
 * トンネル形状には依存しない。市街地の高架下など測位が切れる場面すべてに同じ判定が使える。
 */
export function trimAnchor(fixes, idx, side, { minSats = 6, maxHdop = 2, maxVertDev = 3, maxSpdDev = 25, maxDrop = 60, speedAt = null } = {}) {
  const step = side === 'tail' ? -1 : 1;
  const dropped = [];
  let i = idx;
  for (let k = 0; k < maxDrop; k++) {
    const f = fixes[i];
    if (!f) break;
    /*
     * ⓪位置の妥当性。端末は測位を失っても座標を返し続けることがある。
     * 実測（2026-08-10 関越, Pixel 10 + Geolocation API）では 109km/h 走行中に
     * 座標が完全に同一の点が 25 秒続き、その間も標高だけは更新されていた。
     * **座標が凍っても標高は動くので、垂直の判定では捕まらない。**
     * 端末や OS に依存しない判定にするため、機構は問わず
     * 「位置差分から出る速度が車速と合うか」だけで見る。
     */
    if (speedAt) {
      const nb = fixes[i + step];
      const ref = speedAt(f.t);
      if (nb && ref != null) {
        const dt = Math.abs(nb.t - f.t);
        if (dt > 0 && dt < 30) {
          const v = (haversineMeters(f.lat, f.lon, nb.lat, nb.lon) / dt) * 3.6;
          if (Math.abs(v - ref) > maxSpdDev) {
            dropped.push({ t: f.t, ele: f.ele, why: `位置差分速度 ${v.toFixed(0)}km/h が車速 ${ref.toFixed(0)}km/h と不一致` });
            i += step; continue;
          }
        }
      }
    }
    // ①測位品質。進入側の劣化はここで捕まる（衛星 11→4, HDOP 0.86→6.35）
    if ((f.hdop != null && f.hdop >= maxHdop) || (f.ns != null && f.ns < minSats)) {
      dropped.push({ t: f.t, ele: f.ele, why: `衛星${f.ns} HDOP${f.hdop}` }); i += step; continue;
    }
    // ②垂直速度の滑らかさ。再獲得直後の未収束はここでしか捕まらない（HDOP は正常なまま）
    const inner = [];
    for (let j = 1; j <= 11; j++) { const g = fixes[i + step * j]; if (g && g.ele != null) inner.push(g); }
    const rates = [];
    for (let j = 1; j < inner.length; j++) {
      const dt = Math.abs(inner[j].t - inner[j - 1].t);
      if (dt > 0 && dt < 3) rates.push((inner[j].ele - inner[j - 1].ele) / (inner[j].t - inner[j - 1].t));
    }
    if (rates.length && f.ele != null && inner.length) {
      rates.sort((a, b) => a - b);
      const med = rates[rates.length >> 1];
      const nb = inner[0], dt = nb.t - f.t;
      if (Math.abs(dt) > 0 && Math.abs(dt) < 3) {
        const rate = (nb.ele - f.ele) / dt;
        if (Math.abs(rate - med) > maxVertDev) {
          dropped.push({ t: f.t, ele: f.ele, why: `垂直速度 ${rate.toFixed(1)}m/s (近傍中央値 ${med.toFixed(1)})` });
          i += step; continue;
        }
      }
    }
    break;
  }
  return { index: i, fix: fixes[i], dropped };
}

/** 2点間の進行方位[deg]。OSRM の bearings 拘束に使う。 */
function bearingDeg(a, b) {
  const y = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  return ((Math.atan2(y, b.lat - a.lat) * 180) / Math.PI + 360) % 360;
}

/**
 * OSRM で 2 点間の経路を引く。進行方位で拘束するのが要点。
 * 拘束しないと分離帯のある道路で反対車線にスナップし、次の IC まで行って折り返す
 * 経路を返す（実測: 9.0km の区間に 25.5km ＝ +182%）。
 */
export async function routeBetween(a, b, brgA, brgB, { server = 'https://router.project-osrm.org', range = 45, radius = 50, fetchImpl = null } = {}) {
  // fetch を裸で受け取ると this が外れてブラウザで Illegal invocation になりうる
  const doFetch = fetchImpl || ((u) => fetch(u));
  const u = `${server}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}`
    + `?overview=full&geometries=geojson&bearings=${Math.round(brgA)},${range};${Math.round(brgB)},${range}&radiuses=${radius};${radius}`;
  const r = await doFetch(u);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes || !j.routes.length) return { ok: false, reason: `OSRM: ${j.code}` };
  const g = j.routes[0].geometry.coordinates.map((c) => ({ lat: c[1], lon: c[0] }));
  const cum = [0];
  for (let i = 1; i < g.length; i++) cum.push(cum[i - 1] + haversineMeters(g[i - 1].lat, g[i - 1].lon, g[i].lat, g[i].lon));
  return { ok: true, pts: g, cum, length: cum[cum.length - 1], osrmLength: j.routes[0].distance };
}

/** 経路上の弧長 s[m] における緯度経度。 */
function alongRoute(route, s) {
  const { pts, cum } = route;
  if (s <= 0) return pts[0];
  if (s >= cum[cum.length - 1]) return pts[pts.length - 1];
  let lo = 0, hi = cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m; }
  const w = (s - cum[lo]) / (cum[hi] - cum[lo]);
  return { lat: pts[lo].lat + (pts[hi].lat - pts[lo].lat) * w, lon: pts[lo].lon + (pts[hi].lon - pts[lo].lon) * w };
}

/**
 * 車速を台形則で積分して累積距離を返す。
 * OBD 自身の欠測も内挿で埋める。飛ばすと距離が抜ける（実測 17秒 = 520m）。
 */
export function integrateDistance(samples, t0, t1, { maxHole = 30 } = {}) {
  const s = samples.filter((x) => x.t >= t0 && x.t <= t1 && Number.isFinite(x.vsp));
  if (s.length < 2) return null;
  const out = [{ t: s[0].t, d: 0 }];
  let d = 0, bridged = 0;
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (dt <= 0 || dt > maxHole) continue;
    if (dt > 3) bridged += dt;
    d += ((s[i].vsp + s[i - 1].vsp) / 2 / 3.6) * dt;
    out.push({ t: s[i].t, d });
  }
  // 端の未被覆（最初/最後のサンプルと境界時刻の差）を等速で補う
  const head = (s[0].t - t0) * (s[0].vsp / 3.6);
  const tail = (t1 - s[s.length - 1].t) * (s[s.length - 1].vsp / 3.6);
  return { series: out, total: d + head + tail, head, tail, bridged, n: s.length };
}

/*
 * 標高の基準面を国土地理院の GSIGEO2011 に揃える。
 *
 * ドラレコ受信機が出す `$GPGGA` の標高は、受信機内蔵のジオイドモデルを基準にしている。
 * このモデルが粗く、200km 走っても 37.7〜38.8m しか動かない（真のジオイド高は同区間で
 * 41.8〜43.0m 変化する）。結果として標高が系統的に約 3.8m 高く出る。
 *
 * `$GPGGA` の 11番目に受信機が使ったジオイド高が入るので、楕円体高
 * `h = 標高 + 受信機のジオイド高` を保存したまま `H = h − N_GSIGEO2011` を計算し直す。
 * 実測（2026-08-10 の 202.9km、20点）で差は −3.82 ± 0.55m。ほぼ定数なので、
 * 数点だけ照会して平均を引けば足りる。
 *
 * これで平地区間の DEM とのオフセットが −6.06 → −2.24m（Copernicus）、
 * −5.12 → −1.30m（国土地理院レーザ）まで縮む。
 *
 * 補正量は勾配を持たないので、走行抵抗からの標高復元（閉合する）や消費エネルギーには
 * ほとんど効かない。効くのは標高の絶対値と、DEM や他機器との比較。
 *
 * 日本国外では国土地理院の API が値を返さないので、補正せず理由を返す。
 */
export async function applyGeoid(fixes, { samples = 8, onProgress } = {}) {
  const cand = fixes.filter((f) => f.ele != null && f.sep != null && !f.estimated);
  if (cand.length < 2) return { ok: false, why: 'ジオイド高を持つ測位点が無い（$GPGGA 11番目が空）' };
  const step = Math.max(1, Math.floor(cand.length / samples));
  const picks = [];
  for (let i = 0; i < cand.length && picks.length < samples; i += step) picks.push(cand[i]);

  const diffs = [];
  for (const f of picks) {
    onProgress && onProgress(`ジオイド高を照会中… ${diffs.length + 1}/${picks.length}`);
    const u = 'https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh/cgi/geoidcalc.pl' +
              `?outputType=json&latitude=${f.lat.toFixed(6)}&longitude=${f.lon.toFixed(6)}`;
    // 国土地理院の API は断続的に落ちるので数回試す（点数が減ると平均が荒れる）
    for (let k = 0; k < 3; k++) {
      try {
        const r = await fetch(u);
        if (r.ok) {
          const g = parseFloat(((await r.json()) || {}).OutputData?.geoidHeight);
          if (isFinite(g)) { diffs.push(f.sep - g); break; }   // 受信機のジオイド高 − 真のジオイド高
        }
      } catch (e) { /* 次の試行へ */ }
      await new Promise((x) => setTimeout(x, 600));
    }
    await new Promise((x) => setTimeout(x, 250));    // 公共APIなので間隔を空ける
  }
  if (diffs.length < 3) return { ok: false, why: `ジオイド高を取得できたのが ${diffs.length}点（日本国外か API 不通）` };

  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / diffs.length);
  for (const f of fixes) if (f.ele != null) f.ele -= mean;
  return { ok: true, offset: mean, sd, n: diffs.length };
}

/*
 * 走行抵抗から勾配を逆算して標高を復元する。
 *
 *   sinθ = ( P/v − ½ρ·CdA·(v−w)² ) / (m·g) − a/g − Crr      w = 追い風[m/s]
 *
 * 質量・CdA・Crr は GPS 標高が既知の区間で事前に適合する（m=1675kg, Crr=0.008 で
 * 標高 RMS 4.74m）。区間ごとに解く自由度は**相対風速 w だけ**にして、出口標高へ閉合させる。
 *
 * **CdA = 0.64。** 当初 0.67 を固定値として使っていたが、その値には CdA 単独の同定根拠が
 * 無かった。走行抵抗を車速の2乗で回帰して空気抵抗と転がり抵抗を分離すると 0.631
 * （n=7968, r=0.94、質量を 1460〜1700kg で振っても 0.596〜0.643）。下の「開放路で 0.64」、
 * および下の追い風 2.8〜3.4m/s との整合も 0.64 を指す。3通りの独立な推定が 0.63〜0.64 に
 * 集まり 0.67 だけが外れたため 0.64 に統一した（2026-08-13）。
 * 詳細は fl4-profile-simulator/docs/road-load-cda.md。
 *
 * **CdA を可変にしてはいけない。** CdA は形状の量で状況では変わらない。
 * 当初 CdA を自由度にしたところトンネル内で 0.50、開放路で 0.64 という値が出たが、
 * 変化していたのは車体形状ではなく相対風速。一方通行トンネルでは交通が空気を
 * 進行方向へ引きずる（ピストン効果）ため追い風になり、空気抵抗が減る。
 * 実測では上下線とも追い風 2.8〜3.4 m/s（外部風なら片方は向かい風になるはずで、
 * 両ボアとも追い風＝各ボアの交通による流れであることの裏付け）。開放路では 0.6〜1.3 m/s。
 *
 * 定速では w と CdA・Crr は縮退して区別できないが、いずれも閉合が吸収するので
 * 復元形への影響は小さい（CdA を ±13% 振っても復元形は 0.5m しか動かない）。
 * 効くのは質量だけ。
 */
const RHO = 1.2, G = 9.80665;

function integrateGrade(samples, t0, t1, { mass, cda, crr, wind = 0 }) {
  const s = samples.filter((x) => x.t >= t0 && x.t <= t1 && Number.isFinite(x.vsp) && Number.isFinite(x.psys));
  let d = 0;
  const p = [{ s: 0, h: 0, t: s.length ? s[0].t : t0 }];
  for (let i = 1; i < s.length; i++) {
    const dt = s[i].t - s[i - 1].t;
    if (dt <= 0 || dt > 30) continue;
    const v = (s[i].vsp + s[i - 1].vsp) / 2 / 3.6;
    if (v < 5) continue;
    d += v * dt;
    const a = (s[i].vsp - s[i - 1].vsp) / 3.6 / dt;
    const vr = Math.max(0, v - wind);                    // 相対風速。追い風で減る
    const sin = ((s[i].psys * 1000) / v - 0.5 * RHO * cda * vr * vr) / (mass * G) - a / G - crr;
    p.push({ s: d, h: p[p.length - 1].h + sin * v * dt, t: s[i].t });
  }
  return p;
}

/** 出口標高に閉合するよう相対風速を解く（単調なので二分法）。 */
export function reconstructElevation(samples, t0, t1, eleStart, eleEnd, { mass = 1675, cda = 0.64, crr = 0.008, windRange = [-20, 20] } = {}) {
  const dE = eleEnd - eleStart;
  let [lo, hi] = windRange;
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    const p = integrateGrade(samples, t0, t1, { mass, cda, crr, wind: m });
    if (!p.length || p.length < 2) return null;
    if (p[p.length - 1].h < dE) lo = m; else hi = m;   // 追い風↑ で抵抗↓ → 積算高度↑
  }
  const wind = (lo + hi) / 2;
  const p = integrateGrade(samples, t0, t1, { mass, cda, crr, wind });
  if (p.length < 2) return null;
  const L = p[p.length - 1].s;
  return {
    wind, length: L,
    closed: Math.abs(p[p.length - 1].h - dE) < 0.5,
    /** 弧長 s[m] における標高[m] */
    at(s) {
      if (s <= 0) return eleStart;
      if (s >= L) return eleEnd;
      let a = 0, b = p.length - 1;
      while (b - a > 1) { const m = (a + b) >> 1; if (p[m].s <= s) a = m; else b = m; }
      const w = (s - p[a].s) / (p[b].s - p[a].s);
      return eleStart + p[a].h + (p[b].h - p[a].h) * w;
    },
  };
}

/**
 * 途絶区間を 1 つ埋める。合格判定に落ちたら null を返す（黙って通さない）。
 * 返す点はすべて estimated:true。位置は裏付けがあるが標高は推定なので、
 * 表示側で実測と区別できるようにすること。
 */
export async function fillOneGap(fixes, gap, obdSamples, opts = {}) {
  const hasObd = !!(obdSamples && obdSamples.length);
  const { minGapMeters = 100, lengthTolPct = 8, stepMeters = 25, obdDelta = 0,
          mass = 1675, cda = 0.64, crr = 0.008, speedBand = [0.4, 1.6],
          driveSpeed = [8, 140] } = opts;
  const [ia, ib] = gap;
  const speedAt = opts.speedAt || (hasObd ? makeSpeedAt(obdSamples, obdDelta) : null);
  const topts = { ...opts, speedAt };
  const A = trimAnchor(fixes, ia, 'tail', topts);
  const B = trimAnchor(fixes, ib, 'head', topts);
  if (!A.fix || !B.fix) return null;
  const before = fixes[Math.max(0, A.index - 5)], after = fixes[Math.min(fixes.length - 1, B.index + 5)];
  if (!before || !after) return null;
  const T = B.fix.t - A.fix.t;
  if (!(T > 0)) return null;

  const route = await routeBetween(A.fix, B.fix, bearingDeg(before, A.fix), bearingDeg(B.fix, after), opts);
  if (!route.ok) return { ok: false, reason: route.reason, anchors: { A, B } };
  if (route.length < minGapMeters) return null;

  /*
   * 距離をどう時間に配分するか。
   *
   * OBD 車速があれば積分する。経路長との一致は実測 0.03〜0.20% で、これが合否判定にもなる。
   *
   * 無い場合は **経路長 ÷ 途絶時間の一定速度**にする。両端の GPS 速度を補間する手もあるが、
   * 両端はトンネルの「外」で測った値で、それを内部全体の形として持ち込むのは情報の無い
   * 区間への外挿になる。一定速度は「総距離と総時間だけ分かっている」という最小限の主張で
   * 止まる。実測（関越 北行き 10.9km/401s）で両方式の位置差は最大 183m（全長の1.67%、
   * 中央付近）で両端では一致する。この 183m が内部位置の不確かさの目安。
   */
  let series, distTotal, errPct = 0, bridged = 0;
  if (hasObd) {
    const d = integrateDistance(obdSamples.map((x) => ({ t: x.t + obdDelta, vsp: x.vsp })), A.fix.t, B.fix.t);
    if (!d || d.total < minGapMeters) return null;
    errPct = ((d.total - route.length) / route.length) * 100;
    if (Math.abs(errPct) > lengthTolPct) {
      return { ok: false, anchors: { A, B },
               reason: `経路長 ${(route.length / 1000).toFixed(2)}km と車速積分 ${(d.total / 1000).toFixed(2)}km が ${errPct.toFixed(1)}% 乖離` };
    }
    series = d.series; distTotal = d.total; bridged = d.bridged;
  } else {
    /*
     * 一定速度なので「経路長と仮定距離の一致」は恒等式になり検査にならない。
     * 代わりに **含意される平均速度が両端の実測速度と釣り合うか**を見る。同じ検査の言い換えで、
     * 反対車線にスナップした経路（実測 9.0km の区間に 25.5km）なら 229km/h になって落ちる。
     * 幅を広めに取るのは、トンネル内の渋滞で実際に大きく落ちることがあるため。
     */
    const vAvg = (route.length / T) * 3.6;
    /*
     * まず絶対値で「走行として成立するか」を見る。両端の速度との比だけで判定していたら、
     * **停車中の途絶で判定ごと無効になっていた**（両端が 0km/h だと基準が作れないため）。
     * 実測でそれが牙を剥いた:
     *   30秒の途絶に 3.568km の経路 → 428km/h  （駐車場で測位が飛んだ）
     *   83分の途絶に 0.460km の経路 → 0.33km/h（駐車中。走っていない）
     * 速すぎる側も遅すぎる側も、走行の補完としては成り立たない。
     */
    if (vAvg < driveSpeed[0] || vAvg > driveSpeed[1]) {
      const why = vAvg > driveSpeed[1]
        ? '経路探索が実際と違う道を返している'          // 速すぎる＝遠回りの経路を掴んでいる
        : '走行ではなく停車中の測位途絶と思われる';      // 遅すぎる＝そもそも走っていない
      return { ok: false, anchors: { A, B },
               reason: `経路 ${(route.length / 1000).toFixed(2)}km を ${T.toFixed(0)}s で走る想定になり平均 ${vAvg.toFixed(0)}km/h。${why}` };
    }
    const vEnd = [A.fix.spd, B.fix.spd].filter(Number.isFinite);
    const vRef = vEnd.length ? vEnd.reduce((a, b) => a + b, 0) / vEnd.length : NaN;
    if (Number.isFinite(vRef) && vRef > 5) {
      const r = vAvg / vRef;
      if (r < speedBand[0] || r > speedBand[1]) {
        return { ok: false, anchors: { A, B },
                 reason: `経路 ${(route.length / 1000).toFixed(2)}km を ${T.toFixed(0)}s で走る想定になり平均 ${vAvg.toFixed(0)}km/h。両端の実測 ${vRef.toFixed(0)}km/h と釣り合わない` };
      }
      errPct = (r - 1) * 100;
    }
    series = [];
    for (let t = 0; t <= T; t += 1) series.push({ t: A.fix.t + t, d: (route.length * t) / T });
    distTotal = route.length;
  }

  /*
   * 標高は OBD の駆動パワーが要る（走行抵抗から勾配を逆算する）。無ければ復元しない。
   * 両端の標高を距離で按分する手もあるが、勾配が一定という無根拠な仮定を
   * 実測と同じ線で見せることになるので採らない。補完点の標高は null にする。
   */
  const ele = hasObd
    ? reconstructElevation(obdSamples.map((x) => ({ t: x.t + obdDelta, vsp: x.vsp, psys: x.psys })),
                           A.fix.t, B.fix.t, A.fix.ele, B.fix.ele, { mass, cda, crr })
    : null;

  // 累積距離 → 経路上の位置。距離は経路長に合わせて正規化する
  const k = route.length / distTotal;
  const pts = [];
  for (const q of series) {
    const s = q.d * k;
    if (pts.length && s - pts[pts.length - 1]._s < stepMeters) continue;
    const p = alongRoute(route, s);
    pts.push({ t: q.t, lat: p.lat, lon: p.lon, ele: ele ? ele.at(s) : null, estimated: true, _s: s });
  }
  return {
    ok: true, pts, route, anchors: { A, B },
    stats: { lengthKm: route.length / 1000, integratedKm: distTotal / 1000, errPct, wind: ele ? ele.wind : null,
             speedSource: hasObd ? 'OBD車速の積分' : '経路長÷途絶時間の一定速度',
             bridgedSec: bridged, droppedFixes: A.dropped.length + B.dropped.length },
  };
}

/** トラック全体の途絶を埋める。実測点はそのまま、補完点は estimated:true が付く。 */
export async function fillTrackGaps(fixes, obdSamples, opts = {}) {
  // 位置の妥当性判定に使う参照速度。OBD が無ければ測位自身のドップラ速度を使う
  // （位置とは別に測られているので、座標が凍った場合の検出に効く）。
  const speedAt = (obdSamples && obdSamples.length)
    ? makeSpeedAt(obdSamples, opts.obdDelta ?? 0)
    : makeSpeedAt(fixes.filter((f) => Number.isFinite(f.spd)).map((f) => ({ t: f.t, vsp: f.spd })), 0);
  const gaps = findTrackGaps(fixes, opts.minGap ?? 10, speedAt, opts);
  const reports = [];
  const inserts = [];
  const drop = new Set();          // 補完で置き換えた区間の元データ（凍結点など）
  for (const gap of gaps) {
    let r = null;
    try { r = await fillOneGap(fixes, gap, obdSamples, { ...opts, speedAt }); }
    catch (e) { r = { ok: false, reason: e.message }; }
    if (!r) continue;
    reports.push({ from: fixes[gap[0]].t, to: fixes[gap[1]].t, ...(r.ok ? { ok: true, ...r.stats } : { ok: false, reason: r.reason }) });
    if (!r.ok) continue;           // 置き換えられないなら元データは消さない（消して黙るより残して警告）
    inserts.push(...r.pts.map((p) => ({ t: p.t, lat: p.lat, lon: p.lon, ele: p.ele, estimated: true })));
    for (let i = r.anchors.A.index + 1; i < r.anchors.B.index; i++) drop.add(i);
  }
  const out = [];
  for (let i = 0; i < fixes.length; i++) if (!drop.has(i)) out.push({ ...fixes[i], estimated: false });
  const merged = [...out, ...inserts].sort((a, b) => a.t - b.t);
  return { fixes: merged, reports, dropped: drop.size };
}
