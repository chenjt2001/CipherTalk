import { aiService } from '../ai/aiService'
import type { GenerateTitleRequest, ProviderCfg } from './types'

export function createProvider(config: ProviderCfg) {
  return aiService.createProvider(config.provider, config.apiKey)
}

export async function generateTitle(request: GenerateTitleRequest): Promise<string> {
  return aiService.generateAgentTitle({
    provider: request.provider.provider,
    apiKey: request.provider.apiKey,
    model: request.provider.model,
    userMessage: request.userMessage,
    assistantResponse: request.assistantResponse
  })
}
