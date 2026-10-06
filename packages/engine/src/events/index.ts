/**
 * events/index.ts ─ 事件种类 → handler 表。新增事件种类 = 加一个 kind + 一个 handler + TimingEventMap 若干行。
 */
import type { EventHandlers } from '../core/types.js'
import {
  onAskCard,
  onCardEffect,
  onCardRespond,
  onCardsMove,
  onCardUse,
  onDrawCards,
} from './cards.js'
import { onGameStart, onPhase, onTurn } from './game.js'
import { onDamage, onDeath, onDying, onLoseHp, onRecover } from './hp.js'
import { onJudge } from './judge.js'

/** 全部 M1 事件的 handler 表(runEvent 按 ev.kind 查找) */
export const handlers: EventHandlers = {
  GameStart: onGameStart,
  Turn: onTurn,
  Phase: onPhase,
  DrawCards: onDrawCards,
  CardsMove: onCardsMove,
  AskCard: onAskCard,
  CardUse: onCardUse,
  CardRespond: onCardRespond,
  CardEffect: onCardEffect,
  Damage: onDamage,
  LoseHp: onLoseHp,
  Recover: onRecover,
  Dying: onDying,
  Death: onDeath,
  Judge: onJudge,
}
