import type { TranslationRequest } from '../types'
import { buildAnalysisPrompt, buildAnalysisUserPrompt } from './analysis'
import { buildExpressionPrompt, buildExpressionUserPrompt } from './expression'
import { languageContext } from './languageContext'
import { buildUnderstandingPrompt, buildUnderstandingUserPrompt } from './understanding'

export interface PromptMessages {
  system: string
  user: string
}

/**
 * The single prompt entry point: one request in, one system+user pair out. The file keeps
 * its earlier name on purpose - renaming it is vocabulary cleanup, not a second concept,
 * and every task (express, Learn and Understand) belongs to the same dispatcher.
 *
 * The language pair is resolved exactly once, here, and handed to the builder that needs it:
 * the build* functions themselves stay pure text assembly.
 */
export function buildPrompt(request: TranslationRequest): PromptMessages {
  const context = languageContext(request)
  if (request.task === 'analyze') {
    return { system: buildAnalysisPrompt(context), user: buildAnalysisUserPrompt(request, context) }
  }
  if (request.task === 'understand') {
    return { system: buildUnderstandingPrompt(context), user: buildUnderstandingUserPrompt(request, context) }
  }
  return {
    system: buildExpressionPrompt(request.tone, context),
    user: buildExpressionUserPrompt(request, context)
  }
}

export {
  buildAnalysisPrompt,
  buildAnalysisUserPrompt,
  buildExpressionPrompt,
  buildExpressionUserPrompt,
  buildUnderstandingPrompt,
  buildUnderstandingUserPrompt,
  languageContext
}
