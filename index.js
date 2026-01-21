// index.js for conversation intelligence
import express from "express";
import mongoose from "mongoose";
import axios from "axios";
import qs from "qs";
import { processConversationPipeline } from "./services/dmConversationPipeline.js";
const app = express();
app.use(express.json({ type: "*/*" }));

// Config
const PORT = 8080;
const db_username = process.env.MONGO_DB_USER;
const db_password = process.env.MONGO_DB_PASS;

var MONGO_URI = 'mongodb+srv://'+db_username+':'+db_password+'@cluster0.itfkrwb.mongodb.net/?appName=Cluster0';

// ---------- Axios setup ----------
const http = axios.create({
  timeout: 15000,
  validateStatus: (s) => s >= 200 && s < 500,
});

http.interceptors.response.use(
  (r) => r,
  (e) => {
    const cfg = e.config || {};
    const urlWithQuery = cfg.url + (cfg.params ? `?${qs.stringify(cfg.params)}` : "");
    const body = e.response?.data || { message: e.message };
    console.error("[HTTP ERROR]", urlWithQuery, JSON.stringify(body, null, 2));
    return Promise.reject(e);
  }
);

// ---------- MongoDB ----------
async function connectMongo() {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 10000,
    });
  }
}

export function validatePayload(body) {
  if (!body) return { valid: false, error: "Empty body" };

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { valid: false, error: "messages[] required" };
  }

  // 🔁 Normalize in-place
  body.messages = body.messages.map((m) => ({
    messageId: m.messageId || m.id,
    text: m.text || m.message,
    timestamp: m.timestamp || Date.now(),
  }));

  for (const msg of body.messages) {
    if (!msg.messageId || !msg.text) {
      return {
        valid: false,
        error: "Each message requires messageId & text",
      };
    }
  }

  return { valid: true };
}




app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).send("ok"));



app.post("/analyze-conversation-context", async (req, res) => {
  const start = Date.now();

  try {
    await connectMongo();

    if (!Array.isArray(req.body)) {
      return res.status(400).json({
        error: "Payload must be an array of conversations",
      });
    }

    const results = [];

    // Sequential to control HF / Gemini load
    for (const item of req.body) {
      if (!item.conversationId || !Array.isArray(item.messages)) {
        continue;
      }

      const r = await processConversationPipeline(item);
      results.push({
        conversationId: item.conversationId,
        ...r,
      });
    }

    return res.json({
      conversationsProcessed: results.length,
      results,
      executionMs: Date.now() - start,
    });
  } catch (err) {
    console.error("❌ Pipeline failed:", err);
    return res.status(500).json({ error: "PIPELINE_FAILED" });
  }
});




app.listen(PORT, () => {
  console.log(`🚀 Lead Detection service running on port ${PORT}`);
});

