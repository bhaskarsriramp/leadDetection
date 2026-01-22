import Message from "../models/Message.js";
import Conversation from "../models/Conversation.js";
import { zeroShotBatchFilter } from "./zeroShot.js";
import { analyzeMessageIntent } from "./geminiMessageIntentAnalyser.js";

// ---------------- CONFIG ----------------
const LEAD_UPGRADE_SCORE = 3.0;
const BUSINESS_UPGRADE_SCORE = 1.8;
const UPGRADE_RATIO = 1.5;

// Decay config
const HALF_LIFE_DAYS = 14;
const MIN_SIGNAL_FLOOR = 0.15;

// ---------------- HELPERS ----------------
function daysBetween(a, b) {
  return Math.abs(a - b) / (1000 * 60 * 60 * 24);
}

function applyDecay(signalValue, daysElapsed) {
  const decayFactor = Math.exp(-daysElapsed / HALF_LIFE_DAYS);
  const decayed = signalValue * decayFactor;
  return Math.max(decayed, MIN_SIGNAL_FLOOR);
}

/**
 * Only analyze user messages that are unanswered by creator
 */
function isUnanswered(msg, allMessages) {
  return !allMessages.some(
    (m) =>
      m.sender === "me" &&
      new Date(m.createdAtPlatform) > new Date(msg.createdAtPlatform)
  );
}

// ---------------- PIPELINE ----------------
export async function processConversationPipeline({
  conversationId,
  messages,
}) {
  // ----------------------------------------
  // STEP 0: ELIGIBLE MESSAGES
  // ----------------------------------------
  const eligibleMessages = messages.filter(
    (m) =>
      m.sender === "them" &&
      m.intent == null &&
      typeof m.text === "string" &&
      m.createdAtPlatform &&
      isUnanswered(m, messages)
  );

  if (eligibleMessages.length === 0) {
    return {
      analyzedMessages: 0,
      messageUpdates: 0,
      conversationUpdated: false,
      reason: "NO_ELIGIBLE_MESSAGES",
    };
  }

  // ----------------------------------------
  // STEP 1: HF FILTER
  // ----------------------------------------
  const hfInput = eligibleMessages.map((m) => ({
    id: m._id,
    message: m.text,
  }));

  const hfResults = await zeroShotBatchFilter(hfInput);

  const hfFiltered = hfResults.filter((r) => !r.PASS_CONV);
  const toGemini = hfResults.filter((r) => r.PASS_CONV);

  // ----------------------------------------
  // STEP 1.1: BATCH UPDATE HF-FILTERED MESSAGES
  // ----------------------------------------
  let messageUpdates = 0;

  if (hfFiltered.length > 0) {
    const hfBulkOps = hfFiltered.map((r) => ({
      updateOne: {
        filter: { _id: r.messageId, intent: null },
        update: {
          $set: {
            intent: "general",
            intentConfidence: r.confidence ?? 0.6,
            intentSource: "hf",
            intentAnalyzedAt: new Date(),
          },
        },
      },
    }));

    const hfBulkRes = await Message.bulkWrite(hfBulkOps, {
      ordered: false,
    });

    messageUpdates += hfBulkRes.modifiedCount || 0;
  }

  if (toGemini.length === 0) {
    return {
      analyzedMessages: 0,
      messageUpdates,
      conversationUpdated: false,
      reason: "HF_FILTERED_ALL",
    };
  }

  // ----------------------------------------
  // STEP 2: GEMINI INTENT
  // ----------------------------------------
  const geminiResults = await analyzeMessageIntent(toGemini);

  // ----------------------------------------
  // STEP 3: BATCH UPDATE GEMINI RESULTS
  // ----------------------------------------
  const delta = { personal: 0, lead: 0, collaboration: 0 };

  const geminiBulkOps = [];

  for (const r of geminiResults) {
    geminiBulkOps.push({
      updateOne: {
        filter: { _id: r.messageId, intent: null },
        update: {
          $set: {
            intent: r.intent,
            intentConfidence: r.confidence,
            intentSource: "hf+gemini",
            intentAnalyzedAt: new Date(),
          },
        },
      },
    });

    if (delta[r.intent] !== undefined) {
      delta[r.intent] += r.confidence;
    }
  }

  if (geminiBulkOps.length > 0) {
    const geminiBulkRes = await Message.bulkWrite(geminiBulkOps, {
      ordered: false,
    });

    messageUpdates += geminiBulkRes.modifiedCount || 0;
  }

  // ----------------------------------------
  // STEP 4: LOAD CONVERSATION
  // ----------------------------------------
  const convo = await Conversation.findById(conversationId);
  if (!convo) throw new Error("Conversation not found");

  convo.intentSignals ||= { personal: 0, lead: 0, collaboration: 0 };

  // ----------------------------------------
  // STEP 4.1: APPLY DECAY
  // ----------------------------------------
  const now = new Date();
  const lastUpdated =
    convo.intentSignalsUpdatedAt || convo.createdAt || now;

  const elapsedDays = daysBetween(now, new Date(lastUpdated));

  convo.intentSignals.personal = applyDecay(
    convo.intentSignals.personal,
    elapsedDays
  );
  convo.intentSignals.lead = applyDecay(
    convo.intentSignals.lead,
    elapsedDays
  );
  convo.intentSignals.collaboration = applyDecay(
    convo.intentSignals.collaboration,
    elapsedDays
  );

  // ----------------------------------------
  // STEP 4.2: ADD NEW SIGNALS
  // ----------------------------------------
  convo.intentSignals.personal += delta.personal;
  convo.intentSignals.lead += delta.lead;
  convo.intentSignals.collaboration += delta.collaboration;
  convo.intentSignalsUpdatedAt = now;

  // ----------------------------------------
  // STEP 5: ONLY-UPGRADE LOGIC
  // ----------------------------------------
  let upgraded = false;
  const current = convo.conversationIntent || "General";
  const { personal, lead, collaboration } = convo.intentSignals;

  if (
    current !== "Lead" &&
    lead >= LEAD_UPGRADE_SCORE &&
    lead > personal * UPGRADE_RATIO
  ) {
    convo.conversationIntent = "Lead";
    convo.conversationIntentConfidence = Math.min(
      1,
      lead / (lead + personal + 1)
    );
    upgraded = true;
  } else if (
    current === "General" &&
    collaboration >= BUSINESS_UPGRADE_SCORE
  ) {
    convo.conversationIntent = "Business";
    convo.conversationIntentConfidence = Math.min(
      1,
      collaboration / (personal + collaboration + 1)
    );
    upgraded = true;
  }

  if (upgraded) {
    convo.conversationIntentUpdatedAt = now;
  }

  await convo.save();

  return {
    analyzedMessages: toGemini.length,
    messageUpdates,
    conversationUpdated: upgraded,
    newConversationIntent: convo.conversationIntent,
    intentSignals: convo.intentSignals,
    decayAppliedDays: elapsedDays.toFixed(2),
  };
}
