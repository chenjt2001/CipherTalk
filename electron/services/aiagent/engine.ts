import type {
  ConversationRequest,
  ProgressEvent,
  ProgressEmit,
  RunConversationResult,
  StreamEvent,
  StreamEmit
} from './types'
import { aiService } from '../ai/aiService'
import { resolveScope } from './scope'
import { runGlobalConversation } from './global/globalAgent'

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Aborted')
  }
}

function emitStream(emit: StreamEmit, event: unknown): void {
  emit(event as StreamEvent)
}

function emitProgress(onProgress: ProgressEmit, event: unknown): void {
  onProgress(event as ProgressEvent)
}

export async function run(
  request: ConversationRequest,
  emit: StreamEmit,
  onProgress: ProgressEmit,
  signal: AbortSignal
): Promise<RunConversationResult> {
  const scope = resolveScope(request.scope)
  assertNotAborted(signal)

  if (scope.kind === 'session') {
    const result = await aiService.answerSessionQuestion(
      {
        conversationId: request.conversationId,
        sessionId: scope.sessionId,
        sessionName: scope.sessionName,
        question: request.message,
        history: request.history,
        provider: request.provider.provider,
        apiKey: request.provider.apiKey,
        model: request.provider.model,
        enableThinking: request.forceThinking ?? request.provider.enableThinking,
      },
      event => emitStream(emit, event),
      event => emitProgress(onProgress, event)
    )

    return {
      conversationId: request.conversationId ?? 0,
      answerText: result.answerText
    }
  }

  const answerText = await runGlobalConversation(request, emit, signal)
  return {
    conversationId: request.conversationId ?? 0,
    answerText
  }
}
