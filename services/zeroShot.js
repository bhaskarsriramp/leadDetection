// zeroShot.js 
import axios from "axios";

const HF_API_KEY = process.env.HF_API_KEY;
const HF_API_URL = "https://router.huggingface.co/hf-inference/models/facebook/bart-large-mnli";


const LABELS = [
  "greeting_or_salutation",
  "courtesy",
  "automation",
  "flow_trigger",
  "emoji",
  "reaction",
  "compliment",
  "appreciation",
  "gibberish",
  "meaningful_inquiry",
];

/**
 * Retry config
 */
const INITIAL_DELAY_MS = 2000;
const MAX_DELAY_MS = 60000;
const MAX_RETRIES = 5;

/**
 * Confidence threshold - adjust based on your needs
 * Higher = more strict filtering, Lower = more messages pass through
 */
const CONFIDENCE_THRESHOLD = 0.75;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Normalize HF result into { label, score }
 */
function normalizeResult(item) {
  // Case 1: [{ label, score }]
  if (Array.isArray(item) && item.length > 0 && item[0].label) {
    const allScores = {};
    item.forEach((curr) => {
      allScores[curr.label] = curr.score;
    });

    return {
      label: item[0].label,
      score: item[0].score,
      allScores,
    };
  }

  // Case 2: { labels: [], scores: [] }
  if (item && Array.isArray(item.labels) && Array.isArray(item.scores)) {
    const allScores = {};
    item.labels.forEach((label, idx) => {
      allScores[label] = item.scores[idx];
    });

    return {
      label: item.labels[0],
      score: item.scores[0],
      allScores,
    };
  }

  return null;
}

/**
 * Determine if message should pass to LLM for analysis
 */
function shouldPassToLLM(normalized) {
  if (!normalized) return true; // When in doubt, pass to LLM

  const { label, score, allScores } = normalized;

  // If top prediction is meaningful_inquiry, pass to LLM
  if (label === "meaningful_inquiry") {
    return true;
  }

  // If confidence is low, pass to LLM (better safe than sorry)
  if (score < CONFIDENCE_THRESHOLD) {
    return true;
  }

  // Check if meaningful_inquiry has reasonable score even if not top
  const meaningfulScore = allScores?.["meaningful_inquiry"] || 0;
  if (meaningfulScore > 0.6) {
    return true;
  }

  // Otherwise, filter out (don't pass to LLM)
  return false;
}

/**
 * Main batch filter function
 * @param {Array<{ id: string, message: string }>} messages
 * @returns {Promise<Array<{ messageId: string, message: string, PASS_CONV: boolean, label?: string, confidence?: number, reason?: string }>>}
 */
export async function zeroShotBatchFilter(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  if (!HF_API_KEY) {
    console.error("[HF] API key not found, passing all messages to LLM");
    return messages.map((c) => ({
      messageId: c.id,
      message: c.message,
      PASS_CONV: true,
      reason: "MISSING_API_KEY",
    }));
  }

  // Prepare inputs - clean and validate
  const inputs = messages.map((c) => {
    const text = typeof c.message === "string" ? c.message.trim() : "";
    // Return empty string for truly empty messages, model will handle it
    return text || "";
  });

  let delay = INITIAL_DELAY_MS;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const response = await axios.post(
        HF_API_URL,
        {
          inputs,
          parameters: {
            candidate_labels: LABELS,
          },
          options: {
            wait_for_model: true,
          },
        },
        {
          headers: {
            Authorization: `Bearer ${HF_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 120000,
        }
      );

      const data = response.data;

      if (!Array.isArray(data) || data.length !== messages.length) {
        throw new Error(
          `INVALID_BATCH_RESPONSE: expected ${messages.length} results, got ${data?.length || 0}`
        );
      }

      // Process results
      const results = data.map((item, index) => {
        const messageId = messages[index].id;
        const message = messages[index].message;
        const normalized = normalizeResult(item);

        if (!normalized) {
          return {
            messageId,
            message,
            PASS_CONV: true,
            reason: "EMPTY_MODEL_OUTPUT",
          };
        }

        const { label, score, allScores } = normalized;
        const PASS_CONV = shouldPassToLLM(normalized);

        return {
          messageId,
          message,
          label,
          confidence: Number(score.toFixed(3)),
          meaningfulScore: allScores?.["meaningful_inquiry"]
            ? Number(allScores["meaningful_inquiry"].toFixed(3))
            : undefined,
          PASS_CONV,
        };
      });

const passed = results.filter((r) => r.PASS_CONV);

console.log(
  `[HF] Classification complete: ${passed.length}/${results.length} messages passed to Gemini (${(
    (passed.length / results.length) *
    100
  ).toFixed(1)}%)`
);

return passed;



    } catch (err) {
      retries++;
      const status = err?.response?.status;

      console.error(
        `[HF RETRY ${retries}/${MAX_RETRIES}] delay=${delay}ms, status=${status}`,
        err?.response?.data || err.message
      );

      // Stop on non-recoverable errors
      if ([400, 401, 403, 422].includes(status)) {
        console.error(
          "[HF] Non-recoverable error, passing all messages to LLM"
        );
        return messages.map((c) => ({
          messageId: c.id,
          message: c.message,
          PASS_CONV: true,
          reason: "NON_RECOVERABLE_HF_ERROR",
        }));
      }

      // If max retries exceeded, pass all to LLM
      if (retries >= MAX_RETRIES) {
        console.error("[HF] Max retries exceeded, passing all messages to LLM");
        return messages.map((c) => ({
          messageId: c.id,
          message: c.message,
          PASS_CONV: true,
          reason: "MAX_RETRIES_EXCEEDED",
        }));
      }

      // Wait and retry with exponential backoff
      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }

  // Fallback (should never reach here, but just in case)
  return messages.map((c) => ({
    messageId: c.id,
    message: c.message,
    PASS_CONV: true,
    reason: "UNEXPECTED_FALLBACK",
  }));
}

/**
 * Helper function to get summary statistics
 */
export function getFilterStats(results) {
  const total = results.length;
  const passed = results.filter((r) => r.PASS_CONV).length;
  const filtered = total - passed;

  const labelCounts = results.reduce((acc, r) => {
    if (r.label) {
      acc[r.label] = (acc[r.label] || 0) + 1;
    }
    return acc;
  }, {});

  return {
    total,
    passed,
    filtered,
    filterRate: ((filtered / total) * 100).toFixed(1) + "%",
    passRate: ((passed / total) * 100).toFixed(1) + "%",
    labelDistribution: labelCounts,
  };
}