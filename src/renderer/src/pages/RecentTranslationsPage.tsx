import type { ReactElement } from 'react'
import type { LanguagePairKey } from '@shared/language/pair'
import { learnedFromRow, recentMoment, type RecentFallback } from '@shared/language/recentLearn'
import { languageName, type LanguageCode } from '@shared/language/registry'
import { formatSentenceId } from '@shared/language/sentenceId'
import { AnalysisPanel } from '../components/AnalysisPanel'
import { PanelChrome } from '../components/PanelChrome'
import { SpeakButton } from '../components/SpeakButton'
import { useLanguageRecords } from '../hooks/useLanguageRecords'
import { useLearnFromRecent } from '../hooks/useLearnFromRecent'
import { useRecentTranslations } from '../hooks/useRecentTranslations'

/** The two languages of one row, named the way that row went. */
function pairLabel(sourceLanguage: LanguageCode, targetLanguage: LanguageCode): string {
  return languageName(sourceLanguage) + ' → ' + languageName(targetLanguage)
}

/**
 * When it happened, in the user's own clock. An unreadable time shows as nothing rather than as
 * the epoch: this list is read to recognise a moment, not to audit it.
 */
function formatMoment(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString()
}

interface RecentTranslationsPageProps {
  floatingBall: boolean
  shortcut?: string
  /** True once the user turned recording on; the page explains itself when it is false. */
  enabled: boolean
  /**
   * What the user speaks and is learning today. Only used to read rows so old that they do not
   * say which side of themselves was being studied (see recentMoment); a row that does say is
   * read from the row alone, so it can still be learned after the user has moved on.
   */
  profile: RecentFallback
  /** Opens My Learning on the shelf a row was filed under. */
  onOpenLanguage: (pair: LanguagePairKey) => void
  onBack: () => void
}

/**
 * Recent translations: the short-lived list of what the user has just translated, newest first.
 *
 * It is deliberately flat - a row is a moment, with the pair it went between and nothing else -
 * because this is not the learning shelf: nothing here was studied, and nothing here is grouped
 * by language relation. The list is only ever as long as the user allowed, and it can be emptied
 * in one press. Both lines can be read out loud, in their own language, because unlike a lesson
 * there is no side here that the user is assumed to already know.
 *
 * A row can also be learned from here, which is the point of the list outliving the moment: the
 * user translated a line and moved on before asking what was in it. Learn coaches that row on
 * its own terms - the sentence sent is the one on the row, and the relation read off it is the
 * one the user was studying at the time, not whatever they are studying now.
 */
export function RecentTranslationsPage({
  floatingBall,
  shortcut,
  enabled,
  profile,
  onOpenLanguage,
  onBack
}: RecentTranslationsPageProps): ReactElement {
  const { rows, loading, errorMessage, clear } = useRecentTranslations()
  const { sentences } = useLanguageRecords()
  const { run, filed, errorMessage: learnError, analyze, dismiss } = useLearnFromRecent()

  let content: ReactElement
  if (loading) {
    content = <p className="note">正在读取…</p>
  } else if (!enabled) {
    content = (
      <p className="note">
        最近翻译没有开启。打开方式：设置 → 保留最近翻译。开启之后，你翻译过的每一句都会留在本机，
        方便回头找；不开启就什么都不记。
      </p>
    )
  } else if (rows.length === 0) {
    content = <p className="note">还没有最近翻译。生成或读懂一句之后，它就会出现在这里。</p>
  } else {
    content = (
      <>
        <ul className="language__list">
          {rows.map((row) => {
            // What this row teaches, read off the row itself. Null means it cannot be learned
            // at all: a row that predates the field saying which side it studied, and whose
            // direction the current profile does not explain either.
            const moment = recentMoment(row, profile)
            // Already in My Learning, either because it was studied before or because it was
            // studied here a moment ago.
            const kept =
              (moment === null ? null : learnedFromRow(sentences, row, moment)) ??
              filed[row.id] ??
              null
            const coaching = moment !== null && run !== null && run.rowId === row.id ? run : null
            return (
              <li className="language__record" key={row.id}>
                <div className="recent__head">
                  <span className="recent__pair">
                    {pairLabel(row.sourceLanguage, row.targetLanguage)}
                  </span>
                  <span className="recent__when" title={row.createdAt}>
                    {formatMoment(row.createdAt)}
                  </span>
                </div>
                <p className="language__original" dir="auto">
                  {row.sourceText}
                  <SpeakButton
                    text={row.sourceText}
                    language={row.sourceLanguage}
                    label={row.sourceText}
                  />
                </p>
                <p className="language__translation" dir="auto">
                  {row.targetText}
                  <SpeakButton
                    text={row.targetText}
                    language={row.targetLanguage}
                    label={row.targetText}
                  />
                </p>
                <div className="recent__actions">
                  {moment === null ? (
                    // Said out loud rather than hidden: a row that cannot be learned is worth
                    // explaining, and guessing which language it teaches would be worse.
                    <span className="recent__note">
                      这一条没有记下当时在学哪种语言，无法加入 My Learning。
                    </span>
                  ) : kept === null ? (
                    <button
                      type="button"
                      className="button button--mini"
                      // One Learn at a time: while a row is being answered, the others wait
                      // rather than racing it.
                      disabled={run !== null && run.busy}
                      onClick={() => analyze(row, moment)}
                    >
                      Learn
                    </button>
                  ) : (
                    <>
                      <span className="recent__learned">已学习 · {formatSentenceId(kept.id)}</span>
                      <button
                        type="button"
                        className="button button--mini"
                        onClick={() =>
                          onOpenLanguage({
                            nativeLanguage: moment.nativeLanguage,
                            learningLanguage: moment.learningLanguage
                          })
                        }
                      >
                        查看
                      </button>
                    </>
                  )}
                </div>
                {coaching === null || moment === null ? null : (
                  <>
                    {coaching.busy && coaching.analysis === null ? (
                      <p className="note">正在分析这句…</p>
                    ) : null}
                    <AnalysisPanel
                      analysis={coaching.analysis}
                      learningLanguage={moment.learningLanguage}
                      learned={coaching.learned}
                      learnFailure={coaching.learnFailure}
                      onDismiss={dismiss}
                    />
                  </>
                )}
              </li>
            )
          })}
        </ul>
        <div className="language__actions">
          <button type="button" className="button button--mini" onClick={() => void clear()}>
            清空全部
          </button>
        </div>
      </>
    )
  }

  return (
    <div className="settings">
      <header className="settings__header">
        <h1 className="settings__title">最近翻译</h1>
        <div className="settings__header-actions">
          <button type="button" className="button button--ghost" onClick={onBack}>
            返回
          </button>
          <PanelChrome floatingBall={floatingBall} shortcut={shortcut} />
        </div>
      </header>

      {/* A long list scrolls under a header that does not: the way back must stay reachable. */}
      <div className="settings__body">
        {content}

        {errorMessage !== null ? <p className="status status--error">{errorMessage}</p> : null}
        {learnError !== null ? <p className="status status--error">{learnError}</p> : null}

        <p className="note">
          这里只存在本机 recent.json 里（和 config.json 同目录）：你输入的那句、它翻译出来的那句，
          以及这一对语言和时间。它和学习记录是两件事——点 Learn 学到的东西记在 learned.json，
          不会因为翻译被记下来，也不会因为清空这个列表而消失。列表最多留 50 条，更早的会被挤掉。
          这里每一句都可以点 Learn：分析的是这一句，用的是它当时的语言方向，学到的句子会归到
          当时那对语言下面。不上传、不联网、没有账号。
        </p>
      </div>
    </div>
  )
}
