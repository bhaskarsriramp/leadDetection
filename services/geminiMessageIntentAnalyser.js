import { VertexAI } from "@google-cloud/vertexai";

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

const model = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 2048, // increased for batch responses
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
- personal (friendly chat, personal life)
- lead (interested in buying fitness programs/coaching)
- collaboration (business partnership, sponsorship)
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

RESPOND ONLY AS A VALID JSON ARRAY (no markdown, no backticks):
[
  { "index": 0, "intent": "general", "confidence": 0.9, "seriousness": 0.2 },
  { "index": 1, "intent": "lead", "confidence": 0.85, "seriousness": 0.7 }
]
`;

/**
 * Call Gemini with exponential backoff retry
 */
async function callGeminiWithRetry(prompt, retries = 0) {
  try {
    const response = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
    });

    const text = response.response.candidates[0].content.parts[0].text;
    
    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No JSON array found in response");
    }
    
    return JSON.parse(jsonMatch[0]);

  } catch (err) {
    const isRateLimited = 
      err?.response?.status === 429 || 
      err.message?.includes("429") || 
      err.message?.includes("RESOURCE_EXHAUSTED");

    if (isRateLimited && retries < MAX_RETRIES) {
      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retries), MAX_DELAY_MS);
      console.warn(`[Gemini] 429 hit, retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
      return callGeminiWithRetry(prompt, retries + 1);
    }

    // Also retry on transient errors
    const isTransient = 
      err.message?.includes("500") || 
      err.message?.includes("503") ||
      err.message?.includes("UNAVAILABLE");

    if (isTransient && retries < MAX_RETRIES) {
      const delay = Math.min(INITIAL_DELAY_MS * Math.pow(2, retries), MAX_DELAY_MS);
      console.warn(`[Gemini] Transient error, retry ${retries + 1}/${MAX_RETRIES} after ${delay}ms`);
      await sleep(delay);
      return callGeminiWithRetry(prompt, retries + 1);
    }

    throw err;
  }
}

/**
 * Analyze messages in batches using single Gemini call
 * @param {Array<{ messageId: string, message: string }>} messages
 * @returns {Promise<Array<{ messageId: string, intent: string, confidence: number, seriousness: number, error?: boolean }>>}
 */
export async function analyzeMessageIntent(messages) {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Build batched prompt
  const batchedMessages = messages
    .map((m, i) => `[${i}] "${m.message}"`)
    .join("\n");

  const fullPrompt = `${BATCH_SYSTEM_PROMPT}\n\nMessages to analyze:\n${batchedMessages}`;

  try {
    const parsed = await callGeminiWithRetry(fullPrompt);

    if (!Array.isArray(parsed)) {
      throw new Error("Gemini response is not an array");
    }

    // Map results back to message IDs
    const results = messages.map((msg, i) => {
      const result = parsed.find((p) => p.index === i) || parsed[i];

      if (!result) {
        return {
          messageId: msg.messageId,
          intent: "general",
          confidence: 0,
          seriousness: 0,
          error: true,
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

    console.log(`[Gemini] Batch analyzed ${results.length} messages`);
    return results;

  } catch (err) {
    console.error("[Gemini] Batch call failed:", err.message);

    // Fail gracefully — mark all as general so they don't get stuck
    return messages.map((m) => ({
      messageId: m.messageId,
      intent: "general",
      confidence: 0,
      seriousness: 0,
      error: true,
    }));
  }
}