// Local estimation for /v1/messages/count_tokens.
//
// Claude Code calls this endpoint to decide when to auto-compact. Proxies that
// 404 it break compaction silently — the session simply runs into the context
// limit later and errors. Anthropic also rejects the endpoint outright for
// subscription tokens ("jwt auth is not yet supported on count_tokens"), so
// forwarding is not always an option either. Answering locally is.
//
// This is an ESTIMATE and the numbers should not be presented as anything
// else: Anthropic publishes no client-side tokenizer, `tiktoken` is not valid
// for Claude, and tokenizers differ across model generations.

/** Characters per token for English prose mixed with code. */
const CHARS_PER_TOKEN = 3.5
/** Per-message framing: role markers and delimiters. */
const PER_MESSAGE_OVERHEAD = 4
/**
 * Flat cost for an image.
 *
 * Real cost depends on dimensions we cannot read from a base64 blob without
 * decoding it. Over-estimating compacts slightly early; under-estimating lets
 * a request grow until the provider rejects it, so the bias is deliberate.
 */
const IMAGE_TOKENS = 1600

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown }

export function estimateRequestTokens(body: unknown): number {
  if (!body || typeof body !== 'object') return 0
  const req = body as { system?: unknown; messages?: unknown; tools?: unknown }
  let total = 0

  if (typeof req.system === 'string') total += estimateTokens(req.system)
  else if (Array.isArray(req.system)) total += estimateBlocks(req.system)

  if (Array.isArray(req.messages)) {
    for (const raw of req.messages) {
      total += PER_MESSAGE_OVERHEAD
      const message = raw as { content?: unknown }
      if (typeof message?.content === 'string') total += estimateTokens(message.content)
      else if (Array.isArray(message?.content)) total += estimateBlocks(message.content)
    }
  }

  if (Array.isArray(req.tools)) {
    for (const raw of req.tools) {
      const tool = raw as { name?: string; description?: string; input_schema?: unknown }
      total += estimateTokens(tool?.name ?? '') + estimateTokens(tool?.description ?? '')
      if (tool?.input_schema) total += estimateTokens(JSON.stringify(tool.input_schema))
    }
  }

  return total
}

function estimateBlocks(blocks: unknown[]): number {
  let total = 0
  for (const raw of blocks) {
    const block = raw as Block
    switch (block?.type) {
      case 'text':
        total += estimateTokens(block.text ?? '')
        break
      case 'thinking':
        total += estimateTokens(block.thinking ?? '')
        break
      case 'tool_use':
        total += estimateTokens(block.name ?? '') + estimateTokens(JSON.stringify(block.input ?? {}))
        break
      case 'tool_result':
        if (typeof block.content === 'string') total += estimateTokens(block.content)
        else if (Array.isArray(block.content)) total += estimateBlocks(block.content)
        break
      case 'image':
        total += IMAGE_TOKENS
        break
      default:
        if (typeof block?.text === 'string') total += estimateTokens(block.text)
    }
  }
  return total
}
