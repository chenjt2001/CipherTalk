import { parentPort, workerData } from 'worker_threads'
import { aiService } from '../ai/aiService'
import { run } from './engine'
import type { ConversationRequest, ProgressEvent, StreamEvent } from './types'

type WorkerData = {
  request: ConversationRequest
}

type WorkerEvent =
  | { kind: 'progress'; progress: ProgressEvent }
  | { kind: 'stream'; streamEvent: StreamEvent }
  | { kind: 'final'; conversationId: number; answerText?: string }
  | { kind: 'error'; error: string }

const data = workerData as WorkerData

function post(event: WorkerEvent): void {
  parentPort?.postMessage({
    requestId: data.request.requestId,
    createdAt: Date.now(),
    ...event
  })
}

async function main(): Promise<void> {
  try {
    aiService.init()
    const controller = new AbortController()
    const result = await run(
      data.request,
      event => post({ kind: 'stream', streamEvent: event }),
      progress => post({ kind: 'progress', progress }),
      controller.signal
    )
    post({
      kind: 'final',
      conversationId: result.conversationId,
      answerText: result.answerText
    })
  } catch (error) {
    post({ kind: 'error', error: String(error) })
  }
}

void main()
