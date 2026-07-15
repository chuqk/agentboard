---
id: D-2026-002
status: accepted
scope: agentboard
applies_to:
  - src/server/logPoller.ts (orphanCandidates 構築)
  - src/server/logPollData.ts (knownSessions による enrich スキップ)
triggers:
  - agent_sessions テーブルの肥大 (数千〜万行) を掃除・GC したくなった時
  - orphan rematch の対象範囲・性能を変更する時
  - コールドスタートが再び遅くなった / probe 即死ループが再発した時
  - AGENTBOARD_INACTIVE_MAX_AGE_HOURS の意味を変える時
watch:
  - History 窓 (168h) 以内の orphan が数千件に膨らんだ場合、フィルタ後も rematch が分単位に戻る
supersedes: null
decided_at: 2026-07-15
decided_by: ちゅっく (daimon 発注書 2026-07-12 logpoll-scaling-and-orphan-gc の点火、soma セッションから実施)
source_session: b7d252b1-a5f6-483d-b92f-7ca33f7d7e8f (soma)
summary: 古参 orphan の GC は「DB から削除」ではなく「rematch 候補からの age フィルタ除外」で行う。DB 行は knownSessions として全走査時の全文読みを防ぐ盾なので、削除すると次の走査で未知ファイル扱い → 全文 enrich → 再 insert のループになり、掃除が自分で汚れを再生産する。
---

# 古参 orphan は DB から消さない — 行の存在自体が再読み防止の盾

## Context

orphan rematch が DB の全 windowless セッション (11,848 行、うち History 窓 168h 超が
10,567) に対し毎コールドスタートで全文 token count を回し、数分の I/O + match worker
120s 占有 → 通常 poll 停滞 → probe 沈黙 → 3連敗 kill → 永遠のコールドスタート
(2026-07-12 即死ループ)。daimon 発注書は「log_poll の増分化 + orphan 1万件の GC
(削除 or アーカイブ)」を求めた。

実測で切り分けた結果、ファイル走査は無罪 (subagents スキップ済みで 14k 列挙+stat 0.6s)。
重いのは orphan rematch の全文読みだけだった。

## Decision

orphanCandidates 構築時に `historySessionMaxAgeHours` (既存 env
AGENTBOARD_INACTIVE_MAX_AGE_HOURS、稼働値 168h) を超えた lastActivityAt の行を除外する
(686aebf)。**DB 行は削除しない**。History 窓超えのセッションは UI に出ず wake もできない
ので、rematch は純粋な無駄。実測: 1,228 件 / rematch 完了 ~11s (従来数分)、
コールドスタート直後の probe 4連発 200。

## Rejected alternatives and why

- **DB から削除**: 行が消えると logFilePath が knownSessions から外れ、次の全走査で
  mtime 上位に入った瞬間「未知のファイル」として全文 enrich (token count) → 条件を満たせば
  再 insert → また orphan、の**再生産ループ**になる。DB 行の存在自体が「このファイルは
  読み済み」の印として働いている
- **archived フラグ列の追加**: 効果は同じだがスキーマ変更 + 全取得系メソッドの分岐追加の
  割に、age フィルタ (1 条件) と実効が変わらない
- **transcript (jsonl) 側の削除・アーカイブ**: agentboard の権限外 (~/.claude/projects は
  Claude Code の資産。排水・soma チャット等が日々増やす)

## Consequences

- agent_sessions テーブルは減らない (11k 行残置)。行数自体の実害は毎 poll の全件 map
  構築数十 ms のみ
- probe (bashboard health_check) 復活済み — 再発時は 686aebf とこの DR を疑う
- History 窓を伸ばす (env 変更) と rematch 対象も一緒に増える連動を持った

## Revisit when

- History 窓内の orphan が常態で数千件になり、rematch が再び分単位になった時
  (その時は rematch のバッチ上限 or token count の早期打ち切りを検討)
- agent_sessions の行数がクエリ性能に効き始めた時 (その時は「削除 + 別テーブルの
  既読パス台帳」のセット設計が必要 — 削除単体は上記ループで禁止)
