import type { TranslationRequest } from '../types'
import type { LanguageContext } from './languageContext'

/**
 * The Understand task: the user met this text somewhere else (a post, a comment, a chat
 * message, an email) and wants to know what it means and what is worth taking away from it.
 *
 * One answer carries both halves - the meaning of the whole thing and the coaching points -
 * because they come from the same reading of the same sentence: two requests would cost the
 * user a second round trip and a second wait for nothing.
 *
 * The shape is pinned here for the same reason as the Learn prompt: the UI renders structure,
 * never prose, and the stream is parsed while it is still arriving. Both languages are
 * parameters, so 'read French, explain in Russian' is the same code path as English/Chinese.
 * Points carry the same pair as in Learn - example in the language being read, its
 * translation in the reader's own - so one panel can render both directions.
 *
 * As in Learn, the text itself decides how many points it deserves: the prompt asks for the
 * genuinely useful ones and forbids padding the list to a number.
 */
function rules(context: LanguageContext): string {
  return [
    'You are a language coach for a ' + context.nativeName + ' speaker who reads ' +
      context.learningName + ' online.',
    'You get one piece of ' + context.learningName +
      ' the user selected elsewhere and pasted in.',
    'Tell them what it means and what is worth learning from it.',
    'Reply with ONE JSON object, no prose, no code fence:',
    '{"meaning":"...","items":[{"kind":"expression","expression":"...","meaning":"...","why":"...","example":"...","exampleTranslation":"...","importance":"high"}]}',
    'meaning: the whole thing in natural ' + context.nativeName + ', the way a ' +
      context.nativeName + ' speaker says it.',
    'Never translate word for word; keep the tone of the original: a joke stays a joke,',
    'a complaint stays one, a question a question.',
    'items: the parts of that ' + context.learningName + ' most worth learning now.',
    'Let the text decide how many: never pad, never drop a useful point.',
    'Rank by usefulness: useful expression > sentence pattern > vocabulary > grammar.',
    'Add a grammar point only when the structure itself is the lesson.',
    'kind: "expression" (chunk to reuse), "pattern" (frame), "vocabulary" (word), "grammar" (structure). importance: "high", "medium" or "low".',
    'expression: the exact words from the ' + context.learningName + ' text.',
    'meaning: the ' + context.nativeName + ' meaning - one short phrase.',
    'why: in ' + context.nativeName + ', a short clause on why it is worth remembering.',
    'example: one short, natural ' + context.learningName + ' sentence using it.',
    'exampleTranslation: the same sentence in ' + context.nativeName + '.',
    'Do not explain every word and do not invent facts.',
    'If the text is one word, teach from it anyway.',
    'Keep URLs, @mentions, #hashtags and emoji exactly as they are.'
  ].join('\n')
}

export function buildUnderstandingPrompt(context: LanguageContext): string {
  return rules(context)
}

export function buildUnderstandingUserPrompt(
  request: TranslationRequest,
  context: LanguageContext
): string {
  const parts = [context.learningName + ' I read:', request.text]
  // Same context hook as the expression prompt, so future presets fit both directions.
  const extra = request.context.trim()
  if (extra.length > 0) {
    parts.push('', 'Context: ' + extra)
  }
  return parts.join('\n')
}
