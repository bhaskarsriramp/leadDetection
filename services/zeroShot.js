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

// Labels that should NEVER reach Gemini if confident
const HARD_BLOCK_LABELS = [
  "greeting_or_salutation",
  "emoji",
  "reaction",
  "gibberish",
];



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
  if (item?.labels && item?.scores) {
    const allScores = {};
    item.labels.forEach((l, i) => {
      allScores[l] = item.scores[i];
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
  if (!normalized) return true;

  const { label, score, allScores } = normalized;

  // Hard block greetings / noise
  if (HARD_BLOCK_LABELS.includes(label) && score >= 0.8) {
    return false;
  }

  // Meaningful inquiry always passes
  if (label === "meaningful_inquiry") {
    return true;
  }

  // Low confidence → let Gemini decide
  if (score < CONFIDENCE_THRESHOLD) {
    return true;
  }

  // Secondary signal
  const meaningfulScore = allScores?.["meaningful_inquiry"] || 0;
  if (meaningfulScore > 0.6) {
    return true;
  }

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

  // Fail-open safety
  if (!HF_API_KEY) {
    console.error("[HF] Missing API key — passing all to Gemini");
    return messages.map((m) => ({
      messageId: m.id,
      message: m.message,
      PASS_CONV: true,
      reason: "MISSING_API_KEY",
    }));
  }

  const inputs = messages.map((m) =>
    typeof m.message === "string" ? m.message.trim() : ""
  );

  let delay = INITIAL_DELAY_MS;
  let retries = 0;

  while (retries < MAX_RETRIES) {
    try {
      const response = await axios.post(
        HF_API_URL,
        {
          inputs,
          parameters: { candidate_labels: LABELS },
          options: { wait_for_model: true },
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
        throw new Error("HF_BATCH_SIZE_MISMATCH");
      }

      const results = data.map((item, idx) => {
        const normalized = normalizeResult(item);
        const msg = messages[idx];

        if (!normalized) {
          return {
            messageId: msg.id,
            message: msg.message,
            PASS_CONV: true,
            reason: "EMPTY_MODEL_OUTPUT",
          };
        }

        const { label, score, allScores } = normalized;
        const PASS_CONV = shouldPassToLLM(normalized);

        return {
          messageId: msg.id,
          message: msg.message,
          label,
          confidence: Number(score.toFixed(3)),
          meaningfulScore: allScores?.meaningful_inquiry
            ? Number(allScores.meaningful_inquiry.toFixed(3))
            : undefined,
          PASS_CONV,
          filterReason: PASS_CONV ? "PASSED" : "HF_FILTERED",
        };
      });

      const passed = results.filter((r) => r.PASS_CONV).length;
      console.log(
        `[HF] Filtered ${results.length - passed}/${results.length}, passed ${passed}`
      );

      // 🔥 IMPORTANT: return ALL results
      return results;
    } catch (err) {
      retries++;
      const status = err?.response?.status;

      console.error(
        `[HF RETRY ${retries}/${MAX_RETRIES}] status=${status}`,
        err?.response?.data || err.message
      );

      if ([400, 401, 403, 422].includes(status)) {
        console.error("[HF] Non-recoverable error — fail open");
        return messages.map((m) => ({
          messageId: m.id,
          message: m.message,
          PASS_CONV: true,
          reason: "NON_RECOVERABLE_HF_ERROR",
        }));
      }

      if (retries >= MAX_RETRIES) {
        console.error("[HF] Max retries exceeded — fail open");
        return messages.map((m) => ({
          messageId: m.id,
          message: m.message,
          PASS_CONV: true,
          reason: "MAX_RETRIES_EXCEEDED",
        }));
      }

      await sleep(delay);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
  }
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