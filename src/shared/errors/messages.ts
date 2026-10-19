import { LANGUAGE_PAIR_ID_EXHAUSTED_MESSAGE } from '../language/sentenceId'
import type { TranslationErrorCode } from '../types'

/**
 * Plain-language messages for non-technical users. Raw HTTP bodies and status
 * codes stay in logs (`TranslationFailure.detail`), never in the UI.
 */
const MESSAGES: Record<TranslationErrorCode, string> = {
  'missing-input': '请先输入你想表达的意思。',
  'missing-result': '还没有生成结果，请先点 Generate。',
  'input-too-long': '输入内容太长了，请分段生成。',
  'missing-api-key': '还没有配置 API Key，请到设置里填写。',
  unauthorized: 'API Key 无效，请检查设置。',
  'model-not-found': '模型不存在，请在设置里检查模型名称。',
  'rate-limited': '请求过于频繁或额度不足，请稍后再试。',
  timeout: 'AI 服务响应超时，请重试。',
  network: '连接 AI 服务失败，请检查网络后重试。',
  'server-error': 'AI 服务暂时不可用，请稍后再试。',
  'empty-response': 'AI 没有返回内容，请重试。',
  'malformed-response': 'AI 返回的内容无法识别，请重试或更换模型。',
  cancelled: '已取消本次生成。',
  'missing-sentence': '没有找到要记录的句子，请先生成结果再点 Learn。',
  'storage-failed': '学习记录没能写入，请再点一次 Learn 重试。',
  'language-pair-id-exhausted': LANGUAGE_PAIR_ID_EXHAUSTED_MESSAGE,
  unknown: '生成失败，请重试。'
}

export function toUserMessage(code: TranslationErrorCode): string {
  return MESSAGES[code]
}
