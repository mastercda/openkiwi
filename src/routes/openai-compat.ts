import express from 'express';
import { AgentManager } from '../agent-manager.js';
import { runAgentLoop } from '../agent-loop.js';

const router = express.Router();

// Endpoint to list all agents as models (keep /models as is)
router.get('/models', (req, res) => {
    try {
        const agentIds = AgentManager.listAgents();

        // Transform agents into OpenAI-compatible model objects
        const agents = agentIds.map(id => {
            const agent = AgentManager.getAgent(id);
            return {
                id: agent?.id || id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openkiwi-agent',
                name: agent?.name || id.charAt(0).toUpperCase() + id.slice(1),
                description: `Agent: ${agent?.name || id}`
            };
        });

        res.json({ data: agents });
    } catch (error) {
        console.error('[Models] Error listing agents:', error);
        res.status(500).json({ error: 'Failed to retrieve agents' });
    }
});

// Endpoint for chat completions - non-streaming only
router.post('/chat/completions', async (req, res) => {
    try {
        const { model, messages } = req.body;

        // Validate required fields
        if (!model || !messages || !Array.isArray(messages)) {
            return res.status(400).json({
                error: 'Invalid request: model and messages array are required'
            });
        }

        // Get the agent by model ID
        const agent = AgentManager.getAgent(model);
        if (!agent) {
            return res.status(404).json({
                error: `Agent not found: ${model}`
            });
        }

        // Extract user message (last message should be from user)
        const userMessage = messages[messages.length - 1];
        if (!userMessage || userMessage.role !== 'user') {
            return res.status(400).json({
                error: 'Last message must be from user'
            });
        }

        // Build LLM config from agent's provider
        const providerConfig = agent.providerConfig || {};
        const llmConfig = {
            baseUrl: providerConfig.endpoint,
            modelId: providerConfig.model,
            apiKey: providerConfig.apiKey,
            maxTokens: providerConfig.maxTokens,
            supportsTools: !!providerConfig?.capabilities?.trained_for_tool_use,
        };

        // Run the agent loop without streaming
        let fullResponse = '';
        const responseGenerator = runAgentLoop({
            agentId: agent.id,
            sessionId: `openai-${Date.now()}`,
            llmConfig,
            messages: messages.slice(0, -1), // Pass conversation history (excluding the last user message)
            visionEnabled: !!providerConfig?.capabilities?.vision,
            maxLoops: agent.maxLoops || 100,
        });

        // Collect all chunks
        for await (const chunk of responseGenerator) {
            fullResponse += chunk;
        }

        // Return complete response in OpenAI format
        res.json({
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: fullResponse
                    },
                    finish_reason: 'stop'
                }
            ],
            usage: {
                prompt_tokens: userMessage.content.split(' ').length,
                completion_tokens: fullResponse.split(' ').length,
                total_tokens: (userMessage.content + fullResponse).split(' ').length
            }
        });
    } catch (error) {
        console.error('[Chat Completions] Error:', error);
        res.status(500).json({
            error: error.message || 'Failed to generate response'
        });
    }
});

export default router;
