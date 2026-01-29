import { VertexAI } from "@google-cloud/vertexai";

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

const model = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 2048,
  },
});

// Retry config
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BATCH_SYSTEM_PROMPT = `
You analyze multiple Instagram DM messages for a fitness creator.

For EACH message, classify the intent as ONE of:
- lead (interested in buying fitness programs/coaching)
- collaboration (business partnership, sponsorship, paid collaboration)
- general (greetings, unclear, noise)

Rules:
- Casual curiosity ≠ lead
- Friendly tone ≠ lead
- Be conservative
- Prefer "general" if unsure

Also estimate SERIOUSNESS (0.0 to 1.0):
- Very short messages → 0.1-0.3
- Browsing/exploration → 0.3-0.5
- Clear goals, numbers, timelines → 0.6-0.8
- Contact sharing, explicit readiness → 0.8-1.0

CRITICAL: Respond ONLY with a valid JSON array. No markdown, no backticks, no explanation.
Example response format:
[
  { "index": 0, "intent": "general", "confidence": 0.9, "seriousness": 0.2 },
  { "index": 1, "intent": "lead", "confidence": 0.85, "seriousness": 0.7 },
  { "index": 2, "intent": "business", "confidence": 0.77, "seriousness": 0.63 }
]
`;

/**
 * Extract JSON array from Gemini response (handles various formats)
 */
function extractJsonArray(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  // Try 1: Direct JSON array
  let jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      // Continue to other methods
    }
  }

  // Try 2: Markdown code block ```json ... ```
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch (e) {
      // Continue
    }
  }

  // Try 3: Single object (when only 1 message sent)
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const obj = JSON.parse(objectMatch[0]);
      return [obj]; // Wrap in array
    } catch (e) {
      // Continue
    }
  }

  return null;
}

/**
 * Call Gemini with exponential backoff retry
 */
async function callGeminiWithRetry(prompt, messages, retries = 0) {
  try {
    const response = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    });

    const text = response.response.candidates[0]?.content?.parts[0]?.text;

    if (!text) {
      console.error("[Gemini] Empty response received");
      console.error("[Gemini] Full response:", JSON.stringify(response.response, null, 2));
      throw new Error("Empty response from Gemini");
    }

    const parsed = extractJsonArray(text);

    if (!parsed) {
      // Log detailed debug info
      console.error("═══════════════════════════════════════════════════");
      console.error("[Gemini] PARSE FAILURE - No JSON array found");
      console.error("═══════════════════════════════════════════════════");
      console.error("[Gemini] Raw response text:");
      console.error(text);
      console.error("───────────────────────────────────────────────────");
      console.error("[Gemini] Input messages that caused this:");
      console.error(JSON.stringify(messages, null, 2));
      console.error("═══════════════════════════════════════════════════");
      
      throw new Error(`GEMINI_PARSE_FAILED: ${text.substring(0, 200)}`);
    }

    return parsed;

  } catch (err) {
    const isRateLimited =
      err?.response?.status === 429 ||
      err.message?.includes("429") ||
      err.message?.includes("RESOURCE_EXHAUSTED");

    if (isRateLimited && retries < MAX_RETRIES) {
      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retries), MAX_DELAY_MS);
      console.warn(`[Gemini] 429 hit, retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
      return callGeminiWithRetry(prompt, messages, retries + 1);
    }

    const isTransient =
      err.message?.includes("500") ||
      err.message?.includes("503") ||
      err.message?.includes("UNAVAILABLE");

    if (isTransient && retries < MAX_RETRIES) {
      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retries), MAX_DELAY_MS);
      console.warn(`[Gemini] Transient error, retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
      return callGeminiWithRetry(prompt, messages, retries + 1);
    }

    // Retry on parse failures too (Gemini sometimes returns bad responses)
    if (err.message?.includes("GEMINI_PARSE_FAILED") && retries < 2) {
      const delay = 1000;
      console.warn(`[Gemini] Parse failed, retry ${retries + 1}/2 after ${delay}ms`);
      await sleep(delay);
      return callGeminiWithRetry(prompt, messages, retries + 1);
    }

    throw err;
  }
}

/**
 * Analyze messages in batches using single Gemini call
 */
export async function analyzeMessageIntent(messages) {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Sanitize messages to prevent prompt injection / malformed input
  const sanitizedMessages = messages.map((m, i) => ({
    ...m,
    message: (m.message || "")
      .replace(/[\r\n]+/g, " ")  // Remove newlines
      .replace(/"/g, "'")        // Replace double quotes
      .substring(0, 500)         // Limit length
      .trim(),
  }));

  // Build batched prompt
  const batchedMessages = sanitizedMessages
    .map((m, i) => `[${i}] "${m.message}"`)
    .join("\n");

  const fullPrompt = `${BATCH_SYSTEM_PROMPT}\n\nMessages to analyze (${messages.length} total):\n${batchedMessages}`;

  try {
    const parsed = await callGeminiWithRetry(fullPrompt, sanitizedMessages);

    if (!Array.isArray(parsed)) {
      throw new Error("Gemini response is not an array");
    }

    // Map results back to message IDs
    const results = messages.map((msg, i) => {
      const result = parsed.find((p) => p.index === i) || parsed[i];

      if (!result) {
        console.warn(`[Gemini] Missing result for index ${i}, messageId: ${msg.messageId}`);
        return {
          messageId: msg.messageId,
          intent: "general",
          confidence: 0,
          seriousness: 0,
          error: true,
          errorReason: "MISSING_IN_RESPONSE",
        };
      }

      return {
        messageId: msg.messageId,
        intent: result.intent || "general",
        confidence: Number((result.confidence || 0).toFixed(3)),
        seriousness: Number((result.seriousness || 0).toFixed(3)),
        error: false,
      };
    });

    console.log(`[Gemini] Batch analyzed ${results.length} messages successfully`);
    return results;

  } catch (err) {
    console.error("[Gemini] Batch call failed:", err.message);

    // Return with error flag so we know these need attention
    return messages.map((m) => ({
      messageId: m.messageId,
      intent: "general",
      confidence: 0,
      seriousness: 0,
      error: true,
      errorReason: err.message?.substring(0, 100),
    }));
  }
}