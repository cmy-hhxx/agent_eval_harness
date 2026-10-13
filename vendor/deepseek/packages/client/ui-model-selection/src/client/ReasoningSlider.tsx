import { useEffect, useId, useState, type CSSProperties } from 'react'
import { IconGaugeOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ReasoningSlider.module.css'

interface EffortChoice {
  effort: string | undefined
  label: string
}

const adjustmentKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'])
const particles = [[7, 38], [8, 26], [13, 31], [19, 40], [29, 54], [36, 34], [42, 49], [49, 33], [53, 28], [55, 40], [62, 45], [68, 62], [73, 29], [81, 44], [88, 31], [94, 57]]

/** Preview locally while dragging; persist one advertised effort on release. */
export function ReasoningSlider({ choices, value, defaultValue, busy, onCommit, t }: {
  choices: readonly EffortChoice[]
  value: string | undefined
  defaultValue: string | undefined
  busy: boolean
  onCommit: (effort: string | undefined) => void
} & PropsLocale<'model'>) {
  const selected = choices.findIndex(choice => choice.effort === value)
  const [draft, setDraft] = useState(Math.max(0, selected))
  const id = useId()
  useEffect(() => { if (!busy) setDraft(Math.max(0, selected)) }, [selected, busy])
  const index = Math.min(draft, Math.max(0, choices.length - 1))
  const choice = choices[index]
  const maximum = Math.max(0, choices.length - 1)
  const isMaximum = maximum > 0 && index === maximum
  const progress = maximum === 0 ? 0 : index / maximum
  const resetIndex = choices.findIndex(item => item.effort === defaultValue)
  const description = choice?.effort === undefined ? 'effort.defaultHint'
    : choice.effort === 'off' || choice.effort === 'none' ? 'effort.offHint'
      : progress < .4 ? 'effort.fastHint' : progress < .75 ? 'effort.balancedHint' : 'effort.deepHint'
  const commit = (next: number): void => {
    const target = choices[next]
    if (!busy && target !== undefined && target.effort !== value) onCommit(target.effort)
  }
  return (
    <div className={css.card} data-reasoning-card data-maximum={isMaximum} style={{ '--effort-progress': `${progress * 100}%` } as CSSProperties}>
      <div className={css.heading}>
        <IconGaugeOutlineRegular className={css.icon} size={20} />
        <div className={css.copy}>
          <output className={css.level} htmlFor={`${id}-slider`} aria-live="polite">{choice?.label ?? value ?? t('effort.providerDefault')}</output>
          <div className={css.hint} id={`${id}-hint`}>{t(description)}</div>
        </div>
        <button className={css.reset} type="button" aria-label={t('effort.reset')} title={t('effort.reset')}
          disabled={busy || resetIndex < 0 || (value === defaultValue && draft === selected)}
          onClick={() => { setDraft(resetIndex); commit(resetIndex) }}>
          {busy ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular size={20} />}
        </button>
      </div>
      <div className={css.control}>
        <div className={css.track} aria-hidden="true">
          <div className={css.fill}>
            {isMaximum && <div className={css.particles}>
              {particles.map(([x, y], n) => <i key={n} style={{ left: `${x}%`, top: `${y}%`, width: n % 4 === 0 ? 3 : 2, height: n % 4 === 0 ? 3 : 2, animationDelay: `${-n * .37}s` }} />)}
            </div>}
          </div>
        </div>
        <input id={`${id}-slider`} className={css.slider} type="range" min={0} max={maximum} step={1} value={index}
          aria-label={t('menu.effort')} aria-valuetext={choice?.label ?? value ?? t('effort.providerDefault')}
          aria-describedby={`${id}-hint`} disabled={busy || choices.length < 2}
          onChange={event => { setDraft(Number(event.currentTarget.value)) }}
          onPointerDown={event => { event.currentTarget.setPointerCapture?.(event.pointerId) }}
          onPointerUp={event => { commit(Number(event.currentTarget.value)) }}
          onPointerCancel={() => { setDraft(Math.max(0, selected)) }}
          onKeyDown={event => {
            if (adjustmentKeys.has(event.key)) event.stopPropagation()
            if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit(index) }
          }}
          onKeyUp={event => { if (adjustmentKeys.has(event.key)) commit(Number(event.currentTarget.value)) }}
        />
      </div>
    </div>
  )
}
