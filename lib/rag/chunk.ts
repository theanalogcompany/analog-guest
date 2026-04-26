// Rough token estimate: ~4 chars per token for English text. Good enough for
// chunking decisions; replace with tiktoken or a real tokenizer if precision
// becomes important.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function splitSentences(paragraph: string): string[] {
  return paragraph.split(/(?<=[.!?])\s+/).filter((s) => s.length > 0)
}

/**
 * Split text into chunks of approximately maxTokens tokens, preferring
 * paragraph boundaries, then sentence boundaries. Sentences longer than
 * maxTokens are kept whole rather than split mid-sentence.
 */
export function chunkText(text: string, maxTokens: number = 300): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  if (estimateTokens(trimmed) <= maxTokens) return [trimmed]

  const paragraphs = trimmed.split(/\n\s*\n+/).map((p) => p.trim()).filter((p) => p.length > 0)

  const chunks: string[] = []
  for (const para of paragraphs) {
    if (estimateTokens(para) <= maxTokens) {
      chunks.push(para)
      continue
    }

    const sentences = splitSentences(para)
    let buffer = ''
    for (const sentence of sentences) {
      if (estimateTokens(sentence) > maxTokens) {
        if (buffer.length > 0) {
          chunks.push(buffer.trim())
          buffer = ''
        }
        chunks.push(sentence.trim())
        continue
      }
      const next = buffer.length === 0 ? sentence : `${buffer} ${sentence}`
      if (estimateTokens(next) > maxTokens) {
        chunks.push(buffer.trim())
        buffer = sentence
      } else {
        buffer = next
      }
    }
    if (buffer.length > 0) chunks.push(buffer.trim())
  }

  return chunks
}