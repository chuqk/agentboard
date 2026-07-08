---
id: D-2026-001
status: accepted
scope: agentboard
applies_to:
  - src/server/logger.ts
triggers:
  - logger.ts の stream / transport 構成を変更する時
  - ログのパフォーマンス改善 (async 化・worker 化・バッファリング) を検討する時
  - 起動時ハング・0 バイトログ・「証拠が残らない」障害の調査時
watch:
  - 同期書き出し (pretty 整形含む) がログ高頻度化でレイテンシ源にならないか (現状は低頻度の構造化イベントログのみ)
supersedes: null
decided_at: 2026-07-08
decided_by: ちゅっく (daimon 発注書 order-agentboard-spawn-timeout-2026-07-08 の点火)
source_session: 6541ba51-e89c-48c4-910a-1f4f78bf7795
summary: ログは全パスでメインスレッド同期書き出し (pino-pretty を sync stream として直接使う)。pino.transport() の worker thread は禁止 — イベントループ凍結時にバッファ済みログごと固まり、障害の証拠がプロセス内に一切残らない (2026-07-07 の 0 バイト ghost ログ)。
---

## Context

2026-07-07、起動時の timeout なし spawnSync (getTailscaleIp) が tailscaled 無応答に当たり、
ポート bind 直後・accept 開始前にイベントループが約19時間凍結、Cloudflare が 502 を返し続けた。

このとき ghost の stdout キャプチャログは **0 バイト** — 旧実装の `pino.transport()` (worker
thread) は、メインスレッドが worker の準備完了ハンドシェイクを処理する前に凍結すると、キュー済みの
起動ログごと永久に flush されない。障害クラスそのものの証拠がプロセス内に残らなかった。

SIGKILL 実験で再現確認済み: ログ→イベントループ凍結→SIGKILL で、worker transport は 0 バイト、
sync stream は書いた行が残る (`logger.test.ts` の回帰テストとして固定)。

## Decision

- 全パス (dev / production / file あり / なし) を **メインスレッド同期書き出し**に統一する
  - stdout: `pino-pretty` を factory として直接呼び sync stream 化 (`destination: 1, sync: true`)。
    pino-pretty が無い環境 (compiled binary) は `pino.destination({ dest: 1, sync: true })` の raw JSON
  - file: 従来どおり `pino.destination({ sync: true })`
- `pino.transport()` (worker thread) は使わない
- 副次効果: worker_threads の無い compiled Bun binary でも pretty 出力が動く。dev/production の
  分岐は「config デフォルトの file 出力を dev で抑制」のみに縮小

## Rejected alternatives and why

- **起動完了後に transport へ切り替え** (発注書の原案): 切替機構の複雑さに対し、ランタイム中の
  凍結・クラッシュでは同じ穴が残る。ログ頻度が低いので常時 sync で足りる
- **worker transport 維持 + 起動ログのみ同期**: 同上。二重の logger 経路は保守コストだけ増える
- **event loop lag monitor の常時運用で検知** (発注書初版案): モニタ自体が凍ったループ上の
  setInterval であり、この障害クラスには原理的に無力 (発注書自身が改訂で棄却)。起動凍結の検知は
  bashboard 側の HTTP health check が受け持つ

## Consequences

- ログ書き込み (pretty 整形含む) はメインスレッドをブロックする。現状の低頻度イベントログでは
  無視できる。高頻度ログを足したくなったら、worker 化ではなく頻度側 (レベル・サンプリング) で絞る
- 凍結・SIGKILL・クラッシュのどの死に方でも、直前までのログが stdout (ghost ログ) と
  LOG_FILE の両方に残る
- 回帰ガード: `logger.test.ts`「logs written before an event-loop freeze survive a SIGKILL」

## Revisit when

- ログが高頻度化して同期書き出しが計測可能なレイテンシ源になった時 (その時も worker transport
  復活ではなく、頻度削減や出力先の見直しを先に検討)
- pino / pino-pretty のメジャー更新で sync stream の API・挙動が変わった時
