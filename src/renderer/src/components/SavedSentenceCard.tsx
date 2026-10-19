import { useState, type ReactElement } from 'react'
import { sentenceMode } from '@shared/language/pair'
import { languageName } from '@shared/language/registry'
import { formatSentenceId } from '@shared/language/sentenceId'
import {
  LEARNING_KIND_LABELS,
  PANEL_MODE_LABELS,
  type KnowledgePoint,
  type SavedSentence,
  type SavedSentenceRef
} from '@shared/types'
import { SpeakButton } from './SpeakButton'


interface SavedSentenceCardProps {
  sentence: SavedSentence
  onRemove: (ref: SavedSentenceRef) => void
}

/**
 * One learned sentence: the moment as it happened, the other side of the pair under it, and the
 * points that were found in it - folded away.
 *
 * The sentence is the subject and the points are inside it - what someone re-reads later is
 * "the time I said this", not a word floating on its own - so the card opens as the sentence and
 * nothing else, and the knowledge is one press away. A card holding three points and a card
 * holding twelve then read the same way, which is what keeps the list scannable. Every point
 * keeps the language it was learned in, so a line is read out in the language being studied even
 * after the user has moved on to another one.
 *
 * One shelf holds both directions of a relation, so the card says which way this moment went:
 * whether the user produced the studied line or read it. It is read off the sentence, never
 * remembered from what the panel was doing at the time.
 */
export function SavedSentenceCard({ sentence, onRemove }: SavedSentenceCardProps): ReactElement {
  // Folded to start with, and only ever about this card: opening one sentence must not open the
  // next one, or the list stops being scannable the moment it holds more than a couple of rows.
  const [pointsOpen, setPointsOpen] = useState(false)
  const mode = sentenceMode(sentence)
  const pointCount = sentence.knowledgePoints.length
  // Whichever side of the pair is the one being studied is the side that can be heard; the
  // other side is what the user already speaks.
  const studiedIsOriginal = mode === 'understand'
  // The direction is history: it names this sentence's own two languages, not today's profile.
  const directionTitle =
    (mode === 'express' ? '自己表达：' : '读懂：') +
    languageName(sentence.sourceLanguage) +
    ' → ' +
    languageName(sentence.targetLanguage)

  return (
    <li className="language__record">
      <div className="language__head">
        <p className="language__id">{formatSentenceId(sentence.id)}</p>
        <span className="language__mode" title={directionTitle}>
          {PANEL_MODE_LABELS[mode]}
        </span>
      </div>
      {sentence.originalText.length === 0 ? null : (
        <p className="language__original" dir="auto">
          {sentence.originalText}
          {studiedIsOriginal ? (
            <SpeakButton
              text={sentence.originalText}
              language={sentence.learningLanguage}
              label={sentence.originalText}
            />
          ) : null}
        </p>
      )}
      {sentence.translatedText.length === 0 ? null : (
        <p className="language__translation" dir="auto">
          {sentence.translatedText}
          {studiedIsOriginal ? null : (
            <SpeakButton
              text={sentence.translatedText}
              language={sentence.learningLanguage}
              label={sentence.translatedText}
            />
          )}
        </p>
      )}
      {/*
        How much is in here, not what it is: the sentence is what the user came back for, and a
        count is enough to decide whether to open it. Said even at zero, so a card never looks
        like it lost its lesson.
      */}
      <p className="language__knowledge-title">
        {'KNOWLEDGE · ' + String(pointCount) + (pointCount === 1 ? ' point' : ' points')}
      </p>
      {pointCount === 0 ? null : (
        <>
          <button
            type="button"
            className="button button--mini language__knowledge-toggle"
            aria-expanded={pointsOpen}
            onClick={() => setPointsOpen((current) => !current)}
          >
            {pointsOpen ? '收起知识点' : '展开知识点'}
            {/* The arrow is decoration only: the button keeps its own name, so what a screen
                reader announces and what the tests look up do not change when the fold flips. */}
            <span aria-hidden="true">{pointsOpen ? ' ▲' : ' ▼'}</span>
          </button>
          {pointsOpen ? (
            <ul className="analysis__list">
              {sentence.knowledgePoints.map((point, index) => (
                <SavedPoint key={point.id + ':' + String(index)} point={point} />
              ))}
            </ul>
          ) : null}
        </>
      )}
      <div className="language__actions">
        <button
          type="button"
          className="button button--mini"
          aria-label={'删除句子 ' + formatSentenceId(sentence.id)}
          onClick={() =>
            onRemove({
              // The relation, not the direction: that is the scope the id was handed out in.
              nativeLanguage: sentence.nativeLanguage,
              learningLanguage: sentence.learningLanguage,
              id: sentence.id
            })
          }
        >
          删除
        </button>
      </div>
    </li>
  )
}

/**
 * One point inside a saved sentence: what it means, why it is worth knowing, and an example
 * with its translation. The speaker reads the stored audioLanguage, not the language the user
 * happens to be studying today.
 */
function SavedPoint({ point }: { point: KnowledgePoint }): ReactElement {
  return (
    <li className="analysis__item">
      <p className="analysis__head">
        <span className="analysis__kind">{LEARNING_KIND_LABELS[point.kind]}</span>
        <span className="analysis__expression" dir="auto">{point.expression}</span>
        <SpeakButton text={point.expression} language={point.audioLanguage} label={point.expression} />
      </p>
      <p className="analysis__meaning" dir="auto">{point.meaning}</p>
      {point.why.length === 0 ? null : <p className="analysis__why">为什么有用：{point.why}</p>}
      {point.example.length === 0 ? null : (
        <p className="analysis__example" dir="auto">
          例句：{point.example}
          <SpeakButton text={point.example} language={point.audioLanguage} label={point.example} />
        </p>
      )}
      {point.exampleTranslation.length === 0 ? null : (
        <p className="analysis__example-translation" dir="auto">{point.exampleTranslation}</p>
      )}
    </li>
  )
}
