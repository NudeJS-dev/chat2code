import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { countTokens } from '@anthropic-ai/tokenizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const env = process.env;
const DEBUG = env.DEBUG === 'true';
const modelMap = parseModelMap();
const defaultModel = env.DEFAULT_MODEL || Object.keys(modelMap)[0];
const responseCache = {};

const FUNCTION_CALL_TPL = readPrompt('function_call');
const FIX_JSON_TPL = readPrompt('fix_json');

const app = express();
app.use(express.json({ limit: '10mb' }));

const jsonOk = (res, data, status = 200) => res.status(status).json(data);
const jsonError = (res, status, message) => jsonOk(res, { error: { code: status, message } }, status);
const getAuthHeader = (req) => req.get('authorization') || req.get('Authorization');
const uuidHex = (len) => crypto.randomBytes(len / 2).toString('hex');
const md5 = (text) => crypto.createHash('md5').update(text).digest('hex');

function parseModelMap()
{
    // MODELS=gpt5,...
    const models = env.MODELS?.split(',') || [];
    // OPENAI_BASE_URLS=https://api.openai.com,...
    const baseUrls = env.OPENAI_BASE_URLS?.split(',') || [];
    // OPENAI_KEYS=sk-xxx,...
    const keys = env.OPENAI_KEYS?.split(',') || [];
    if (models.length !== baseUrls.length || models.length !== keys.length)
        throw new Error('MODELS, OPENAI_BASE_URLS, OPENAI_KEYS must have the same length');
    const map = {};
    for (let i = 0; i < models.length; i++)
    {
        map[models[i]] = { baseUrl: baseUrls[i], key: keys[i] };
    }
    return map;
}

function readPrompt(promptName)
{
    const p = path.join(__dirname, `prompts/${promptName}.txt`);
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    throw new Error(`${promptName}.txt not found`);
}

async function safeText(res)
{
    try
    {
        return await res.text();
    }
    catch (_)
    {
        return 'Unknown error';
    }
}

function extractSystemText(system)
{
    if (!system) return '';
    if (Array.isArray(system)) {
        return system
            .filter((i) => i && i.type === 'text')
            .map((i) => String(i.text ?? ''))
            .join('\n');
    }
    if (typeof system === 'string') return system;
    return '';
}

function serializeContentToText(content)
{
    if (typeof content === 'string') return content;
    if (Array.isArray(content))
    {
        const parts = [];
        for (const item of content)
        {
            if (!item || typeof item !== 'object') continue;
            if (item.type === 'text') parts.push(String(item.text ?? ''));
            else if (item.type === 'tool_use')
            {
                const name = String(item.name ?? '');
                const input = JSON.stringify(item.input ?? {});
                parts.push(`[tool_use:${name}] ${input}`);
            }
            else if (item.type === 'tool_result')
            {
                const rtext = Array.isArray(item.content) ? item.content.map((c) => (c?.type === 'text' ? String(c.text ?? '') : '')).join('\n') : String(item.text ?? '');
                parts.push(`[tool_result] ${rtext}`);
            }
        }
        return parts.join('\n');
    }
    if (content && typeof content === 'object' && 'text' in content) return String(content.text ?? '');
    return '';
}

function messagesToText(messages)
{
    if (!Array.isArray(messages)) return '';
    return messages.map((m) =>
    {
        const role = String(m?.role ?? 'user');
        const contentText = serializeContentToText(m?.content);
        return `role:${role}\n${contentText}`;
    }).join('\n---\n');
}

function countAnthropicTokensLocal(messages, system)
{
    try
    {
        const systemText = extractSystemText(system);
        const messagesText = messagesToText(messages);
        const full = [systemText, messagesText].filter(Boolean).join('\n---\n');
        const n = countTokens(full);
        return typeof n === 'number' && isFinite(n) ? n : 0;
    }
    catch (_)
    {
        return 0;
    }
}

function getNowTimeText()
{
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const MM = String(now.getMinutes()).padStart(2, '0');
    const SS = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}-${HH}:${MM}:${SS}`;
}

async function tryToFixJson(auth, jsonText)
{
    const jsonResp = await fetch(`${modelMap[defaultModel].baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: auth,
        },
        body: JSON.stringify({
            model: defaultModel,
            messages: [{ role: 'user', content: FIX_JSON_TPL.replace('<$JSON$>', jsonText) }],
            stream: false,
        }),
    });
    if (!jsonResp.ok) return null;
    const openai = await jsonResp.json();
    let content = String(openai?.choices?.[0]?.message?.content ?? '');
    content = content.replace(/<Json>[\s\S]*?<\/Json>/g, '').replace(/\\<Json\\>/g, '<Json>').replace(/\\<\/Json\\>/g, '</Json>');
    const match = content.match(/<Json>([\s\S]*?)<\/Json>/);
    if (!match) return null;
    try
    {
        console.log('fix json');
        return JSON.parse(match[1].trim());
    }
    catch (e)
    {
        console.log('but failed');
        return null;
    }
}

