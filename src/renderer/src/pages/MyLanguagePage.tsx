import { useMemo, useState, type ReactElement } from 'react'
import { pairKey, type LanguagePairKey } from '@shared/language/pair'
import {
  groupByLanguagePair,
  pointsOfKind,
  searchSentences,
  sentencesOfPair,
  type LanguagePairGroup
} from '@shared/language/records'
import { languageName, type LanguageCode } from '@shared/language/registry'
import type { LearningKind, SavedSentence } from '@shared/types'
import { LanguageItemList } from '../components/LanguageItemList'
import { PanelChrome } from '../components/PanelChrome'
import { SavedSentenceCard } from '../components/SavedSentenceCard'
import { useLanguageRecords } from '../hooks/useLanguageRecords'
import { assistantApi } from '../services/assistantApi'

/**
 * The three views inside one shelf: the moments, and two views of the points found in them.
 *
 * The direction of travel is for this to become one view. Expressions and Vocabulary are not a
 * second database - they re-slice the same points by kind - and the product rule is that a point
 * belongs to its sentence, never to a list of its own. Removing them means dropping TABS down to
 * the sentence list and deleting KIND_BY_TAB; it is left alone for now because it is the one
 * change a user would notice, and it loses nothing: no data lives here that My Learning does not
 * already hold.
 */
type Tab = 'sentences' | 'expressions' | 'vocabulary'

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'sentences', label: 'Sentences' },
  { id: 'expressions', label: 'Expressions' },
  { id: 'vocabulary', label: 'Vocabulary' }
]

/** The kind of point each tab lists; 'sentences' lists whole moments instead of one kind. */
const KIND_BY_TAB: Partial<Record<Tab, LearningKind>> = {
  expressions: 'expression',
  vocabulary: 'vocabulary'
}

/**
 * English names here, because this is the view that is *about* the two languages. The arrow names
 * the relation - what the user speaks, and what they are learning - rather than the way any one
 * sentence went: a shelf holds both directions, so it cannot be labelled with one of them.
 */
function pairLabel(nativeLanguage: LanguageCode, learningLanguage: LanguageCode): string {
  return languageName(nativeLanguage) + ' → ' + languageName(learningLanguage)
}

/** Identity of a shelf, for the open-shelf state and for React keys. Never written to disk. */
function shelfKey(shelf: LanguagePairKey): string {
  return pairKey(shelf)
}

interface MyLanguagePageProps {
  floatingBall: boolean
  shortcut?: string
  /**
   * The shelf to open on, when the user arrived here from a sentence somewhere else (a recent
   * translation, say). Only the starting shelf: opening and closing shelves is the page's own.
   */
  focusPair?: LanguagePairKey | null
  onBack: () => void
}

/**
 * My Learning: the sentences the user studied while actually living in the language.
 *
 * It opens on the learning relations - "I speak this and am learning that" - because that is the
 * one thing that is always true of a learned sentence, and it stays true even after the user
 * moves on to study another language. Inside a shelf the subjects are the sentences; the
 * direction each one went (Say it, or Understand) is a property of the sentence, not a second
 * shelf, so both directions sit together and share one id sequence. Expressions and Vocabulary
 * are only the points of those sentences, grouped - they store nothing of their own.
 *
 * A sentence card opens as the sentence alone, with its points folded away: this list is for
 * finding a moment again, and a shelf of lessons read out in full is not scannable.
 *
 * This is not a history: nothing gets here on its own, and everything here can be deleted for
 * good. The search box looks through every shelf at once and always answers with whole sentences.
 */
