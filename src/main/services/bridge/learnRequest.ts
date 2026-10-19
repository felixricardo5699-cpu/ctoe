import type { BridgeErrorCode, BridgeLearnRequest, BridgeProfile } from '@shared/types/bridge'
import { resolveBridgeMode } from '@shared/types/bridge'
import type { TranslateSentence } from '@shared/types/ipc'
import type {
  SavedSentence,
  Tone,
  TranslationErrorCode,
  TranslationFailure
} from '@shared/types'
import { DEFAULT_TONE } from '@shared/types'
import {
  runTranslation,
  type TranslationDeps,
  type TranslationSink
} from '../../ipc/handlers'

/*
 * A sentence from a browser, taken all the way to My Learning.
 *
 * The extension handed over one line of text and nothing else: not the pair, not the direction,
 * not a translation. Everything after that is this app doing what it already does for a sentence
 * typed into the panel - which is the point. The bridge is a new door into the existing pipeline,
 * not a second pipeline:
 *
 *   reading (the default):  the sentence is in the language being learned
 *     understand  learning -> native   what it means, in the user's own language
 *     analyze     native -> learning   the coaching note, filed as a saved sentence
 *
 *   producing:              the sentence is in the user's own language
 *     express     native -> learning   the wording they would have used
 *     analyze     native -> learning   the coaching note, filed as a saved sentence
 *
 * Learn is always asked the same way round (native in, learning out), because that is what makes
 * it coach the language being learned - and the sentence travels separately, so what gets filed is
 * the moment as it happened rather than the direction of the coaching request.
 */

/**
 * What one browser sentence became. The sentence is the receipt; a null sentence means nothing was
 * filed, and the failure says why.
 */
export interface BridgeLearnOutcome {
  sentence: SavedSentence | null
  failure: BridgeErrorCode | null
  /** True when the failure was in the request itself, as opposed to the write that follows it. */
  requestFailed: boolean
}

/**
 * Files one sentence the browser sent.
 *
 * The runs go through the same runner the panel uses, with a sink that collects the failure
 * instead of drawing it: there is no panel waiting on this request, so the only thing to do with
 * an error is report it back to the extension in the vocabulary the protocol defines.
 */
export async function runBridgeLearn(
  deps: TranslationDeps,
  request: BridgeLearnRequest,
  profile: BridgeProfile,
  tone: Tone,
  signal: AbortSignal
): Promise<BridgeLearnOutcome> {
  const collector = createCollector()
  // The text is handed over as well as the hint: a page without a `lang` attribute still says
  // which script its sentence is written in, which is enough to tell the two sides of a pair
  // apart whenever they do not share one (see resolveBridgeMode).
  const mode = resolveBridgeMode(request.mode, request.langHint, profile, request.text)
  // Reading walks the relation back, producing goes forward - the same rule the panel follows,
  // decided here from the profile rather than taken from the extension.
  const from = mode === 'understand' ? profile.learningLanguage : profile.nativeLanguage
  const to = mode === 'understand' ? profile.nativeLanguage : profile.learningLanguage

  try {
    const answer = await ask(deps, collector, signal, {
      task: mode === 'understand' ? 'understand' : 'express',
      text: request.text,
      tone,
      sourceLanguage: from,
      targetLanguage: to
    })
    // A request that failed, or an answer with nothing in it, leaves nothing to coach: the
    // sentence would be filed half-empty, which is worse than saying it did not work.
    if (answer === null) return failed(collector.failure)
    if (answer.trim().length === 0) return failed(null)

    // The moment as it happened: what the user pointed at, and what came back in the other
    // language. Learn is asked separately, so the sentence is never the coaching request.
    const sentence: TranslateSentence = {
      originalText: request.text,
      translatedText: answer,
      sourceLanguage: from,
      targetLanguage: to
    }
    // Which of the two lines was the one being studied differs by direction, and so does which
    // one the user already understood. Reading: they brought the studied line and got its
    // meaning back. Producing: they brought the meaning and got the studied line back.
    const studiedText = mode === 'understand' ? request.text : answer
    const meaningText = mode === 'understand' ? answer : request.text
    // Learn is always asked the same way round - the user's own language in, the language being
    // learned out - whatever direction the sentence itself went. That is what makes the coaching
    // note about the language being learned, and the sentence is passed alongside so the record
    // keeps the direction this moment really had.
    const learned = await ask(deps, collector, signal, {
      task: 'analyze',
      text: meaningText,
      tone,
      sourceLanguage: profile.nativeLanguage,
      targetLanguage: profile.learningLanguage,
      result: studiedText,
      sentence
    })
    if (learned === null) return failed(collector.failure)

    // The write happens inside the analyze run, so the receipt is what proves it landed. A write
    // that could not land still produced a note, which the panel shows - with the reason attached.
    const record = collector.record
    if (record === null) {
      return {
        sentence: null,
        failure: bridgeFailureOf(collector.learnFailure),
        requestFailed: false
      }
    }
    return { sentence: record, failure: null, requestFailed: false }
  } catch {
    // Nothing here reaches the user's screen on its own, so an unexpected throw has to be
    // reported rather than logged and forgotten.
    return { sentence: null, failure: 'internal', requestFailed: true }
  }
}

