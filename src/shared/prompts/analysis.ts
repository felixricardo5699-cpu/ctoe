import type { TranslationRequest } from '../types'
import type { LanguageContext } from './languageContext'

/**
 * The Learn task: pick the parts of this one expression that are worth 10-20 seconds of the
 * user's attention. How many there are is the sentence's call - a simple line may hold a single
 * worth-keeping chunk, a rich one several - so the note stays a note and never becomes a lesson.
 * The answer has to be machine-readable, so the shape is pinned here instead of leaving the UI
 * to parse prose.
 *
 * Explanations are written in whatever language the user actually speaks, and every example is
 * written in the language they are learning - both come from the context, never from a constant,
 * so the same prompt coaches French -> English and English -> Chinese alike.
 *
 * Every example travels with its own translation, because "how is it used" is not answered by a
 * sentence the learner cannot read back: the pair is what the note shows and what My Learning
 * stores.
 */
function rules(context: LanguageContext): string {
  return [
    'You are a language coach for a ' + context.nativeName + ' speaker who writes ' +
      context.learningName + ' online.',
    'You get what the user meant, the natural ' + context.learningName + ', and the tone.',
    'Pick the parts of that ' + context.learningName + ' sentence most worth learning right now.',
    'Let the sentence decide how many: never pad, never drop a useful point.',
    'Rank by usefulness: useful expression > sentence pattern > vocabulary > grammar.',
    'Add a grammar point only when the structure itself is the lesson.',
    'Never teach a basic word the learner already knows: prefer the chunk.',
    'Reply with ONE JSON object, no prose, no code fence:',
    '{"items":[{"kind":"expression","expression":"...","meaning":"...","why":"...","example":"...","exampleTranslation":"...","importance":"high"}]}',
    'kind: "expression" (chunk to reuse), "pattern" (frame), "vocabulary" (word), "grammar" (structure). importance: "high", "medium" or "low".',
    'expression: the exact words from the ' + context.learningName + ' sentence.',
    'meaning: the ' + context.nativeName + ' meaning - one short phrase.',
    'why: in ' + context.nativeName + ', a short clause on why it is worth remembering.',
    'example: one short, natural ' + context.learningName + ' sentence using it.',
    'exampleTranslation: the same sentence in ' + context.nativeName + '.',
    'Do not explain the whole sentence and do not invent facts.'
  ].join('\n')
}

export function buildAnalysisPrompt(context: LanguageContext): string {
  return rules(context)
}

export function buildAnalysisUserPrompt(
  request: TranslationRequest,
  context: LanguageContext
): string {
  return [
    'What I meant (' + context.nativeName + '):',
    request.text,
    '',
    'Natural ' + context.learningName + ':',
    (request.result ?? '').trim(),
    '',
    'Tone: ' + request.tone
  ].join('\n')
}
