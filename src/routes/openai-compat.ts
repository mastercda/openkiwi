import express, { Request, Response } from 'express';
import { AgentManager } from '../agent-manager.js';
import { runAgentLoop, AgentLoopResult, AgentLoopOptions } from '../agent-loop.js';
import { loadConfig } from '../config-manager.js';
import { SessionManager } from '../session-manager.js';
import { logger } from '../logger.js';

const router = express.Router();

/**
 * Execute the agent loop and return AgentLoopResult.
 *
 * runAgentLoop is typed as AsyncGenerator<string, AgentLoopResult>.
 * With target=ESNext + Node.js, it is a **real native AsyncGenerator** —
 * awaiting it directly only gives back the generator object (body never runs).
 * We must iterate it with .next() to run the body and collect the return value.
 *
 * tsx/esbuild may sometimes compile async generators to plain async functions
 * (returns Promise<AgentLoopResult>). We detect that case by checking for
 * a .next() method and handle both paths.
 */
async function execLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
    const gen = runAgentLoop(options);

    // Plain Promise path (tsx/esbuild strips generator semantics)
    if (typeof (gen as any).next !== 'function') {
        return (gen as unknown as Promise<AgentLoopResult>);
    }

    // Native AsyncGenerator path — iterate to completion
    const asyncGen = gen as AsyncGenerator<string, AgentLoopResult, unknown>;
    let step = await asyncGen.next();
    while (!step.done) {
        step = await asyncGen.next();
    }
    return step.value;
}

/** Strip reasoning/thinking tags from a model response. */
function cleanReasoning(text: string): string {
    return (text || '')
        .replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .trim();
}

/** OpenAI-compatible error body. */
function oaiError(message: string, status: number, code?: string) {
    const typeMap: Record<number, string> = {
        400: 'invalid_request_error',
        401: 'authentication_error',
        403: 'permission_error',
        404: 'not_found_error',
        500: 'api_error',
    };
    return {
        error: {
            message,
            type: typeMap[status] ?? 'api_error',
            param: null,
            code: code ?? null,
        },
    };
}

// ─── GET /models ─────────────────────────────────────────────────────────────
router.get('/models', (_req: Request, res: Response) => {
    try {
        const agentIds = AgentManager.listAgents();
        const data = agentIds.map(id => {
            const agent = AgentManager.getAgent(id);
            return {
                id: agent?.id || id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'openkiwi',
            };
        });
        res.json({ object: 'list', data });
    } catch (err) {
        logger.log({ type: 'error', level: 'error', message: `GET /models error: ${err}` });
        res.status(500).json(oaiError('Failed to retrieve models', 500));
    }
});

// ─── POST /chat/completions ───────────────────────────────────────────────────
router.post('/chat/completions', async (req: Request, res: Response) => {
    const { model, messages, stream = false, max_tokens, temperature } = req.body ?? {};

    // Validate required fields
    if (!model || typeof model !== 'string') {
        res.status(400).json(oaiError('Missing or invalid "model" field', 400));
        return;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json(oaiError('Missing or invalid "messages" field', 400));
        return;
    }

    // Resolve agent
    const agentId = model;
    const agent = AgentManager.getAgent(agentId);
    if (!agent) {
        res.status(404).json(oaiError(`Model "${agentId}" not found`, 404, 'model_not_found'));
        return;
    }

    // Resolve provider config (mirrors Telegram.ts logic)
    const currentConfig = loadConfig();
    const providerName = agent.provider;
    let providerConfig = currentConfig.providers.find(
        (p: any) => p.model === providerName || p.description === providerName
    );
    if (!providerConfig && currentConfig.providers.length > 0) {
        providerConfig = currentConfig.providers[0];
        logger.log({
            type: 'system', level: 'warn',
            message: `OAI compat: using default provider ${providerConfig.model} for agent ${agentId} (configured provider "${providerName}" not found)`
        });
    }
    if (!providerConfig) {
        res.status(500).json(oaiError('No LLM provider configured', 500));
        return;
    }

    const llmConfig = {
        baseUrl: providerConfig.endpoint,
        modelId: providerConfig.model,
        apiKey: providerConfig.apiKey,
        maxTokens: max_tokens ?? providerConfig.maxTokens,
        supportsTools: !!providerConfig?.capabilities?.trained_for_tool_use,
        ...(temperature !== undefined ? { temperature } : {}),
    };

    // Build payload: inject agent system prompt unless the caller already provided one
    const hasSystemMessage = messages.some((m: any) => m.role === 'system');
    const systemPrompt = agent.systemPrompt || currentConfig.global?.systemPrompt || 'You are a helpful AI assistant.';
    const payload: any[] = [
        ...(!hasSystemMessage ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages,
    ];

    const completionId = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);

    // ── Streaming path ────────────────────────────────────────────────────────
    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Helper to send one SSE event
        const sendChunk = (delta: Record<string, any>, finishReason: string | null = null) => {
            const chunk = {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: agentId,
                choices: [{ index: 0, delta, finish_reason: finishReason }],
            };
            res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        // Role chunk first
        sendChunk({ role: 'assistant' });

        try {
            // Use the native AsyncGenerator directly for streaming
            const gen = runAgentLoop({
                agentId,
                sessionId: `oai-${agentId}-stream-${Date.now()}`,
                llmConfig,
                messages: payload,
                visionEnabled: !!providerConfig?.capabilities?.vision,
                maxLoops: agent.maxLoops ?? 100,
                signToolUrls: false,
                agentToolsConfig: agent.tools,
            });

            if (typeof (gen as any).next === 'function') {
                const asyncGen = gen as AsyncGenerator<string, AgentLoopResult, unknown>;
                let step = await asyncGen.next();
                while (!step.done) {
                    if (step.value) {
                        sendChunk({ content: step.value });
                    }
                    step = await asyncGen.next();
                }
                // step.value is AgentLoopResult — send usage in final chunk
                const result = step.value as AgentLoopResult;
                sendChunk({}, 'stop');
                const doneChunk = {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: agentId,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: result.usage,
                };
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
            } else {
                // Fallback: plain Promise (tsx/esbuild strips generator semantics)
                const result = await (gen as unknown as Promise<AgentLoopResult>);
                const cleaned = cleanReasoning(result.finalResponse);
                sendChunk({ content: cleaned });
                sendChunk({}, 'stop');
            }
        } catch (err) {
            logger.log({ type: 'error', level: 'error', message: `OAI /chat/completions stream error: ${err}` });
            const errorChunk = { error: { message: String(err), type: 'api_error' } };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        }

        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    // ── Non-streaming path ────────────────────────────────────────────────────
    try {
        const result = await execLoop({
            agentId,
            sessionId: `oai-${agentId}-${Date.now()}`,
            llmConfig,
            messages: payload,
            visionEnabled: !!providerConfig?.capabilities?.vision,
            maxLoops: agent.maxLoops ?? 100,
            signToolUrls: false,
            agentToolsConfig: agent.tools,
        });

        const content = cleanReasoning(result.finalResponse);

        res.json({
            id: completionId,
            object: 'chat.completion',
            created,
            model: agentId,
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                },
            ],
            usage: result.usage,
        });
    } catch (err) {
        logger.log({ type: 'error', level: 'error', message: `OAI /chat/completions error: ${err}` });
        res.status(500).json(oaiError(`Agent loop failed: ${err}`, 500));
    }
});

export default router;

