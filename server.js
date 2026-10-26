"use strict";

/*
  Glass Todo backend
  Run:  npm install express redis && node server.js
  Env:  PORT (3000), REDIS_URL (redis://localhost:6379), TASKS_KEY (todo:tasks)
*/

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT) || 3000;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const TASKS_KEY = process.env.TASKS_KEY || "todo:tasks"; // one Redis hash: id -> task JSON
const PRIORITIES = ["high", "medium", "low"];
const MAX_TITLE = 120;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------- Redis ---------- */
// disableOfflineQueue makes commands fail fast when Redis is down (no hanging requests)
const redis = createClient({
  url: REDIS_URL,
  disableOfflineQueue: true,
  socket: { reconnectStrategy: (retries) => Math.min(retries * 200, 3000) },
});
redis.on("error", (err) => console.error("[redis]", err.message));
redis.on("ready", () => console.log("[redis] ready"));
redis
  .connect()
  .catch((err) =>
    console.error("[redis] initial connect failed:", err.message),
  );

class StorageError extends Error {}

async function db(fn) {
  if (!redis.isReady) throw new StorageError("Redis is not connected");
  try {
    return await fn(redis);
  } catch (err) {
    console.error("[redis] command failed:", err.message);
    throw new StorageError(err.message);
  }
}

/* ---------- validation ---------- */
function validate(body, { partial }) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { errors: ["Request body must be a JSON object."] };
  }
  const errors = [];
  const value = {};

  if (!partial || "title" in body) {
    if (typeof body.title !== "string") {
      errors.push("title must be a string.");
    } else {
      const title = body.title.trim().replace(/\s+/g, " ");
      if (!title) errors.push("title is required.");
      else if (title.length > MAX_TITLE)
        errors.push(`title must be ${MAX_TITLE} characters or fewer.`);
      else value.title = title;
    }
  }

  if ("priority" in body) {
    if (!PRIORITIES.includes(body.priority))
      errors.push(`priority must be one of: ${PRIORITIES.join(", ")}.`);
    else value.priority = body.priority;
  } else if (!partial) {
    value.priority = "medium";
  }

  if (partial && "done" in body) {
    if (typeof body.done !== "boolean")
      errors.push("done must be true or false.");
    else value.done = body.done;
  }

  return { errors, value };
}

/* ---------- app ---------- */
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const parse = (raw) => JSON.parse(raw);

// Health: used by Kubernetes readiness/liveness probes
app.get("/health", async (req, res) => {
  try {
    await db((r) => r.ping());
    res.status(200).json({ status: "ok", redis: "up" });
  } catch {
    res.status(503).json({ status: "unavailable", redis: "down" });
  }
});

app.param("id", (req, res, next, id) => {
  if (!UUID_RE.test(id))
    return res.status(400).json({ error: "Invalid task id." });
  next();
});

// List tasks, newest first
app.get(
  "/api/tasks",
  wrap(async (req, res) => {
    const raw = await db((r) => r.hVals(TASKS_KEY));
    const tasks = raw.map(parse).sort((a, b) => b.createdAt - a.createdAt);
    res.status(200).json(tasks);
  }),
);

// Create task
app.post(
  "/api/tasks",
  wrap(async (req, res) => {
    const { errors, value } = validate(req.body, { partial: false });
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });

    const task = {
      id: crypto.randomUUID(),
      title: value.title,
      priority: value.priority,
      done: false,
      createdAt: Date.now(),
      doneAt: null,
    };
    await db((r) => r.hSet(TASKS_KEY, task.id, JSON.stringify(task)));
    res.status(201).location(`/api/tasks/${task.id}`).json(task);
  }),
);

// Update task (done, title, priority)
app.patch(
  "/api/tasks/:id",
  wrap(async (req, res) => {
    const { errors, value } = validate(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    if (!Object.keys(value).length)
      return res.status(400).json({ error: "Nothing to update." });

    const raw = await db((r) => r.hGet(TASKS_KEY, req.params.id));
    if (!raw) return res.status(404).json({ error: "Task not found." });

    const task = parse(raw);
    if ("done" in value && value.done !== task.done) {
      task.done = value.done;
      task.doneAt = value.done ? Date.now() : null;
    }
    if (value.title) task.title = value.title;
    if (value.priority) task.priority = value.priority;

    await db((r) => r.hSet(TASKS_KEY, task.id, JSON.stringify(task)));
    res.status(200).json(task);
  }),
);

// Delete all completed tasks
app.delete(
  "/api/tasks",
  wrap(async (req, res) => {
    if (req.query.completed !== "true") {
      return res
        .status(400)
        .json({ error: "Use ?completed=true to clear completed tasks." });
    }
    const raw = await db((r) => r.hVals(TASKS_KEY));
    const ids = raw
      .map(parse)
      .filter((t) => t.done)
      .map((t) => t.id);
    if (ids.length) await db((r) => r.hDel(TASKS_KEY, ids));
    res.status(200).json({ deleted: ids.length });
  }),
);

// Delete one task
app.delete(
  "/api/tasks/:id",
  wrap(async (req, res) => {
    const removed = await db((r) => r.hDel(TASKS_KEY, req.params.id));
    if (!removed) return res.status(404).json({ error: "Task not found." });
    res.status(204).end();
  }),
);

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

/* ---------- frontend (only these two files are served) ---------- */
const sendPublic = (file) => (req, res) => {
  res.set("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, file));
};
app.get("/", sendPublic("index.html"));
app.get("/app.js", sendPublic("app.js"));
app.use((req, res) => res.status(404).type("text").send("Not found"));

/* ---------- errors ---------- */
app.use((err, req, res, next) => {
  if (err instanceof StorageError) {
    return res.status(503).json({
      error: "The database is unavailable. Please try again shortly.",
    });
  }
  if (err.type === "entity.parse.failed")
    return res.status(400).json({ error: "Request body is not valid JSON." });
  if (err.type === "entity.too.large")
    return res.status(413).json({ error: "Request body is too large." });
  console.error("[server]", err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

/* ---------- start + graceful shutdown (Kubernetes sends SIGTERM) ---------- */
const server = app.listen(PORT, () =>
  console.log(`[server] listening on :${PORT}`),
);

function shutdown(signal) {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(async () => {
    try {
      await redis.quit();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
