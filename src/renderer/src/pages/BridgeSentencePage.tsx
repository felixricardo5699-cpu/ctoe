import { useState, type ReactElement } from 'react'
import type { LanguagePairKey } from '@shared/language/pair'
import { languageName } from '@shared/language/registry'
import type { BridgeLearnEvent } from '@shared/types/bridge'
import { PanelChrome } from '../components/PanelChrome'
import { SavedSentenceCard } from '../components/SavedSentenceCard'
import { useLanguageRecords } from '../hooks/useLanguageRecords'

interface BridgeSentencePageProps {
  floatingBall: boolean
  shortcut?: string
  /** The sentence a browser asked for, as the main process filed it. */
  event: BridgeLearnEvent
  /** Opens My Learning on the shelf this sentence landed in. */
  onOpenLanguage: (pair: LanguagePairKey) => void
  onBack: () => void
}

/**
 * What a sentence from a browser became.
 *
 * This page exists because the app learned something the user did not ask for from here: the
 * click happened on a web page, and by the time the panel is on screen the sentence is already in
 * My Learning. So it is a receipt rather than an editor - the sentence as it was saved, its own
 * number, and a way through to the shelf it went on. The card is the same one My Learning draws,
 * because it is the same kind of thing, and it is shown expanded here: a receipt that hid its
 * contents behind a fold would be a strange thing to hand someone.
 *
 * Deleting is offered because a mistake is a mistake - and if the user takes it, the page says so
 * instead of drawing a record that is gone.
 */
export function BridgeSentencePage({
  floatingBall,
  shortcut,
  event,
  onOpenLanguage,
  onBack
}: BridgeSentencePageProps): ReactElement {
  const { sentences, remove, errorMessage } = useLanguageRecords()
  const [removed, setRemoved] = useState(false)
  // A record that is gone is gone - whether it was deleted here or somewhere else before this
  // page was drawn - so the card is only shown while the store still has the sentence.
  const kept = sentences.some(
    (sentence) =>
      sentence.id === event.sentence.id &&
      sentence.nativeLanguage === event.sentence.nativeLanguage &&
      sentence.learningLanguage === event.sentence.learningLanguage
  )
  const pair = {
    nativeLanguage: event.sentence.nativeLanguage,
    learningLanguage: event.sentence.learningLanguage
  }
  const where = event.source.title.length > 0 ? event.source.title : event.source.url

  return (
    <div className="settings">
      <header className="settings__header">
        <h1 className="settings__title">来自浏览器</h1>
        <div className="settings__header-actions">
          <button type="button" className="button button--ghost" onClick={onBack}>
            返回
          </button>
          <PanelChrome floatingBall={floatingBall} shortcut={shortcut} />
        </div>
      </header>

      {/* A long sentence scrolls under a header that does not, like every other page here. */}
      <div className="settings__body">
        <p className="note">
          你在浏览器里点了 Learn，这一句已经收进 My Learning：
          {languageName(pair.nativeLanguage) + ' → ' + languageName(pair.learningLanguage)}。
        </p>
        {where.length > 0 ? <p className="field__hint">来自：{where}</p> : null}

        {removed || !kept ? (
          <p className="note">这句已经从 My Learning 删除了。</p>
        ) : (
          <ul className="language__list">
            <SavedSentenceCard
              sentence={event.sentence}
              onRemove={(ref) => {
                void remove(ref).then((ok) => {
                  if (ok) setRemoved(true)
                })
              }}
            />
          </ul>
        )}

        <div className="language__actions">
          <button
            type="button"
            className="button button--mini"
            onClick={() => onOpenLanguage(pair)}
          >
            在 My Learning 中查看
          </button>
        </div>

        {errorMessage !== null ? <p className="status status--error">{errorMessage}</p> : null}

        <p className="note">
          浏览器只送来了一句话，别的一概不留：网页地址和标题只用来告诉你它来自哪里，不会写进
          本机文件。存下来的只有这句原句、它的释义和知识点，和你在面板里学到的东西放在一起
          （learned.json，和 config.json 同目录）。不上传、不联网、没有账号。
        </p>
      </div>
    </div>
  )
}
