import express, { Request, Response } from 'express';
import { AgentManager } from '../agent-manager.js';
import { runAgentLoop, AgentLoopResult } from '../agent-loop.js';
import { loadConfig } from '../config-manager.js';
import { SessionManager } from '../session-manager.js';
import { logger } from '../logger.js';

const router = express.Router();

/**
 * Drains an async generator to completion and returns its final return value.
 * runAgentLoop is an AsyncGenerator — awaiting it directly only returns the
 * generator object itself.  This helper iterates all yielded values and gives
 * back the AgentLoopResult that the generator returns when done.
 */
async function drainLoop(
    gen: AsyncGenerator<string, AgentLoopResult, unknown>
): Promise<AgentLoopResult> {
    // runAgentLoop is typed as AsyncGenerator but may resolve as a plain Promise
    // at runtime (e.g. when transpiled by tsx/esbuild). Handle both shapes.
    if (typeof (gen as any).next !== 'function') {
        return await (gen as unknown as Promise<AgentLoopResult>);
    }
    let r: IteratorResult<string, AgentLoopResult>;
    while (!(r = await gen.next()).done) { /* deltas handled via onDelta callback */ }
    return r.value;
}

/** Strip reasoning/thinking tags from a model response. */
function cleanReasoning(text: string): string {
    return (text || '')
        .replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .trim();
}

/** Return an OpenAI-compatible error body. */
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

/** Write a single SSE data line. */
function sendChunk(res: Response, data: object): void {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
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
    try {
        const { model, messages, stream, max_tokens } = req.body as {
            model?: string;
            messages?: any[];
            stream?: boolean;
            max_tokens?: number;
        };

        if (!model) {
            return res.status(400).json(oaiError('Missing required field: model', 400));
        }
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json(oaiError('Missing required field: messages (must be an array)', 400));
        }

        // Resolve agent by id or name
        let agentId = model;
        let agent = AgentManager.getAgent(model);
        if (!agent) {
            for (const id of AgentManager.listAgents()) {
                const a = AgentManager.getAgent(id);
                if (
                    a &&
                    (a.name.toLowerCase() === model.toLowerCase() ||
                        a.id.toLowerCase() === model.toLowerCase())
                ) {
                    agent = a;
                    agentId = id;
                    break;
                }
            }
        }
        if (!agent) {
            return res.status(404).json(oaiError(`Model '${model}' not found`, 404, 'model_not_found'));
        }

        const currentConfig = loadConfig();
        const providerName = agent.provider;
        let providerConfig = currentConfig.providers.find(
            (p: any) => p.model === providerName || p.description === providerName
        );
        if (!providerConfig && currentConfig.providers.length > 0) {
            providerConfig = currentConfig.providers[0];
            logger.log({
                type: 'system',
                level: 'warn',
                message: `Using default provider ${providerConfig.model} for agent ${agentId}; configured provider '${providerName}' not found.`,
            });
        }
        if (!providerConfig) {
            logger.log({ type: 'error', level: 'error', message: `No provider found for agent ${agentId}` });
            return res.status(500).json(oaiError('No LLM provider configured', 500));
        }

        const llmConfig = {
            baseUrl: providerConfig.endpoint,
            modelId: providerConfig.model,
            apiKey: providerConfig.apiKey,
            maxTokens: max_tokens ?? providerConfig.maxTokens,
            supportsTools: !!providerConfig?.capabilities?.trained_for_tool_use,
        };

        // Build a fresh session for each OAI request
        const sessionId = `oai-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const firstUserMessage = messages.find((m: any) => m.role === 'user');
        const session = {
            id: sessionId,
            agentId,
            title: firstUserMessage?.content
                ? `${String(firstUserMessage.content).slice(0, 30)}...`
                : 'New chat',
            messages: [] as any[],
            updatedAt: Date.now(),
        };

        // Build LLM payload
        const payload: any[] = [];
        const systemPrompt =
            agent?.systemPrompt ||
            currentConfig.global?.systemPrompt ||
            'You are a helpful AI assistant.';
        payload.push({ role: 'system', content: systemPrompt });

        const validMessages = messages.filter((m: any) => m.role !== 'reasoning');
        payload.push(...validMessages);

        // Persist incoming messages
        const tsNow = Math.floor(Date.now() / 1000);
        for (const msg of validMessages) {
            session.messages.push({ role: msg.role, content: msg.content, timestamp: tsNow });
        }
        SessionManager.saveSession(session);

        // Stable IDs for this completion
        const completionId = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        // ── STREAMING ─────────────────────────────────────────────────────────
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.flushHeaders();

            const abortController = new AbortController();
            req.on('close', () => abortController.abort());

            let fullResponse = '';

            // OAI standard: first chunk carries the role delta
            sendChunk(res, {
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: agentId,
                choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            });

            try {
                const gen = runAgentLoop({
                    agentId,
                    sessionId,
                    llmConfig,
                    messages: payload,
                    visionEnabled: !!providerConfig?.capabilities?.vision,
                    maxLoops: agent?.maxLoops || 100,
                    signToolUrls: true,
                    agentToolsConfig: agent?.tools,
                    abortSignal: abortController.signal,
                    onDelta: (content: string) => {
                        fullResponse += content;
                        sendChunk(res, {
                            id: completionId,
                            object: 'chat.completion.chunk',
                            created,
                            model: agentId,
                            choices: [{ index: 0, delta: { content }, finish_reason: null }],
                        });
                    },
                });

                const result = await drainLoop(gen);

                // Final chunk with finish_reason and usage
                sendChunk(res, {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: agentId,
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    usage: result.usage,
                });
                res.write('data: [DONE]\n\n');
                res.end();

                // Persist cleaned response
                session.messages.push({
                    role: 'assistant',
                    content: cleanReasoning(fullResponse),
                    timestamp: Math.floor(Date.now() / 1000),
                });
                SessionManager.saveSession(session);

            } catch (err: any) {
                logger.log({ type: 'error', level: 'error', message: `Streaming error: ${err.message}` });
                sendChunk(res, { error: { message: err.message, type: 'api_error', param: null, code: null } });
                res.end();
            }

        // ── NON-STREAMING ─────────────────────────────────────────────────────
        } else {
            const gen = runAgentLoop({
                agentId,
                sessionId,
                llmConfig,
                messages: payload,
                visionEnabled: !!providerConfig?.capabilities?.vision,
                maxLoops: agent?.maxLoops || 100,
                signToolUrls: true,
                agentToolsConfig: agent?.tools,
            });

            const result = await drainLoop(gen);
            const cleanResponse = cleanReasoning(result.finalResponse);

            session.messages.push({
                role: 'assistant',
                content: cleanResponse,
                timestamp: Math.floor(Date.now() / 1000),
            });
            SessionManager.saveSession(session);

            res.json({
                id: completionId,
                object: 'chat.completion',
                created,
                model: agentId,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: cleanResponse },
                    logprobs: null,
                    finish_reason: 'stop',
                }],
                usage: result.usage,
            });
        }

    } catch (err: any) {
        logger.log({ type: 'error', level: 'error', message: `Chat completions error: ${err.message}` });
        res.status(500).json(oaiError(`Internal server error: ${err.message}`, 500));
    }
});

export default router;
	
