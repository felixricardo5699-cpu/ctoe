import { useMemo, type ReactElement } from 'react'
import { toUserMessage } from '@shared/errors/messages'
import { sortKnowledgePoints } from '@shared/language/records'
import type { LanguageCode } from '@shared/language/registry'
import { formatSentenceId } from '@shared/language/sentenceId'
import {
  LEARNING_KIND_LABELS,
  type LearningAnalysis,
  type SavedSentence,
  type TranslationErrorCode
} from '@shared/types'
import { SpeakButton } from './SpeakButton'

interface AnalysisPanelProps {
  /** The Learn result for the expression above. The panel stays out of the way until there is one. */
  analysis: LearningAnalysis | null
  /**
   * The language being studied: what every line in here is read aloud in. A sentence that has
   * been saved reads each point in the language frozen on it (see SavedSentenceCard); this is
   * the live answer, which is always in the language the user is learning right now.
   */
  learningLanguage: LanguageCode
  /**
   * The sentence this note filed, which Learn did on its own: asking for the analysis is the study
   * act, so the write happens with the answer and there is no Save button to press. Null while
   * nothing has been filed - the note is shown either way, because it is already paid for.
   */
  learned?: SavedSentence | null
  /** Why nothing was filed. Said out loud under the note rather than swallowed. */
  learnFailure?: TranslationErrorCode | null
  /**
   * Closes the block. Learn is the one part of the panel the user opens on purpose, so it is
   * also the one part that needs a way back to the leaner shape.
   */
  onDismiss?: () => void
}

/**
 * "Learn this": the things worth remembering out of the sentence the user just produced, each
 * one expression / meaning / why / example - with the example's translation and its own speaker.
 *
 * Asking for this note is the whole act: the sentence it describes was filed by the main process
 * in the same round trip, so there is no Save button and nothing for the user to tend. What the
 * footer says is where it went - the moment, with every point found inside it, is already in My
 * Learning under its own number.
 *
 * The component stays pure: it reads what the run reported and never writes anything itself.
 */
export function AnalysisPanel({
  analysis,
  learningLanguage,
  learned = null,
  learnFailure = null,
  onDismiss
}: AnalysisPanelProps): ReactElement | null {
  // The answer decides how many points a sentence deserves, so the list is never cut to a
  // fixed number here - only ordered, the strongest first.
  const points = useMemo(
    () => (analysis === null ? [] : sortKnowledgePoints(analysis.items)),
    [analysis]
  )
  if (analysis === null || points.length === 0) return null

  return (
    <section className="analysis" aria-label="Learn 分析">
      <div className="analysis__header">
        <h2 className="analysis__title">Learn this</h2>
        {onDismiss === undefined ? null : (
          <button
            type="button"
            className="analysis__close"
            aria-label="收起 Learn 分析"
            title="收起（结果会保留）"
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>
      <ul className="analysis__list">
        {points.map((item, index) => (
          <li className="analysis__item" key={String(index) + ':' + item.kind + ':' + item.expression}>
            <p className="analysis__head">
              <span className="analysis__kind">{LEARNING_KIND_LABELS[item.kind]}</span>
              <span className="analysis__expression" dir="auto">{item.expression}</span>
              <SpeakButton
                text={item.expression}
                language={learningLanguage}
                label={item.expression}
              />
            </p>
            <p className="analysis__meaning" dir="auto">{item.meaning}</p>
            {item.why.length === 0 ? null : (
              <p className="analysis__why">为什么有用：{item.why}</p>
            )}
            {item.example.length === 0 ? null : (
              // dir="auto": an example in Arabic has to right-align itself, and a borrowed
              // English word inside it still reads left to right.
              <p className="analysis__example" dir="auto">
                例句：{item.example}
                <SpeakButton text={item.example} language={learningLanguage} label={item.example} />
              </p>
            )}
            {item.exampleTranslation.length === 0 ? null : (
              // The same sentence in the user's own language: an example nobody can read back
              // is not something they can check for themselves.
              <p className="analysis__example-translation" dir="auto">{item.exampleTranslation}</p>
            )}
          </li>
        ))}
      </ul>
      {learned === null && learnFailure === null ? null : (
        // Nothing to report is nothing to draw: a note with no receipt is a note still in flight.
        <div className="analysis__footer">
          {learned === null ? null : (
            // The receipt, not a button: the note was filed as it arrived, so all that is left
            // to say is where it went. The number is the one My Learning lists it under.
            <p className="analysis__saved" role="status">
              Added to My Learning · {formatSentenceId(learned.id)}
            </p>
          )}
          {learnFailure === null ? null : (
            // A write that did not land is said out loud. Pressing Learn again both asks for the
            // note afresh and files it, so the way out is a button the user already has.
            <p className="analysis__saved analysis__saved--failed" role="status">
              {toUserMessage(learnFailure)}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
