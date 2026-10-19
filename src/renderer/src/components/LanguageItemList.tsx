import type { ReactElement } from 'react'
import { formatSentenceId } from '@shared/language/sentenceId'
import type { SentencePoint } from '@shared/language/records'
import type { LearningKind } from '@shared/types'
import { SpeakButton } from './SpeakButton'

/** What each tab says when the user has never saved anything of that kind. */
const EMPTY_HINTS: Record<LearningKind, string> = {
  expression: '还没有保存的表达。',
  vocabulary: '还没有保存的词汇。',
  pattern: '还没有保存的句式。',
  grammar: '还没有保存的语法点。'
}

interface LanguageItemListProps {
  kind: LearningKind
  points: SentencePoint[]
}

/**
 * Every saved point of one kind, newest sentence first. These tabs are views of the sentences
 * under this pair, not a separate collection: nothing can be saved here, and each line says
 * which sentence it came from, so a point is never shown floating without its moment.
 *
 * Each line that is in the language being learned can be read aloud, which is the part of a
 * saved expression a page cannot show: how it sounds.
 */
export function LanguageItemList({ kind, points }: LanguageItemListProps): ReactElement {
  if (points.length === 0) return <p className="note">{EMPTY_HINTS[kind]}</p>
  return (
    <ul className="analysis__list">
      {points.map(({ point, sentence }) => (
        <li className="analysis__item" key={formatSentenceId(sentence.id) + ':' + point.id}>
          <p className="language__expression" dir="auto">
            {point.expression}
            <SpeakButton
              text={point.expression}
              language={point.audioLanguage}
              label={point.expression}
            />
          </p>
          <p className="language__meaning" dir="auto">= {point.meaning}</p>
          {point.example.length === 0 ? null : (
            <p className="analysis__example" dir="auto">
              例句：{point.example}
              <SpeakButton
                text={point.example}
                language={point.audioLanguage}
                label={point.example}
              />
            </p>
          )}
          {point.exampleTranslation.length === 0 ? null : (
            <p className="analysis__example-translation" dir="auto">{point.exampleTranslation}</p>
          )}
          <p className="language__from">{formatSentenceId(sentence.id)}</p>
        </li>
      ))}
    </ul>
  )
}