app.post('/v1/messages', async (req, res) =>
{
    if(!modelMap[req.body.model]) req.body.model = defaultModel;
    const auth = getAuthHeader(req);
    if (!auth) return jsonError(res, 401, 'missing authorization header');
    const nowTimeText = getNowTimeText();
    const body = req.body || {};
    let logText = `[Request]\nUrl: ${req.url}\nMethod: ${req.method}\nBody: ${JSON.stringify(body)}\n\n`;
    const systemText = extractSystemText(body?.system);
    const toolsStr = JSON.stringify(body?.tools ?? []);
    const messagesStr = JSON.stringify(body?.messages ?? []);
    const fcPrompt = FUNCTION_CALL_TPL.replaceAll('<$SystemPrompt$>', systemText)
                            .replaceAll('<$Tools$>', toolsStr)
                            .replaceAll('<$Messages$>', messagesStr);
    const openaiReq = {
        model: body?.model,
        messages: [{ role: 'user', content: fcPrompt }],
        stream: false,
        max_tokens: body?.max_tokens,
        temperature: body?.temperature,
    };
    try
    {
        let answerTag = `${md5(JSON.stringify(openaiReq.messages))}-${openaiReq.model}`;
        if (responseCache[answerTag])
        {
            let resp = responseCache[answerTag];
            resp.id = uuidHex(32);
            resp.usage.input_tokens = 0;
            resp.usage.output_tokens = 0;
            resp.usage.cache_read_input_tokens = 0;
            return jsonOk(res, resp);
        }
        const chatResp = await fetch(`${modelMap[body.model].baseUrl}/v1/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${modelMap[body.model].key}`,
            },
            body: JSON.stringify(openaiReq),
        });
        if (!chatResp.ok)
        {
            const message = await safeText(chatResp);
            logText += `[Response]\nStatus: ${chatResp.status}\nBody: ${message}\n\n`;
            if(DEBUG) fs.writeFileSync(`errors/${nowTimeText}.txt`, logText, 'utf-8');
            return jsonError(res, chatResp.status, message);
        }
        const openai = await chatResp.json();
        logText += `[Response]\nStatus: ${chatResp.status}\nBody: ${JSON.stringify(openai)}\n\n`;
        let content = String(openai?.choices?.[0]?.message?.content ?? '');
        content = content.replace(/<think>[\s\S]*<\/think>/g, '').replace(/\\<AnswerInJson\\>/g, '<AnswerInJson>').replace(/\\<\/AnswerInJson\\>/g, '</AnswerInJson>');
        const match = content.match(/<AnswerInJson>([\s\S]*)<\/AnswerInJson>/);
        if (!match)
        {
            logText += `[ParseFailed]\nParse failed : ${content}\n\n`;
            if(DEBUG) fs.writeFileSync(`errors/${nowTimeText}.txt`, logText, 'utf-8');
            return jsonError(res, 500, `parse failed : ${content}`);
        }
        let raw;
        let answerObj;
        try
        {
            raw = match[1].trim().replace(/&quot;/, '"').replace(/\\_/, '_');
            let headIndex = raw.indexOf('{');
            if (headIndex > 0) raw = raw.substring(headIndex);
            let tailIndex = raw.lastIndexOf('}');
            if (tailIndex > 0) raw = raw.substring(0, tailIndex + 1);
            answerObj = JSON.parse(raw);
        }
        catch (e)
        {
            answerObj = await tryToFixJson(raw);
            if(!answerObj)
            {
                logText += `[JsonFailed]\nRaw:\n${raw}\nError:\n${e.message}\n`;
                if(DEBUG) fs.writeFileSync(`errors/${nowTimeText}.txt`, logText, 'utf-8');
                return jsonError(res, 500, `parse failed : ${content}`);
            }
        }
        if (Array.isArray(answerObj?.content))
        {
            for (const item of answerObj.content)
            {
                if (item && item.type === 'tool_use') item.id = `call_${uuidHex(24)}`;
            }
        }
        const inputTokens = countAnthropicTokensLocal(body?.model, body?.messages, body?.system);
        const outputTokens = (() => {
            try
            {
                const n = countTokens(content);
                return typeof n === 'number' && isFinite(n) ? n : 0;
            }
            catch (_)
            {
                return 0;
            }
        })();
        const response = {
            id: uuidHex(32),
            type: 'message',
            role: 'assistant',
            content: answerObj.content,
            model: body?.model,
            stop_reason:
                Array.isArray(answerObj?.content) && answerObj.content.find((i) => i?.type === 'tool_use')
                    ? 'tool_use'
                    : 'end_turn',
            usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_read_input_tokens: 0,
            },
        };
        responseCache[answerTag] = response;
        return jsonOk(res, response);
    }
    catch (e)
    {
        return jsonError(res, 500, String(e?.message || e));
    }
});

const port = Number(env.PORT || 3000);
app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});