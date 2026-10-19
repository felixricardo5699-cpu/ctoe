import type { ChangeEvent, ReactElement } from 'react'
import { TONES, TONE_LABELS, isTone, type Tone } from '@shared/types'

interface ToneSelectProps {
  value: Tone
  disabled?: boolean
  onChange: (tone: Tone) => void
}

export function ToneSelect({ value, disabled = false, onChange }: ToneSelectProps): ReactElement {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value
    if (isTone(next)) onChange(next)
  }

  return (
    <label className="tone">
      <span className="visually-hidden">语气</span>
      <select className="tone__select" value={value} disabled={disabled} onChange={handleChange}>
        {TONES.map((tone) => (
          <option key={tone} value={tone}>
            {TONE_LABELS[tone]}
          </option>
        ))}
      </select>
    </label>
  )
}