export function MyLanguagePage({
  floatingBall,
  shortcut,
  focusPair = null,
  onBack
}: MyLanguagePageProps): ReactElement {
  const { sentences, loading, errorMessage, remove, clear } = useLanguageRecords()
  const [query, setQuery] = useState('')
  // Seeded once, on mount, from the shelf the user arrived for: this page is remounted on every
  // visit, so the starting shelf is the caller's to name and the state afterwards is the page's.
  const [openPair, setOpenPair] = useState<string | null>(() =>
    focusPair === null ? null : shelfKey(focusPair)
  )
  const [tab, setTab] = useState<Tab>('sentences')

  const groups = useMemo(() => groupByLanguagePair(sentences), [sentences])
  // The open shelf is looked up rather than kept, so deleting its last sentence closes it.
  const active = groups.find((group) => shelfKey(group) === openPair) ?? null
  // Exporting is a one-shot action with a sentence-long result: "2 files, here". Keeping the
  // answer on screen is the point - the files land outside the app, where it cannot show them.
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState<string | null>(null)

  const exportLearning = async (): Promise<void> => {
    setExporting(true)
    setExportNote(null)
    try {
      const result = await assistantApi().exportLearning()
      setExportNote(
        result.message.length > 0
          ? result.message
          : '已导出 ' + result.files.length + ' 个文件到 ' + (result.folder ?? '')
      )
    } catch {
      setExportNote('导出失败，请重试。')
    } finally {
      setExporting(false)
    }
  }

  const openDataFolder = async (): Promise<void> => {
    try {
      const result = await assistantApi().openDataFolder()
      if (!result.ok) setExportNote(result.message.length > 0 ? result.message : '打不开数据文件夹。')
    } catch {
      setExportNote('打不开数据文件夹。')
    }
  }
  const pairSentences = useMemo(
    () =>
      active === null
        ? []
        : sentencesOfPair(sentences, active.nativeLanguage, active.learningLanguage),
    [active, sentences]
  )
  const kind = KIND_BY_TAB[tab]
  const points = useMemo(
    () => (kind === undefined ? [] : pointsOfKind(pairSentences, kind)),
    [kind, pairSentences]
  )
  const searching = query.trim().length > 0
  const results = useMemo(
    () => (searching ? groupByLanguagePair(searchSentences(sentences, query)) : []),
    [query, searching, sentences]
  )

  const openShelf = (group: LanguagePairGroup): void => {
    setOpenPair(shelfKey(group))
    setTab('sentences')
  }

  /**
   * What a shelf is for besides reading it: take it out of the app as a printable document, or
   * find the folder the data lives in. Both answers leave the window, so both are offered from
   * every view of this page rather than from a menu the user has to find.
   */
  const actions = (
    <div className="language__actions">
      <button
        type="button"
        className="button button--mini"
        onClick={() => void exportLearning()}
        disabled={exporting}
      >
        {exporting ? '正在导出…' : '导出为 Word'}
      </button>
      <button type="button" className="button button--mini" onClick={() => void openDataFolder()}>
        打开数据文件夹
      </button>
      <button type="button" className="button button--mini" onClick={() => void clear()}>
        清空全部
      </button>
    </div>
  )

  let content: ReactElement
  if (loading) {
    content = <p className="note">正在读取…</p>
  } else if (active !== null) {
    content = (
      <>
        <div className="language__pair-header">
          <button type="button" className="button button--ghost" onClick={() => setOpenPair(null)}>
            ← My Learning
          </button>
          <p className="language__pair-title">
            {pairLabel(active.nativeLanguage, active.learningLanguage)}
          </p>
        </div>
        <div className="language__tabs">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={tab === entry.id}
              className={tab === entry.id ? 'language__tab language__tab--active' : 'language__tab'}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {kind === undefined ? (
          <ul className="language__list">
            {pairSentences.map((sentence) => (
              <SavedSentenceCard
                key={sentenceKey(sentence)}
                sentence={sentence}
                onRemove={(ref) => void remove(ref)}
              />
            ))}
          </ul>
        ) : (
          <LanguageItemList kind={kind} points={points} />
        )}
        {actions}
      </>
    )
  } else if (searching) {
    content =
      results.length === 0 ? (
        <p className="note">没有找到包含「{query.trim()}」的句子。</p>
      ) : (
        <div className="language__results">
          {results.map((group) => (
            <section className="language__result-group" key={shelfKey(group)}>
              <h2 className="language__group-title">
                {pairLabel(group.nativeLanguage, group.learningLanguage)}
                <span className="language__pair-count">{group.count} saved</span>
              </h2>
              <ul className="language__list">
                {group.sentences.map((sentence) => (
                  <SavedSentenceCard
                    key={sentenceKey(sentence)}
                    sentence={sentence}
                    onRemove={(ref) => void remove(ref)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )
  } else if (sentences.length === 0) {
    content = (
      <p className="note">
        还没有学习记录。生成或读懂一句之后点 Learn，这句话就会被记在这里。
      </p>
    )
  } else {
    content = (
      <>
        <ul className="language__pairs">
          {groups.map((group) => (
            <li key={shelfKey(group)}>
              <button
                type="button"
                className="language__pair-button"
                onClick={() => openShelf(group)}
              >
                <span className="language__pair-name">
                  {pairLabel(group.nativeLanguage, group.learningLanguage)}
                </span>
                <span className="language__pair-count">{group.count} saved</span>
              </button>
            </li>
          ))}
        </ul>
        {actions}
      </>
    )
  }

  return (
    <div className="settings">
      <header className="settings__header">
        <h1 className="settings__title">My Learning</h1>
        <div className="settings__header-actions">
          <button type="button" className="button button--ghost" onClick={onBack}>
            返回
          </button>
          <PanelChrome floatingBall={floatingBall} shortcut={shortcut} />
        </div>
      </header>

      {/* The shelf list is long and the search box is part of it: only the header stays put. */}
      <div className="settings__body">
        {active !== null ? null : (
          <div className="language__search">
            <input
              type="search"
              className="language__search-input"
              value={query}
              aria-label="搜索 My Learning"
              placeholder="搜索句子、翻译或知识点…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}

        {content}

        {exportNote !== null ? <p className="note">{exportNote}</p> : null}

        {errorMessage !== null ? <p className="status status--error">{errorMessage}</p> : null}

        <p className="note">
          这里的数据只存在本机 learned.json 里（和 config.json 同目录，点上面的「打开数据文件夹」就能看到）。
          一次 Learn 记录下的是一整句话：原文、翻译，以及从这句话里找出来的所有知识点。只有你点 Learn 时才会写入；
          删除会真的从文件里移除。每一句话的编号在它自己的语言关系里递增（说外语和读懂外语共用一套编号），
          不会重复使用。不上传、不联网、没有账号。
        </p>
        <p className="note">
          「导出为 Word」会按语言对生成 .docx（例如 Chinese_English.docx）：先逐句列出原文、译文和全部学习点，
          再按表达 / 句式 / 词汇 / 语法整理成索引，直接打印就能用。
        </p>
      </div>
    </div>
  )
}

/** A React key unique across shelves, since an id only names a sentence inside its own. */
function sentenceKey(sentence: SavedSentence): string {
  return shelfKey(sentence) + ':' + String(sentence.id)
}
