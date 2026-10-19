import type { ReactElement } from 'react'
import type { PanelMode, Tone } from '@shared/types'
import { ToneSelect } from './ToneSelect'

interface ToolbarProps {
  /** Which mode this run is in, so the labels match what the button will do. */
  direction: PanelMode
  tone: Tone
  busy: boolean
  copied: boolean
  canCopy: boolean
  canRegenerate: boolean
  canLearn: boolean
  onToneChange: (tone: Tone) => void
  onGenerate: () => void
  onCopy: () => void
  onLearn: () => void
  onRegenerate: () => void
  onCancel: () => void
}

/**
 * The whole vocabulary of the panel: pick a tone, run the request, then Copy it or Learn from it.
 * There is no Save button here on purpose, and none anywhere else either: Learn is the one study
 * act, and asking for the note is what files the sentence - the user has nothing to tend.
 *
 * Tone shapes the language the user is about to write, so the picker is not offered while the
 * panel is explaining text someone else wrote. Learn is offered in both modes: whichever one the
 * user is in, the sentence worth studying is still the learning-language one.
 */
export function Toolbar(props: ToolbarProps): ReactElement {
  const express = props.direction === 'express'
  return (
    <div className="toolbar">
      {express ? <ToneSelect value={props.tone} disabled={props.busy} onChange={props.onToneChange} /> : null}
      <button
        type="button"
        className="button button--primary"
        onClick={props.onGenerate}
        disabled={props.busy}
      >
        {express ? 'Generate' : 'Explain'}
      </button>
      <button type="button" className="button" onClick={props.onCopy} disabled={!props.canCopy}>
        {props.copied ? '✓ Copied' : 'Copy'}
      </button>
      <button type="button" className="button" onClick={props.onLearn} disabled={props.busy || !props.canLearn}>
        Learn
      </button>
      <button
        type="button"
        className="button"
        onClick={props.onRegenerate}
        disabled={props.busy || !props.canRegenerate}
      >
        重新生成
      </button>
      {props.busy ? (
        <button type="button" className="button button--ghost" onClick={props.onCancel}>
          取消
        </button>
      ) : null}
    </div>
  )
}
