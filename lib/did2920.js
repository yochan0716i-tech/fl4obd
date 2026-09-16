/*
 * did2920.js — DID 22 29 20 のフィールド定義と物理換算（唯一の定義元）
 *
 * index.html / replay.html / viewer.html / video/sync.js が共用する。
 * 以前は4か所に同じ byte offset と係数を書き写していて、pgen の係数だけ
 * 既に 0.13% ずれていた（index・viewer は導出式、replay・sync は 3.92e-6 の
 * 丸め値）。ずれても画面は出るので気づけない。ここが変われば全部が変わる。
 *
 * 由来は embedded/knowledge/fl4-did-map.md（トルクスケール・係数群）と
 * docs/soc-interpolation.md（SOC_K）。
 *
 * ES モジュール。classic script のページからは
 *   <script type="module">import * as X from './lib/did2920.js'; …</script>
 * ではなく、ページ側の script を type="module" にして import する。
 * 一致は tools/did2920-parity.mjs が実ログで確かめる。
 */

/* off90(bit720) = gen_trq(発電機トルク, 生信号)。2920単独で独立に物理換算する。
 * ENG-GEN同軸ゆえ定常の torque balance 比例部分: eng_trq_Nm ≈ gen_trq_Nm。
 * 走行ログ散布図(eng_trq vs gen_trq)の比例係数 |gen_trq|/eng_trq ≈ 0.535 と
 * eng_trqスケール 0.02Nm/LSB から: gen_trqスケール = 0.02/0.535 ≈ 0.0374 Nm/LSB。
 * ※散布図のx切片(≈300LSB)は機械損失(フリクション)。比例部分のみ換算に使い、切片は除外。
 * P_gen[kW] = gen_trq_Nm * eng_rpm * (2π/60)/1000  (同軸: gen_rpm=eng_rpm)。発電時 gen_trq<0 → 符号反転で正。
 */
export const GEN_TRQ_NM = 0.02 / 0.535;                             // ≈0.0374 Nm/LSB

export const CAL = {
  COEF_ENG: 2.09e-6,                                                // P_eng[kW]   = COEF_ENG × eng_trq(raw) × rpm
  COEF_GEN: GEN_TRQ_NM * (2 * Math.PI / 60) / 1000,                 // ≈3.915e-6   = COEF_GEN × (-gen_trq(raw)) × rpm
  COEF_TRC: 0.000147,                                               // P_drive[kW] = COEF_TRC × drv_trq(raw) × 車速
  SOC_K: -192,                                                      // ΔSOC[%] = SOC_K × ∫Pbat[kWh]（2923真値で最適化した短窓係数。net容量係数154でなく）
};

/* 応答 62 29 20 の先頭からの byte offset。フィールドマップの bit 位置 = (offset-2)*8 */
export const OFF = {
  vsp: 15,        // 車速[km/h] = spd_echo (start104,len8)
  v12: 16,        // 12V系電圧 ×0.1V/LSB (PID42と等価・高レート)
  accel: 19,      // APS1（logger byte17）
  mode: 79,       // 走行モード(616,8,flag) ※値は10進(20/40/50…)
  pbat: 86,       // batt_pwr(672,16,BE,s) ×0.01kW
  drv: 90,        // drv_trq3(704,16,BE,s)
  gen: 92,        // gen_trq (720,16,BE,s) ※発電時<0
  eng: 96,        // eng_trq (752,16,BE,s)
  rpm: 100,       // eng_rpm (784,16,BE,u) ÷4
  coolant: 102,   // 冷却水温 −40℃
};

/** rpm まで読むのに必要な最小長。coolant は 103 バイト以降にしか無い。 */
export const MIN_BYTES = 102;

/*
 * APS1（アクセルペダルセンサ）を踏み込み率[%]に直す。
 *
 * 生値は PID49 と同じ `A×100/255` で、これは**センサの電圧比であってペダル
 * 踏み込み率ではない**。APS は断線検出のため下端に余裕を持たせてあり、
 * 足を完全に離しても 0 にならない。
 *
 * 実測（走行ログ 22 本）: 床 19.22–19.61 %（49–50 LSB、1 LSB 以内で安定）、
 * 全開 94.9–95.3 %（242–243 LSB）。この 2 点で正規化する。
 *
 * これをやらないと「足を離しているのにアクセル 20%」と表示される。
 */
const APS_FLOOR = 19.4, APS_FULL = 95.1;
const apsPedal = raw => Math.max(0, Math.min(100, ((raw * 100 / 255 - APS_FLOOR) / (APS_FULL - APS_FLOOR)) * 100));

/* hex 文字列（"622920…"）とバイト配列のどちらでも読めるようにする */
function reader(src) {
  if (typeof src === 'string') {
    const u16 = i => parseInt(src.substr(i * 2, 4), 16);
    return { len: src.length / 2, u8: i => parseInt(src.substr(i * 2, 2), 16), u16 };
  }
  return { len: src.length, u8: i => src[i], u16: i => (src[i] << 8) | src[i + 1] };
}

/**
 * 2920 応答を物理量へ。長さが足りなければ null。
 * @param {string|Uint8Array|number[]} src 62 29 20 から始まる応答
 */
export function decode2920(src) {
  const r = reader(src);
  if (r.len < MIN_BYTES) return null;
  const s16 = i => { const v = r.u16(i); return v >= 0x8000 ? v - 0x10000 : v; };
  return {
    vsp: r.u8(OFF.vsp),
    v12: r.u8(OFF.v12) * 0.1,
    accel: apsPedal(r.u8(OFF.accel)),
    mode: r.u8(OFF.mode),
    pbat: s16(OFF.pbat) * 0.01,
    drv: s16(OFF.drv),
    gen: s16(OFF.gen),
    eng: s16(OFF.eng),
    rpm: r.u16(OFF.rpm) / 4,
    coolant: r.len > OFF.coolant ? r.u8(OFF.coolant) - 40 : NaN,
  };
}

/** 直結（50 / 70）ではエンジン出力が機械的に車輪へ足される */
export const isDirect = mode => mode === 50 || mode === 70;

/**
 * decode2920 の生フィールドから電力[kW]を出す。
 * @param {{eng:number,gen:number,drv:number,rpm:number,vsp:number,mode:number}} f
 */
export function powers(f) {
  const peng = CAL.COEF_ENG * f.eng * f.rpm;                        // エンジン機械出力
  const pgen = CAL.COEF_GEN * (-f.gen) * f.rpm;                     // 発電機出力(発電=正)
  const pdrive = CAL.COEF_TRC * f.drv * f.vsp;                      // 車輪(TRC)出力
  return { peng, pgen, pdrive, psys: pdrive + (isDirect(f.mode) ? peng : 0) };
}
