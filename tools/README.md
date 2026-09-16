# 検証ツール

## flow.js の描画

`lib/flow.js` を DOM のシムの上で動かして、描画結果を機械的に検査する。ブラウザは要らない。

**座標を手で書き写す作りなので、目視では取り違えに気づけない。** 2026-09-01 の横長
レイアウト追加では、この3つのうち2つが実機に出す前に捕まえられなかった不具合を出した。

| スクリプト | 見るもの | 捕まえた不具合 |
|---|---|---|
| `flow-snapshot.mjs` | 縦長 380×600 の描画結果を全属性まで文字列化 | — （回帰の検出用） |
| `flow-geometry.mjs` | 横長 640×240 の**重なり** | ラベルが MOT 箱に乗る、車輪と車速が重なる |
| `flow-direction.mjs` | 縦長と横長で**矢印の向き**が一致するか | 力行で MOT⇔車輪 が逆 |

## 使い方

```bash
node tools/flow-snapshot.mjs | diff tools/golden-portrait.txt -   # 縦長に変化が無いこと
node tools/flow-geometry.mjs                                      # 横長の重なり
node tools/flow-direction.mjs                                     # 矢印の向き
```

`golden-portrait.txt` は縦長の描画結果を固定したもの。**`replay.html` と `video.html` は
縦長で呼ぶので、そこが変わらないことが両アプリの回帰試験になる。** 縦長を意図的に
変えたときは `node tools/flow-snapshot.mjs > tools/golden-portrait.txt` で撮り直す。

## 検査の中身

- **flow-geometry** … 文字×箱・文字×文字・文字×線・線×箱・枠外。
  文字の外接矩形は Courier の字送り 0.6em で近似する。**箱の中に完全に収まっている
  文字はその箱のラベルなので除外する**（しないと全部が干渉として出る）。
  透明度 0.3 以下（非活性の枝）は対象外。
- **flow-direction** … 各矢印の端点を最寄りのノードへ写像し、`ENG→GEN` のような
  組の集合を縦長と横長で突き合わせる。重なりの検査は向きを見ないので別に要る。
- 状態は EV力行 / EV回生 / SERIES / DIRECT / TRANS60 / TRANS60逆 の6通り。
  **回生と genMot（GEN がエンジンを回す側）は向きが反転する枝があるので必ず含める。**

## 2920 デコードの一致

`lib/did2920.js` が DID 22 29 20 の byte offset と係数の唯一の定義元。使う側は4つある。

| 使う側 | 入口 | 入力 |
|---|---|---|
| `index.html` | `parse22_2920` | BLE 実時間（hex 文字列） |
| `replay.html` | `parseFrames` | ログ再生（hex 文字列） |
| `viewer.html` | `compute2920` | ログビュワー（hex 文字列） |
| `video/sync.js` | `parseObdLog` | 動画同期・CLI（バイト配列） |

```bash
node tools/did2920-parity.mjs <走行ログ.txt>   # 4実装が同じ値を出すこと
```

実ログの全 2920 フレームで `vsp/rpm/mode/pbat/peng/pgen/pdrive/psys/v12` を突き合わせ、
食い違えば終了コード 1。**共通化する前は pgen の係数だけ 0.13% ずれていた**
（`index`・`viewer` は導出式 `0.02/0.535 × 2π/60 / 1000`、`replay`・`sync` は
丸めた `3.92e-6`）。値がずれても画面は出るので、目視では気づけない。
