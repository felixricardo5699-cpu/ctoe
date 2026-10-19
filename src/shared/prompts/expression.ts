import type { Tone, TranslationRequest } from '../types'
import type { LanguageContext } from './languageContext'

/**
 * The wording a user is looking for, not a word-for-word translation. All prompt text lives
 * in this module: the prompt *is* the product, so it has to stay reviewable in one place.
 * Keep it short - every extra sentence costs tokens and time-to-first-token.
 *
 * Both languages arrive as parameters. Nothing here may assume Chinese in and English out:
 * the same text has to serve French -> Arabic and Russian -> Spanish just as well.
 */
const STYLE_BY_TONE: Record<Tone, string> = {
  natural: 'natural, neutral',
  casual: 'casual, conversational',
  professional: 'clear, polite, professional'
}

const USE_BY_TONE: Record<Tone, string> = {
  natural: 'everyday online communication',
  casual: 'chatting or social media',
  professional: 'work, email and anything that has to stay polite'
}

function rules(context: LanguageContext, tone: Tone): string {
  return [
    'The user knows what they want to say and needs the natural ' + context.learningName + ' for it.',
    'What they wrote is in ' + context.nativeName + '.',
    'Preserve the meaning, facts, intent, emotion, tone, certainty, intensity and opinion exactly as they are.',
    'Do not translate literally, and never hand back word-for-word ' +
      context.nativeName + '-' + context.learningName + '.',
    'Do not add information, do not drop meaningful information, do not invent facts.',
    "Do not change the user's opinion, do not exaggerate and do not soften it.",
    'The result should sound like something a native ' + context.learningName +
      ' speaker would naturally write in an online conversation.',
    'Use ' + STYLE_BY_TONE[tone] + ' ' + context.learningName + ' suitable for ' + USE_BY_TONE[tone] + '.',
    '- Output only the ' + context.learningName + ' text: no quotes, no labels, no explanations.',
    '- Never add facts, opinions or details that are not in the input.',
    '- Keep URLs, @mentions, #hashtags, code and emoji exactly as they are.',
    '- Keep the original line breaks and paragraph structure.',
    '- If the input is already in ' + context.learningName +
      ' or mixes languages, keep its structure and only fix what sounds unnatural.'
  ].join('\n')
}

export function buildExpressionPrompt(tone: Tone, context: LanguageContext): string {
  return rules(context, tone)
}

export function buildExpressionUserPrompt(
  request: TranslationRequest,
  context: LanguageContext
): string {
  const parts = ['What I want to say (' + context.nativeName + '):', request.text]
  // v1 never fills context; the branch exists so future presets do not reshape the prompt API.
  const extra = request.context.trim()
  if (extra.length > 0) {
    parts.push('', 'Context: ' + extra)
  }
  return parts.join('\n')
}
