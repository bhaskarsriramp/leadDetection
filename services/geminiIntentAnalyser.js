import { VertexAI } from '@google-cloud/vertexai';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
const LOCATION = 'us-central1'; // or 'asia-south1' for Mumbai region
const MODEL_NAME = 'gemini-2.5-flash';
const INTENT_THRESHOLD = 0.65;

const vertexAI = new VertexAI({
  project: PROJECT_ID,
  location: LOCATION,
});

const generativeModel = vertexAI.getGenerativeModel({
  model: MODEL_NAME,
  generationConfig: {
    temperature: 0.1, // Low temperature for consistent classification
    topP: 0.95,
    topK: 20,
    maxOutputTokens: 2048,
  },
});

/**
 * System prompt for fitness lead intent analysis
 */
const SYSTEM_INSTRUCTION = `You are an expert lead qualification analyst for fitness coaches and personal trainers.

Your task is to analyze Instagram DM messages and determine if they indicate GENUINE LEAD INTENT - meaning the sender is likely interested in:
- Personal training services
- Fitness coaching
- Workout programs
- Nutrition guidance
- Body transformation services
- Fitness consultations
- Gym/training sessions

GENUINE LEAD INTENT indicators:
- Asking about services, pricing, availability
- Inquiring about programs, training methods
- Expressing fitness goals or problems
- Requesting consultations or trials
- Asking about transformations, results
- Showing interest in before/after, testimonials
- Questions about training approach, specialty

NOT LEAD INTENT:
- Generic compliments without service inquiry
- Just appreciation/thanks
- Social chit-chat
- Only asking about personal life
- Emoji-only reactions
- Generic questions not related to fitness services
- Networking without service interest

Respond ONLY with a valid JSON object in this exact format:
{
  "lead_intent": 0.85,
  "reasoning": "Brief explanation"
}

The lead_intent score should be 0.0 to 1.0 where:
- 0.8-1.0: Strong lead intent (clear service inquiry)
- 0.6-0.79: Moderate lead intent (indirect interest)
- 0.4-0.59: Weak lead intent (vague or unclear)
- 0.0-0.39: No lead intent (social/generic)`;

/**
 * Analyze a single batch of messages with Gemini
 * @param {Array<{messageId: string, message: string}>} messages
 * @returns {Promise<Array<{messageId: string, lead_intent: number, reasoning: string}>>}
 */
async function analyzeMessagesBatch(messages) {
  if (!messages || messages.length === 0) {
    return [];
  }

  // Create a structured prompt for batch analysis
  const batchPrompt = `Analyze the following ${messages.length} Instagram DM messages for lead intent.

Messages to analyze:
${messages.map((m, idx) => `[${idx + 1}] ID: ${m.messageId}\nMessage: "${m.message}"\n`).join('\n')}

Respond with a JSON array containing one object per message in the SAME ORDER, with this structure:
[
  {
    "messageId": "id_from_above",
    "lead_intent": 0.0-1.0,
    "reasoning": "brief explanation"
  }
]

Remember: Only return the JSON array, no other text.`;

  try {
    const result = await generativeModel.generateContent({
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: SYSTEM_INSTRUCTION + '\n\n' + batchPrompt,
            },
          ],
        },
      ],
    });

    const response = result.response;
    const text = response.candidates[0].content.parts[0].text;

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No valid JSON array found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate response
    if (!Array.isArray(parsed) || parsed.length !== messages.length) {
      throw new Error(
        `Expected ${messages.length} results, got ${parsed?.length || 0}`
      );
    }

    return parsed.map((item) => ({
      messageId: item.messageId,
      lead_intent: Number(item.lead_intent.toFixed(3)),
      reasoning: item.reasoning || '',
    }));
  } catch (error) {
    console.error('[Gemini] Batch analysis failed:', error);
    throw error;
  }
}

/**
 * Process messages in optimized batches
 * Gemini 1.5 Flash can handle larger context, but we batch for reliability
 */
const OPTIMAL_BATCH_SIZE = 10; // Process 10 messages per API call

