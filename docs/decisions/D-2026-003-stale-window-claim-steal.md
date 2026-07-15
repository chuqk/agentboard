---
id: D-2026-003
status: accepted
scope: agentboard
applies_to:
  - src/server/logPoller.ts (claimWindowEvictingStaleOccupant / rematch 経路)
  - src/server/logMatchWorker.ts (unclaimedWindows の stale 例外)
  - src/server/logMatchGate.ts (STALE_WINDOW_CLAIM_MS / isWindowClaimStale)
triggers:
  - window↔session の紐付け固着・lastUserMessage が古い指示のまま更新されない時
  - claimed window の扱い (steal 可否・条件) を変更したくなった時
  - name fallback (hydrate / rematch) の温存条件を変更する時
  - 「同じ window で claude を再起動したのに一覧が旧セッションを指す」報告が来た時
watch:
  - stale_window_claim_stolen が誤発火する場合 (生きた window が奪われる) は content match の tie-break を疑う
supersedes: null
decided_at: 2026-07-15
decided_by: ちゅっく (通知内容ズレの修正依頼、soma セッションから実施)
source_session: 20ca1cd2-3c09-4d6b-8c53-22d5fd95eed7 (soma)
summary: claimed window は「占有ログが10分以上沈黙 + 候補ログの方が新しい + 窓の画面内容が候補ログと一致」の3条件で steal 可能とする。従来の「絶対に奪わない」は same-window 再起動 (/wrap→新セッション) で永久固着する — 占有側は name fallback で温存され、候補側は claimed 除外でマッチ機会ゼロの相互ロック。name だけの一致では今後も steal しない (内容一致が唯一の退去証拠)。
---

# claimed window は stale なら steal 可能 — 「絶対に奪わない」は same-window 再起動で永久固着する

## Context

「火葬 の許可待ち / 作業中の指示: /wrap」という push 通知の内容が実セッションの
作業と食い違った (2026-07-15)。原因は window `dev:@62` の紐付けが 7/11 に /wrap で
終わった transcript に4日間固着し、現役 transcript が追跡から外れていたこと。
lastUserMessage だけでなく duo の transcript 解決・wake 対象も古いログを指していた。

固着は設計上の相互ロックだった:

- **占有側が退去しない**: startup verification が inconclusive でも、tmux window 名と
  displayName の一致 (「火葬」==「火葬」) で orphan を免除する name fallback がある
- **候補側が入れない**: match worker が claimed window を content match の対象から
  除外していた (「logPoller refuses to steal」— 当時は無駄削減として正しい前提)

同一 window で claude を立ち上げ直す運用では毎回この形になる。ユーザー発言が画面に
映るたびにマッチ機会はあったが、claimed 除外で全て捨てられていた (この環境は tmux
history がほぼ無く、発言はすぐ画面外へ流れる — 照合機会は発言直後の数瞬しかない)。

## Decision

steal を3条件の AND で許可する (b09ec0e):

1. **占有セッションのログが `STALE_WINDOW_CLAIM_MS` (10分) 以上沈黙** — idle 判定。
   閾値は「ごく新しい claim を steal 経路から外す」ためだけの保険
2. **候補セッションのログの lastActivityAt が占有側より厳密に新しい**
3. **window の画面内容が候補ログと content match** — これが唯一の実証的な退去証拠。
   生きて idle な window は自分の会話を表示しているので他ログに奪われない

worker は stale claim の window を unclaimedWindows に含め、main thread の
`claimWindowEvictingStaleOccupant()` が occupant を orphan (行は残す・D-2026-002)
してから claim する。パス内で claim したばかりの window は Set ガードで steal 対象外
(claim 直後でも lastActivityAt が古いログはありうるため、新しさだけでは守れない)。

**name fallback 経路は今後も steal しない** — 名前の一致は内容の証拠ではない。

実証: デプロイ数分後、ユーザーが当該 window で /wrap を打った直後の poll (5s 間隔)
で stale_window_claim_stolen が発動し、4日固着が自然解消した。

## Rejected alternatives and why

- **DB 直接 UPDATE で紐付けを手術**: 実装した修正をバイパスする一回性の対症で、
  auto mode 分類器も「ユーザーが承認していない共有リソース介入」として拒否。
  修正が自然に効く経路 (次のユーザー発言) が数分先にあった
- **hydrate の name fallback を弱める (鮮度条件を足す)**: external window は
  rematch の name fallback 対象外 (managed のみ) のため、一度 orphan されると
  content match が効かない環境では戻れず、wake が別 window を作る恐れ
- **soma 側で通知の鮮度ガード** (lastActivity が古い lastUserMessage を出さない):
  誤情報を無情報に落とすだけの対症。steal 実装後は固着の寿命が「次の発言まで」に
  縮み、観測機会がほぼ消えるため費用対効果が低い。bridge はサーバー再起動の采配
  (別管轄) も要る
- **閾値なしの即時 steal**: resume 直後 (新旧ログが同内容) で tie が新ログ側に
  振れた瞬間に生きた claim を奪うリスク。10分の沈黙保険は安い

## Consequences

- 同一 window での agent 再起動 (/wrap→新セッション、--resume) は、次のユーザー
  発言直後の poll で自動的に紐付けが追随する
- 画面にユーザー発言が映らない限り交代は起きない (tmux history が浅い環境では
  startup rematch だけでは直らない — 発言待ち)
- 誤 steal の防波堤は content match の精度に一本化された。tie は null (steal
  不成立) に倒れる

## Revisit when

- stale_window_claim_stolen が「生きた window」で発火した事例が出た時
  (STALE_WINDOW_CLAIM_MS の引き上げ or 条件追加)
- name fallback 側にも steal を求める声が出た時 (このDRの「名前は証拠ではない」
  と衝突する — 内容証拠なしの steal は誤紐付けの再生産)
- tmux history-limit を引き上げて content match の機会が構造的に増えた時
  (閾値・経路の再検討余地)
