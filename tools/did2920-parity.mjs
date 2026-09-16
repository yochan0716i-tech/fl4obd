/*
 * 622920 のデコードが4実装で一致するかを実ログで確かめる。
 *
 *   index.html   parse22_2920   （BLE 実時間。hex 文字列）
 *   replay.html  parseFrames    （ログ再生。hex 文字列）
 *   viewer.html  compute2920    （ログビュワー。hex 文字列）
 *   video/sync.js parseObdLog   （動画同期・CLI。バイト配列）
 *
 * 共通化の前後で同じ値が出ることを見るための道具。ブラウザは要らない。
 *   node tools/did2920-parity.mjs <ログ.txt>
 */
import { readFile } from 'node:fs/promises';

const ROOT = new URL('..', import.meta.url);
const src = f => readFile(new URL(f, ROOT), 'utf8');

/* 名前付き関数/定数の宣言を波括弧の対応で切り出す（ページを丸ごと eval しないため） */
function slice(text, head) {
  const i = text.indexOf(head);
  if (i < 0) throw new Error('見つからない: ' + head);
  let d = 0, j = text.indexOf('{', i);
  for (let k = j; k < text.length; k++) {
    if (text[k] === '{') d++;
    else if (text[k] === '}' && --d === 0) return text.slice(i, k + 1);
  }
  throw new Error('閉じ括弧が見つからない: ' + head);
}
const line = (text, re) => text.split('\n').filter(l => re.test(l)).join('\n');

const [idxSrc, repSrc, viwSrc] = await Promise.all(
  ['index.html', 'replay.html', 'viewer.html'].map(src));
const { parseObdLog, deriveTelemetry } = await import(new URL('video/sync.js', ROOT));
/* 各ページは module 化して lib/did2920.js を import している。ここでは
 * 切り出した関数へ同じものを引数で注入し、呼び出し側の使い方を突き合わせる。 */
const M = await import(new URL('lib/did2920.js', ROOT));

/* ---- index.html ---------------------------------------------------- */
const idxEnv = new Function('CAL', 'decode2920', 'powers', `
  const D = {}; let systemVolt = 0, socPrevT = 0;
  const updateStableMode = m => m;
  ${slice(idxSrc, 'function parse22_2920')}
  return hex => { for (const k in D) delete D[k]; D.soc = NaN;
    parse22_2920(hex);
    return { vsp: D.vsp, rpm: D.engRot, mode: D.runMode, pbat: D.pbat,
             peng: D.peng, pgen: D.pgen, pdrive: D.pdrive, psys: D.psys, v12: systemVolt }; };
`)(M.CAL, M.decode2920, M.powers);

/* ---- replay.html --------------------------------------------------- */
const repEnv = new Function('CAL', 'decode2920', 'powers', `
  ${slice(repSrc, 'function reassemble')}
  ${slice(repSrc, 'function parseFrames')}
  return { reassemble, parseFrames };
`)(M.CAL, M.decode2920, M.powers);

/* ---- viewer.html --------------------------------------------------- */
const viwEnv = new Function('CAL', 'decode2920', 'powers', `
  ${slice(viwSrc, 'function compute2920')}
  return compute2920;
`)(M.CAL, M.decode2920, M.powers);

/* ---- 実行 ----------------------------------------------------------- */
const file = process.argv[2];
if (!file) { console.error('使い方: node tools/did2920-parity.mjs <ログ.txt>'); process.exit(2); }
const log = await readFile(file, 'utf8');

const hexes = [];
for (const l of log.split(/\r?\n/)) { const h = repEnv.reassemble(l); if (h) hexes.push(h); }

const rep = repEnv.parseFrames(log);
const obd = parseObdLog(log); deriveTelemetry(obd);
const syn = obd.samples;

console.log(`ログ ${file.replace(/.*\//, '')}`);
console.log(`  フレーム数  hex ${hexes.length} / replay ${rep.length} / sync ${syn.length}`);

const FIELDS = ['vsp', 'rpm', 'mode', 'pbat', 'peng', 'pgen', 'pdrive', 'psys', 'v12'];
const n = Math.min(hexes.length, rep.length, syn.length);
const worst = {};
for (let i = 0; i < n; i++) {
  const a = idxEnv(hexes[i]), b = viwEnv(hexes[i]), c = rep[i], d = syn[i];
  for (const f of FIELDS) {
    const vs = [a[f], b[f], c[f], d[f]].filter(Number.isFinite);
    if (vs.length < 2) continue;
    const spread = Math.max(...vs) - Math.min(...vs);
    const scale = Math.max(1e-9, ...vs.map(Math.abs));
    const rel = spread / scale;
    if (!worst[f] || rel > worst[f].rel) worst[f] = { rel, spread, i, vals: vs };
  }
}
console.log(`  比較 ${n} フレーム`);
let bad = 0;
for (const f of FIELDS) {
  const w = worst[f];
  if (!w) { console.log(`  ${f.padEnd(7)} —（どの実装も出さない）`); continue; }
  const ok = w.rel < 1e-9;
  if (!ok) bad++;
  console.log(`  ${f.padEnd(7)} ${ok ? '一致' : '差あり'}  最大相対差 ${w.rel.toExponential(2)}`
    + (ok ? '' : `  @${w.i}  ${w.vals.map(v => v.toPrecision(8)).join(' / ')}`));
}
process.exit(bad ? 1 : 0);
