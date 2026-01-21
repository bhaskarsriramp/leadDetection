import { VertexAI } from "@google-cloud/vertexai";

const vertexAI = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

const model = vertexAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.1,
    maxOutputTokens: 1024,
  },
});

const SYSTEM_PROMPT = `
You analyze individual Instagram DM messages WITH CONTEXT.

Classify the USER message intent as ONE of:
- personal
- lead
- collaboration
- general

Rules:
- Casual curiosity ≠ lead
- Friendly tone ≠ lead
- Be conservative
- Prefer "general" if unsure

Respond ONLY as JSON:
{
  "intent": "personal|lead|collaboration|general",
  "confidence": 0.0
}
`;

export async function analyzeMessageIntent(messages) {
  const results = [];

  for (const msg of messages) {
    const prompt = `
Message:
"${msg.message}"
`;

    const response = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [{ text: SYSTEM_PROMPT + "\n\n" + prompt }],
        },
      ],
    });

    const text = response.response.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);

    results.push({
      messageId: msg.messageId,
      intent: parsed.intent,
      confidence: Number(parsed.confidence.toFixed(3)),
    });
  }

  return results;
}
