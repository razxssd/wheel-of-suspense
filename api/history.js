// Winners history — shared across everyone, stored in Upstash Redis.
//
//   GET    /api/history          -> { history: [{ id, name, when }, ...] }  (oldest first)
//   POST   /api/history          body { id?, name, when }  -> append one winner
//   DELETE /api/history?id=...    -> remove one winner by id
//   DELETE /api/history           -> clear all winners
//
// Stored as a Redis list capped to the most recent MAX entries. Each entry has
// a unique id so a single winner can be deleted even when names/times repeat.
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const KEY = "wheel:history";
const MAX = 50;

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const history = await redis.lrange(KEY, 0, -1); // oldest -> newest
      return res.status(200).json({ history: history || [] });
    }

    if (req.method === "POST") {
      const { id, name, when } = req.body || {};
      const cleanName = typeof name === "string" ? name.trim().slice(0, 80) : "";
      if (!cleanName) return res.status(400).json({ error: "name is required" });
      const entry = {
        id: typeof id === "string" && id ? id : crypto.randomUUID(),
        name: cleanName,
        when: typeof when === "string" ? when.slice(0, 20) : "",
      };
      await redis.rpush(KEY, entry);
      await redis.ltrim(KEY, -MAX, -1); // keep only the most recent MAX
      return res.status(200).json({ ok: true, entry });
    }

    if (req.method === "DELETE") {
      const id = (req.query?.id ?? "").toString().trim();
      if (!id) {
        await redis.del(KEY); // no id -> clear everything
        return res.status(200).json({ ok: true });
      }
      const all = (await redis.lrange(KEY, 0, -1)) || [];
      const remaining = all.filter((h) => h && h.id !== id);
      const tx = redis.multi();
      tx.del(KEY);
      if (remaining.length) tx.rpush(KEY, ...remaining);
      await tx.exec();
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("history handler failed:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
