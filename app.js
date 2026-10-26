/* Glass Todo – frontend logic
   Talks to the Express/Redis API. Nothing is shown as saved until the server confirms it. */
(() => {
  "use strict";

  /* ---------- DOM ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $("#app");
  const form = $("#task-form");
  const input = $("#task-input");
  const prioritySel = $("#task-priority");
  const addBtn = $("#add-btn");
  const search = $("#search-input");
  const list = $("#task-list");
  const tpl = $("#task-template");
  const empty = $("#empty-state");
  const loadingEl = $("#loading-state");
  const filters = $("#filters");
  const clearBtn = $("#clear-done");
  const ring = $("#progress-ring");
  const banner = $("#error-banner");
  const bannerText = $("#error-text");
  const retryBtn = $("#error-retry");
  const closeBtn = $("#error-close");
  const el = {
    total: $("#stat-total"),
    done: $("#stat-done"),
    left: $("#stat-left"),
    pct: $("#progress-text"),
    count: $("#list-count"),
    date: $("#today-date"),
    note: $("#sync-note"),
  };

  /* ---------- config / BOM ---------- */
  const API = app.dataset.api || "/api/tasks";
  const TIMEOUT_MS = 8000;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const timeFmt = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  const dayFmt = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low" };
  const VALID_FILTERS = ["all", "active", "done"];

  /* ---------- state ---------- */
  const state = {
    tasks: [],
    filter: "all",
    query: "",
    status: "loading", // loading | ready | error
    busy: new Set(), // task ids with a request in flight
    adding: false,
    clearing: false,
  };

  /* ---------- API ---------- */
  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(method, url, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new ApiError(
        err.name === "AbortError"
          ? "The server took too long to respond."
          : "Can’t reach the server. Check your connection and try again.",
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) return null;
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body */
    }

    if (!res.ok) {
      const fallback =
        res.status === 503
          ? "The database is unavailable right now. Please try again shortly."
          : `Request failed (${res.status}).`;
      throw new ApiError((data && data.error) || fallback, res.status);
    }
    return data;
  }

  /* ---------- helpers ---------- */
  const matches = (t) => {
    if (state.filter === "active" && t.done) return false;
    if (state.filter === "done" && !t.done) return false;
    const q = state.query.trim().toLowerCase();
    return !q || t.title.toLowerCase().includes(q);
  };

  const metaText = (t) =>
    t.done
      ? "Completed" + (t.doneAt ? " at " + timeFmt.format(t.doneAt) : "")
      : "Added " + timeFmt.format(t.createdAt);

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function animate(node, keyframes, options) {
    if (reduceMotion.matches || !node.animate) return Promise.resolve();
    return node.animate(keyframes, options).finished.catch(() => {});
  }

  function setNote(text) {
    el.note.textContent = text;
  }

  function showError(message, { retry = false } = {}) {
    bannerText.textContent = message;
    retryBtn.hidden = !retry;
    banner.hidden = false;
    setNote("Server unavailable");
  }

  function hideError() {
    banner.hidden = true;
  }

  /* ---------- rendering ---------- */
  function buildItem(t) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = t.id;
    const cb = $(".check", node);
    cb.id = "c-" + t.id;
    $(".box", node).htmlFor = cb.id;
    $('[data-slot="title"]', node).textContent = t.title;
    return node;
  }

  function syncItem(node, t) {
    const busy = state.busy.has(t.id);
    node.dataset.priority = t.priority;
    node.dataset.done = String(t.done);
    node.setAttribute("aria-busy", String(busy));
    const cb = $(".check", node);
    cb.checked = t.done;
    cb.disabled = busy;
    $('[data-action="remove"]', node).disabled = busy;
    $('[data-slot="title"]', node).textContent = t.title;
    $('[data-slot="meta"]', node).textContent = busy ? "Saving…" : metaText(t);
    $('[data-slot="priority"]', node).textContent =
      PRIORITY_LABEL[t.priority] || "Medium";
    if (matches(t)) delete node.dataset.hidden;
    else node.dataset.hidden = "true";
  }

  let firstRender = true;

  function render() {
    const existing = new Map();
    list
      .querySelectorAll(".task")
      .forEach((n) => existing.set(n.dataset.id, n));

    let prev = null;
    state.tasks.forEach((t) => {
      let node = existing.get(t.id);
      const isNew = !node;
      if (isNew) node = buildItem(t);
      syncItem(node, t);

      const expectedNext = prev
        ? prev.nextElementSibling
        : list.firstElementChild;
      if (expectedNext !== node) list.insertBefore(node, expectedNext);
      if (isNew && !firstRender) {
        animate(
          node,
          [
            { opacity: 0, transform: "translateY(-10px) scale(.98)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 380, easing: "cubic-bezier(.22,1,.36,1)" },
        );
      }
      existing.delete(t.id);
      prev = node;
    });

    existing.forEach((n) => {
      if (!n.dataset.leaving) n.remove();
    });
    if (state.status === "ready") firstRender = false;
    updateChrome();
  }

  function updateChrome() {
    const { status } = state;
    const ready = status === "ready";
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.done).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const shown = state.tasks.filter(matches).length;

    el.total.textContent = ready ? total : "–";
    el.done.textContent = ready ? done : "–";
    el.left.textContent = ready ? total - done : "–";
    el.pct.textContent = ready ? pct + "%" : "–";
    ring.style.setProperty("--p", ready ? pct : 0);
    ring.setAttribute("aria-valuenow", ready ? pct : 0);
    el.count.textContent =
      status === "loading"
        ? "Loading…"
        : ready
          ? plural(shown, "task")
          : "Unavailable";

    list.setAttribute("aria-busy", String(status === "loading"));
    loadingEl.hidden = status !== "loading";
    empty.hidden = !(ready && shown === 0);

    addBtn.disabled = !ready || state.adding;
    addBtn.textContent = state.adding ? "Adding…" : "Add task";
    input.readOnly = state.adding;
    clearBtn.disabled = !ready || state.clearing || done === 0;
    clearBtn.textContent = state.clearing ? "Clearing…" : "Clear completed";

    if (ready) setNote("Synced with server");
    else if (status === "loading") setNote("Connecting…");
  }

  /* ---------- actions (server first, then UI) ---------- */
  async function loadTasks({ quiet = false } = {}) {
    if (!quiet) {
      state.status = "loading";
      hideError();
      render();
    }
    try {
      state.tasks = await api("GET", API);
      state.status = "ready";
      hideError();
    } catch (err) {
      if (quiet) {
        setNote("Server unavailable");
        return;
      }
      state.status = "error";
      state.tasks = [];
      showError(err.message, { retry: true });
    }
    render();
  }

  async function addTask(title, priority) {
    state.adding = true;
    updateChrome();
    try {
      const task = await api("POST", API, { title, priority });
      state.tasks.unshift(task);
      input.value = "";
      hideError();
    } catch (err) {
      showError("Couldn’t add the task. " + err.message); // input is kept so nothing is lost
    } finally {
      state.adding = false;
      render();
      input.focus();
    }
  }

  async function toggleTask(id, done) {
    state.busy.add(id);
    render();
    try {
      const updated = await api("PATCH", `${API}/${id}`, { done });
      state.tasks = state.tasks.map((t) => (t.id === id ? updated : t));
      hideError();
    } catch (err) {
      showError("Couldn’t update the task. " + err.message);
      if (err.status === 404)
        state.tasks = state.tasks.filter((t) => t.id !== id);
    } finally {
      state.busy.delete(id);
      render(); // also restores the checkbox if the request failed
    }
  }

  async function removeTask(id) {
    state.busy.add(id);
    render();
    try {
      await api("DELETE", `${API}/${id}`);
      hideError();
      state.busy.delete(id);
      dropTasks([id]);
    } catch (err) {
      state.busy.delete(id);
      if (err.status === 404) dropTasks([id]);
      else {
        showError("Couldn’t delete the task. " + err.message);
        render();
      }
    }
  }

  async function clearCompleted() {
    state.clearing = true;
    updateChrome();
    try {
      await api("DELETE", `${API}?completed=true`);
      hideError();
      dropTasks(state.tasks.filter((t) => t.done).map((t) => t.id));
    } catch (err) {
      showError("Couldn’t clear completed tasks. " + err.message);
    } finally {
      state.clearing = false;
      updateChrome();
    }
  }

  // Remove tasks from state and slide them out of the DOM
  function dropTasks(ids) {
    const set = new Set(ids);
    state.tasks = state.tasks.filter((t) => !set.has(t.id));
    const nodes = ids
      .map((id) => list.querySelector(`.task[data-id="${CSS.escape(id)}"]`))
      .filter(Boolean);
    nodes.forEach((n) => (n.dataset.leaving = "true"));
    updateChrome();
    nodes.forEach((n) =>
      animate(
        n,
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateX(24px) scale(.96)" },
        ],
        { duration: 260, easing: "ease-in" },
      ).then(() => n.remove()),
    );
  }

  /* ---------- filter + hash ---------- */
  function setFilter(value, { updateHash = true } = {}) {
    if (!VALID_FILTERS.includes(value)) value = "all";
    state.filter = value;
    const radio = $(`#filter-${value}`);
    if (radio) radio.checked = true;
    if (updateHash) {
      history.replaceState(
        null,
        "",
        value === "all" ? location.pathname + location.search : "#" + value,
      );
    }
    render();
  }

  const filterFromHash = () => location.hash.replace("#", "");

  /* ---------- events ---------- */
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.status !== "ready" || state.adding) return;
    const title = input.value.trim().replace(/\s+/g, " ");
    if (!title) {
      animate(
        input,
        [
          { transform: "translateX(0)" },
          { transform: "translateX(-6px)" },
          { transform: "translateX(6px)" },
          { transform: "translateX(0)" },
        ],
        { duration: 260 },
      );
      input.focus();
      return;
    }
    addTask(title, prioritySel.value);
  });

  list.addEventListener("change", (e) => {
    if (!e.target.classList.contains("check")) return;
    const node = e.target.closest(".task");
    if (node) toggleTask(node.dataset.id, e.target.checked);
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="remove"]');
    if (!btn || btn.disabled) return;
    const node = btn.closest(".task");
    if (node) removeTask(node.dataset.id);
  });

  clearBtn.addEventListener("click", clearCompleted);
  retryBtn.addEventListener("click", () => loadTasks());
  closeBtn.addEventListener("click", hideError);

  filters.addEventListener("change", (e) => {
    if (e.target.name === "filter") setFilter(e.target.value);
  });

  search.addEventListener("input", () => {
    state.query = search.value;
    render();
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) {
      search.value = "";
      state.query = "";
      render();
    }
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(
      document.activeElement.tagName,
    );
    if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      input.focus();
    }
  });

  window.addEventListener("hashchange", () =>
    setFilter(filterFromHash(), { updateHash: false }),
  );

  // Re-sync with the server and refresh the date when the tab returns
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    renderDate();
    const idle = !state.busy.size && !state.adding && !state.clearing;
    if (state.status === "ready" && idle) loadTasks({ quiet: true });
  });

  /* ---------- date ---------- */
  function renderDate() {
    const now = new Date();
    const iso = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    el.date.textContent = "";
    const time = document.createElement("time");
    time.dateTime = iso;
    time.textContent = dayFmt.format(now);
    el.date.appendChild(time);
  }

  /* ---------- init ---------- */
  renderDate();
  setFilter(filterFromHash(), { updateHash: false });
  loadTasks();
})();