async function splitIntoBatches(items, batchSize) {
  const batches = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

/**
 * Main function: Analyze lead intent for filtered messages
 * @param {Array<{messageId: string, message: string, meaningfulScore?: number}>} filteredMessages
 * @returns {Promise<Array<{messageId: string, message: string, lead_intent: number, reasoning: string, qualified: boolean}>>}
 */
export async function analyzeLeadIntent(filteredMessages) {
  if (!Array.isArray(filteredMessages) || filteredMessages.length === 0) {
    console.log('[Gemini] No messages to analyze');
    return [];
  }

  console.log(`[Gemini] Starting analysis for ${filteredMessages.length} messages`);

  try {
    // Split into batches
    const batches = await splitIntoBatches(filteredMessages, OPTIMAL_BATCH_SIZE);
    console.log(`[Gemini] Processing ${batches.length} batches (${OPTIMAL_BATCH_SIZE} messages each)`);

    const allResults = [];

    // Process batches sequentially to avoid rate limits
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`[Gemini] Processing batch ${i + 1}/${batches.length}`);

      try {
        const batchResults = await analyzeMessagesBatch(batch);

        // Merge with original data
        const enrichedResults = batchResults.map((result) => {
          const original = batch.find((m) => m.messageId === result.messageId);
          return {
            messageId: result.messageId,
            message: original?.message || '',
            lead_intent: result.lead_intent,
            reasoning: result.reasoning,
            qualified: result.lead_intent >= INTENT_THRESHOLD,
            meaningfulScore: original?.meaningfulScore,
          };
        });

        allResults.push(...enrichedResults);

        // Small delay between batches to be respectful to API
        if (i < batches.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.error(`[Gemini] Batch ${i + 1} failed:`, error);

        // Mark this batch as failed with low confidence
        const failedResults = batch.map((m) => ({
          messageId: m.messageId,
          message: m.message,
          lead_intent: 0.0,
          reasoning: 'Analysis failed',
          qualified: false,
          error: true,
        }));

        allResults.push(...failedResults);
      }
    }

    // Generate summary stats
    const qualified = allResults.filter((r) => r.qualified).length;
    const avgIntent =
      allResults.reduce((sum, r) => sum + r.lead_intent, 0) / allResults.length;

    console.log(`[Gemini] Analysis complete:`);
    console.log(`  - Total analyzed: ${allResults.length}`);
    console.log(`  - Qualified leads: ${qualified} (${((qualified / allResults.length) * 100).toFixed(1)}%)`);
    console.log(`  - Average intent: ${avgIntent.toFixed(3)}`);

    return allResults;
  } catch (error) {
    console.error('[Gemini] Fatal error during analysis:', error);
    throw error;
  }
}

/**
 * Get detailed statistics from analysis results
 */
export function getIntentStats(results) {
  const total = results.length;
  const qualified = results.filter((r) => r.qualified).length;
  const failed = results.filter((r) => r.error).length;

  const intentBuckets = {
    'strong (0.8-1.0)': results.filter((r) => r.lead_intent >= 0.8).length,
    'moderate (0.6-0.79)': results.filter(
      (r) => r.lead_intent >= 0.6 && r.lead_intent < 0.8
    ).length,
    'weak (0.4-0.59)': results.filter(
      (r) => r.lead_intent >= 0.4 && r.lead_intent < 0.6
    ).length,
    'none (0.0-0.39)': results.filter((r) => r.lead_intent < 0.4).length,
  };

  const avgIntent =
    total > 0
      ? (results.reduce((sum, r) => sum + r.lead_intent, 0) / total).toFixed(3)
      : 0;

  return {
    total,
    qualified,
    qualificationRate: ((qualified / total) * 100).toFixed(1) + '%',
    failed,
    avgIntent: Number(avgIntent),
    intentDistribution: intentBuckets,
  };
}

/**
 * Filter and return only qualified leads
 */
export function getQualifiedLeads(results) {
  return results
    .filter((r) => r.qualified && !r.error)
    .sort((a, b) => b.lead_intent - a.lead_intent); // Sort by intent score descending
}