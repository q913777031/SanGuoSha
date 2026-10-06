import type { CardId, PlayerId, PublicPlayerView } from '@sgs/engine'
import { useEffect, useRef } from 'react'

import {
  cardInfo,
  cardNameZh,
  HUMAN,
  isRed,
  PLAYABLE_NAMES,
  playerName,
  promptText,
  rankLabel,
  SUIT_SYMBOL,
} from './game/labels.js'
import {
  canConfirm,
  selectableCards,
  targetableSeats,
  useGame,
  type GameUiState,
} from './game/store.js'

const PHASE_ZH: Record<string, string> = {
  prepare: '准备',
  judge: '判定',
  draw: '摸牌',
  play: '出牌',
  discard: '弃牌',
  finish: '结束',
}

/** 体力:实心勾玉 = 当前体力,空心 = 已损失 */
function Hp({ hp, maxHp }: { hp: number; maxHp: number }) {
  return (
    <span className="hp" aria-label={`体力 ${hp}/${maxHp}`}>
      {Array.from({ length: maxHp }, (_, i) => (
        <i key={i} className={i < hp ? 'on' : 'off'} />
      ))}
    </span>
  )
}

/** 一张实体牌的牌面 */
function CardFace({ id, small = false }: { id: CardId; small?: boolean }) {
  const c = cardInfo(id)
  return (
    <span className={`face ${isRed(c.suit) ? 'red' : 'black'} ${small ? 'small' : ''}`}>
      <span className="corner">
        {SUIT_SYMBOL[c.suit]}
        {rankLabel(c.rank)}
      </span>
      <span className={`name ${c.zh.length > 2 ? 'long' : ''}`}>{c.zh}</span>
    </span>
  )
}

/** 对手座位;可点选为目标时高亮 */
function Seat({
  p,
  active,
  waiting,
  targetable,
  targeted,
  onPick,
}: {
  p: PublicPlayerView
  active: boolean
  waiting: boolean
  targetable: boolean
  targeted: boolean
  onPick: (id: PlayerId) => void
}) {
  const cls = [
    'seat',
    p.alive ? '' : 'dead',
    active ? 'active' : '',
    waiting ? 'waiting' : '',
    targetable ? 'targetable' : '',
    targeted ? 'targeted' : '',
  ].join(' ')
  return (
    <button type="button" className={cls} disabled={!targetable} onClick={() => onPick(p.id)}>
      <span className="seat-name">{playerName(p.id)}</span>
      {p.alive ? <Hp hp={p.hp} maxHp={p.maxHp} /> : <span className="dead-mark">阵亡</span>}
      <span className="seat-hand">手牌 {p.handCount}</span>
      {targeted && <span className="target-badge">目标</span>}
    </button>
  )
}

function Log({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <ol className="log" ref={ref} aria-live="polite">
      {lines.map((l, i) => (
        <li key={i} className={l.startsWith('第 ') ? 'turn-line' : ''}>
          {l}
        </li>
      ))}
    </ol>
  )
}

function isCardSelected(s: GameUiState, card: CardId): boolean {
  const req = s.request
  if (req?.kind === 'chooseCards') {
    const cand = req.candidates.find((c) => c.card === card)
    return cand !== undefined && s.selected.includes(cand.index)
  }
  return s.selected.includes(card)
}

/**
 * 原型主界面:上方对手、中间桌面与战报、下方自己的手牌与操作。
 * 手机横屏优先,竖屏也可玩。
 */
export function App() {
  const s = useGame()
  const { view, request, result } = s

  useEffect(() => {
    if (!useGame.getState().view) useGame.getState().newGame()
  }, [])

  if (!view) return <main className="app loading">洗牌中…</main>

  const me = view.players[HUMAN]
  const others = view.players.filter((p) => p.id !== HUMAN)
  const selectable = selectableCards(request)
  const targetable = targetableSeats(s)
  const turnPlayer = view.turn?.player ?? null
  const phase = view.turn?.phase ? PHASE_ZH[view.turn.phase] : ''
  const myTurn = turnPlayer === HUMAN

  const cancelLabel =
    request?.kind === 'play' ? '结束出牌' : request?.kind === 'askCard' ? '不出' : null
  const confirmLabel = request?.kind === 'chooseCards' ? '弃置' : '出牌'

  return (
    <main className="app">
      <header className="topbar">
        <span className="brand">三国杀</span>
        <span className="status">
          {turnPlayer !== null && (
            <>
              {playerName(turnPlayer)}的回合 · {phase}阶段
            </>
          )}
        </span>
        <span className="pile">牌堆 {view.drawPileCount}</span>
        <button type="button" className="ghost" onClick={() => s.newGame()}>
          重开
        </button>
      </header>

      <section className="seats" aria-label="对手">
        {others.map((p) => (
          <Seat
            key={p.id}
            p={p}
            active={turnPlayer === p.id}
            waiting={view.waitingFor === p.id}
            targetable={targetable.has(p.id)}
            targeted={s.targets.includes(p.id)}
            onPick={(id) => s.toggleTarget(id)}
          />
        ))}
      </section>

      <section className="table">
        <div className="played" aria-label="桌面">
          {s.table.length === 0 && <span className="hint">桌面空空</span>}
          {s.table.map((t) => (
            <figure key={t.key} className="play">
              {t.card !== null ? (
                <CardFace id={t.card} small />
              ) : (
                <span className="face small">{cardNameZh(t.name)}</span>
              )}
              <figcaption>{playerName(t.player)}</figcaption>
            </figure>
          ))}
        </div>
        <Log lines={s.logs} />
      </section>

      <section className={`me ${myTurn ? 'active' : ''}`}>
        <div className="me-bar">
          <span className="seat-name">你</span>
          <Hp hp={me?.hp ?? 0} maxHp={me?.maxHp ?? 0} />
          <span className="prompt">
            {result
              ? result.winners.includes(HUMAN)
                ? '你赢了!'
                : result.winners.length === 0
                  ? '平局'
                  : `${result.winners.map(playerName).join('、')} 获胜`
              : request
                ? promptText(request)
                : view.waitingFor !== null
                  ? `等待 ${playerName(view.waitingFor)}…`
                  : ''}
          </span>
          {s.error && <span className="error">{s.error}</span>}
          <span className="actions">
            {result ? (
              <button type="button" className="primary" onClick={() => s.newGame()}>
                再来一局
              </button>
            ) : (
              request && (
                <>
                  {cancelLabel && (
                    <button type="button" className="ghost" onClick={() => s.cancel()}>
                      {cancelLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary"
                    disabled={!canConfirm(s)}
                    onClick={() => s.confirm()}
                  >
                    {confirmLabel}
                  </button>
                </>
              )
            )}
          </span>
        </div>
        <div className="hand" aria-label="手牌">
          {view.hand.length === 0 && <span className="hint">没有手牌</span>}
          {view.hand.map((id) => {
            const can = selectable.has(id)
            const sel = isCardSelected(s, id)
            const future = !PLAYABLE_NAMES.has(cardInfo(id).name)
            return (
              <button
                type="button"
                key={id}
                className={`card ${can ? 'can' : ''} ${sel ? 'sel' : ''} ${future ? 'future' : ''}`}
                disabled={!can}
                onClick={() => s.toggleCard(id)}
                title={future ? '后续版本开放' : undefined}
              >
                <CardFace id={id} />
              </button>
            )
          })}
        </div>
      </section>
    </main>
  )
}
