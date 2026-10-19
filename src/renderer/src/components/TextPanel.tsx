import type { ChangeEvent, ReactElement, ReactNode, RefObject } from 'react'

interface TextPanelProps {
  label: string
  /** Extra class for the label, e.g. when the label is a question instead of a category. */
  labelClassName?: string
  value: string
  placeholder?: string
  /**
   * Writing direction of the text inside the box. 'auto' lets the browser decide from the
   * first strong character, which is what mixed text (an Arabic meaning quoting English)
   * needs; the input box passes the direction of the language being typed instead.
   */
  dir?: 'ltr' | 'rtl' | 'auto'
  readOnly?: boolean
  inputRef?: RefObject<HTMLTextAreaElement | null>
  onChange?: (value: string) => void
  /** Extra controls (clipboard buttons) rendered on the label row. */
  actions?: ReactNode
}

/** Both halves of the tool are the same thing: a labelled, resize-friendly textarea. */
export function TextPanel(props: TextPanelProps): ReactElement {
  const { label, labelClassName, value, placeholder, dir, readOnly = false, inputRef, onChange, actions } = props

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    onChange?.(event.target.value)
  }

  return (
    <section className="panel">
      <div className="panel__header">
        <h2 className={labelClassName === undefined ? 'panel__label' : 'panel__label ' + labelClassName}>
          {label}
        </h2>
        {actions === undefined ? null : actions}
      </div>
      <textarea
        ref={inputRef}
        className="panel__text"
        value={value}
        placeholder={placeholder}
        dir={dir}
        readOnly={readOnly}
        spellCheck={false}
        onChange={handleChange}
      />
    </section>
  )
}