interface AskOptions {
  task: 'understand' | 'express' | 'analyze'
  /** For Learn, the meaning the user already has; for the other two, the text they brought. */
  text: string
  tone: Tone
  sourceLanguage: BridgeProfile['nativeLanguage']
  targetLanguage: BridgeProfile['nativeLanguage']
  /** The studied sentence Learn is asked about. Empty for the two direction-setting runs. */
  result?: string
  sentence?: TranslateSentence
}

/** One run, read for its answer rather than drawn. Null means the run failed; see the collector. */
function ask(
  deps: TranslationDeps,
  collector: Collector,
  signal: AbortSignal,
  options: AskOptions
): Promise<string | null> {
  const requestId = 'bridge-' + String(collector.sequence++)
  return runTranslation(
    deps,
    collector.sink,
    {
      requestId,
      text: options.text,
      tone: options.tone,
      context: '',
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      task: options.task,
      result: options.result ?? '',
      ...(options.sentence === undefined ? {} : { sentence: options.sentence })
    },
    signal
  ).then((done) => (done === null ? null : done.text))
}

interface Collector {
  sink: TranslationSink
  sequence: number
  failure: TranslationFailure | null
  record: SavedSentence | null
  learnFailure: TranslationErrorCode | null
}

/**
 * A sink that keeps what a run reported instead of drawing it.
 *
 * Both things worth keeping arrive here: the failure of a request, and the receipt of the study
 * pass. Reading them off the sink rather than from the runner's return value is what keeps this
 * file from having to care which of the two requests did what.
 */
function createCollector(): Collector {
  const collector: Collector = {
    sequence: 0,
    failure: null,
    record: null,
    learnFailure: null,
    sink: {
      delta: () => undefined,
      done: (payload) => {
        if (payload.learned !== undefined && payload.learned !== null) {
          collector.record = payload.learned
        }
        if (payload.learnFailure !== undefined && payload.learnFailure !== null) {
          collector.learnFailure = payload.learnFailure
        }
      },
      failed: (payload) => {
        collector.failure = payload.failure
      }
    }
  }
  return collector
}

function failed(failure: TranslationFailure | null): BridgeLearnOutcome {
  return { sentence: null, failure: bridgeFailureOf(failure?.code ?? null), requestFailed: true }
}

/**
 * The reason a run gave, in the protocol's own words. Anything the protocol has no code for is
 * reported as a plain translation failure: an extension shows a sentence either way, and the
 * distinction only matters for the cases the user can actually act on.
 */
function bridgeFailureOf(code: TranslationErrorCode | null): BridgeErrorCode {
  if (code === 'language-pair-id-exhausted') return 'language-pair-id-exhausted'
  if (code === 'storage-failed' || code === 'missing-sentence') return 'storage-failed'
  if (code === 'input-too-long') return 'text-too-long'
  return 'translation-failed'
}

/** The register a browser sentence is coached in. Nothing on a page says which one to use. */
export const BRIDGE_TONE: Tone = DEFAULT_TONE
