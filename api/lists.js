// Saved team lists — shared across everyone, stored in Upstash Redis.
//
//   GET    /api/lists           -> { lists: [{ name, names: [...] }, ...] }
//   POST   /api/lists           body { name, names: [...] }  -> upsert one list
//   DELETE /api/lists?name=...   -> remove one list
//
// Lists live in a single Redis hash keyed by list name, so an upsert or delete
// only touches that one list (no whole-collection clobber on concurrent edits).
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

const KEY = "wheel:lists";
const MAX_NAME = 40;

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const map = await redis.hgetall(KEY); // { name: { name, names } } | null
      const lists = map ? Object.values(map) : [];
      return res.status(200).json({ lists });
    }

    if (req.method === "POST") {
      const { name, names } = req.body || {};
      const clean = typeof name === "string" ? name.trim().slice(0, MAX_NAME) : "";
      if (!clean || !Array.isArray(names)) {
        return res.status(400).json({ error: "name and names[] are required" });
      }
      const safeNames = names
        .filter((n) => typeof n === "string")
        .map((n) => n.trim())
        .filter(Boolean);
      await redis.hset(KEY, { [clean]: { name: clean, names: safeNames } });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const name = (req.query?.name ?? "").toString().trim();
      if (!name) return res.status(400).json({ error: "name is required" });
      await redis.hdel(KEY, name);
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("lists handler failed:", err);
    return res.status(500).json({ error: "storage error" });
  }
}
