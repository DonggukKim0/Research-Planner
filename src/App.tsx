import { useEffect, useMemo, useRef, useState } from "react";
import { readTextFile, writeTextFile, exists } from "@tauri-apps/plugin-fs";
import { CircularProgressbar } from "react-circular-progressbar";
import "react-circular-progressbar/dist/styles.css";
import { open } from "@tauri-apps/plugin-dialog";

type TaskMeta = {
  estMin: number | null;
  actMin: number | null;
  reason: string;
};

type TaskMetaDraft = {
  estMin: string;
  actMin: string;
  reason: string;
};

type Task = {
  id: string;         // stable id stored in md as <!-- tid:<id> -->
  lineIndex: number;  // 파일에서 몇 번째 줄인지 (0-based)
  text: string;
  done: boolean;
  hasId: boolean;     // whether it already existed in the file
  estMin: number | null;
  actMin: number | null;
  reason: string;
};

type DayData = {
  date: Date;
  ymd: string;
  filePath: string;
  tasks: Task[];
  missing: boolean;
};

const TASK_ID_HTML_RE = /<!--\s*tid:([a-fA-F0-9]{6,32})\s*-->\s*$/;
const TASK_ID_LEGACY_RE = /\{#t:([a-fA-F0-9]{6,32})\}\s*$/;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}
function toYMD(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function startOfWeekMonday(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = x.getDay(); // Sun=0..Sat=6
  const diff = (day === 0 ? -6 : 1 - day); // Monday 기준
  x.setDate(x.getDate() + diff);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function hashString(s: string) {
  // djb2
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  // unsigned 32-bit
  return (h >>> 0).toString(16);
}

function genTaskId() {
  // 8 hex chars
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractTaskId(text: string) {
  const html = text.match(TASK_ID_HTML_RE);
  if (html) return html[1];
  const legacy = text.match(TASK_ID_LEGACY_RE);
  return legacy ? legacy[1] : null;
}

function hasCanonicalTaskId(text: string) {
  return TASK_ID_HTML_RE.test(text);
}

function stripTaskIdToken(text: string) {
  return text
    .replace(/\s*<!--\s*tid:[a-fA-F0-9]{6,32}\s*-->\s*$/, "")
    .replace(/\s*\{#t:[a-fA-F0-9]{6,32}\}\s*$/, "")
    .trim();
}

function taskIdToken(id: string) {
  return `<!-- tid:${id} -->`;
}

function ensureTaskIdOnLine(line: string, id: string) {
  // Ensure canonical marker is present and old marker is removed.
  return `${stripTaskIdToken(line)} ${taskIdToken(id)}`.trimEnd();
}

function lineHasTaskId(line: string, id: string) {
  return (
    new RegExp(`<!--\\s*tid:${id}\\s*-->`).test(line) ||
    new RegExp(`\\{#t:${id}\\}`).test(line)
  );
}

function parseMeta(text: string): TaskMeta & { cleanedText: string } {
  let cleaned = stripTaskIdToken(text);
  let estMin: number | null = null;
  let actMin: number | null = null;
  let reason = "";

  const estMatch = cleaned.match(/(?:^|\s)⏳est:(\S+)(?=\s|$)/);
  if (estMatch) {
    const value = Number(estMatch[1]);
    if (Number.isInteger(value) && value >= 0) {
      estMin = value;
    }
  }
  cleaned = cleaned.replace(/(?:^|\s)⏳est:\S+(?=\s|$)/g, " ");

  const actMatch = cleaned.match(/(?:^|\s)⌛act:(\S+)(?=\s|$)/);
  if (actMatch) {
    const value = Number(actMatch[1]);
    if (Number.isInteger(value) && value >= 0) {
      actMin = value;
    }
  }
  cleaned = cleaned.replace(/(?:^|\s)⌛act:\S+(?=\s|$)/g, " ");

  const reasonMatch = cleaned.match(/(?:^|\s)(?:✍️|✍)reason:(.*)$/);
  if (reasonMatch) {
    reason = reasonMatch[1].trim();
    cleaned = cleaned.slice(0, reasonMatch.index ?? cleaned.length).trim();
  }

  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return { estMin, actMin, reason, cleanedText: cleaned };
}

function buildTaskLine(checked: boolean, cleanedText: string, meta: TaskMeta, id: string) {
  const parts: string[] = [`- [${checked ? "x" : " "}]`];
  const baseText = parseMeta(cleanedText).cleanedText;
  if (baseText) parts.push(baseText);
  if (meta.estMin !== null) parts.push(`⏳est:${meta.estMin}`);
  if (meta.actMin !== null) parts.push(`⌛act:${meta.actMin}`);
  const reason = meta.reason.trim();
  if (reason) parts.push(`✍️reason:${reason}`);
  parts.push(taskIdToken(id));
  return parts.join(" ");
}

function parseTasks(md: string): Task[] {
  const lines = md.split("\n");
  const tasks: Task[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
    if (!m) continue;

    const done = m[1].toLowerCase() === "x";
    const rest = m[2].trim();

    const existingId = extractTaskId(rest);
    const id = existingId ?? genTaskId();
    const hasId = hasCanonicalTaskId(rest);

    const parsedMeta = parseMeta(rest);
    const displayText = parsedMeta.cleanedText;

    tasks.push({
      id,
      lineIndex: i,
      text: displayText,
      done,
      hasId,
      estMin: parsedMeta.estMin,
      actMin: parsedMeta.actMin,
      reason: parsedMeta.reason,
    });
  }
  return tasks;
}

function weekdayLabel(i: number) {
  const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  return labels[i] ?? "";
}

type DayStats = {
  ymd: string;
  label: string;
  total: number;
  done: number;
  pct: number; // 0-100
  estSum: number; // minutes
  actSum: number; // minutes
  overruns: number; // count of tasks with act > est
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function sumMinutes(values: Array<number | null | undefined>) {
  let s = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) s += v;
  }
  return s;
}

function formatMin(min: number) {
  if (!Number.isFinite(min) || min <= 0) return "0m";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function computeWeekStats(days: DayData[]) {
  const perDay: DayStats[] = days.map((d, i) => {
    const total = d.tasks.length;
    const done = d.tasks.filter(t => t.done).length;
    const pct = total === 0 ? 0 : Math.round((done / total) * 100);

    const estSum = sumMinutes(d.tasks.map(t => t.estMin));
    const actSum = sumMinutes(d.tasks.map(t => t.actMin));
    const overruns = d.tasks.filter(t => t.estMin !== null && t.actMin !== null && t.actMin > t.estMin).length;

    return {
      ymd: d.ymd,
      label: weekdayLabel(i),
      total,
      done,
      pct,
      estSum,
      actSum,
      overruns,
    };
  });

  const totalTasks = perDay.reduce((a, s) => a + s.total, 0);
  const doneTasks = perDay.reduce((a, s) => a + s.done, 0);
  const weekPct = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);
  const estTotal = perDay.reduce((a, s) => a + s.estSum, 0);
  const actTotal = perDay.reduce((a, s) => a + s.actSum, 0);
  const overrunsTotal = perDay.reduce((a, s) => a + s.overruns, 0);

  return { perDay, totalTasks, doneTasks, weekPct, estTotal, actTotal, overrunsTotal };
}

function CompletionBarChart({ data }: { data: DayStats[] }) {
  const w = 680;
  const h = 140;
  const padding = 18;
  const baseY = h - padding;
  const usableH = h - padding * 2;

  const barCount = Math.max(1, data.length);
  const gap = 10;
  const barW = (w - padding * 2 - gap * (barCount - 1)) / barCount;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }}>
      <line x1={padding} y1={baseY} x2={w - padding} y2={baseY} stroke="rgba(0,0,0,0.15)" />
      {data.map((d, i) => {
        const x = padding + i * (barW + gap);
        const bh = Math.round((clamp(d.pct, 0, 100) / 100) * usableH);
        const y = baseY - bh;
        return (
          <g key={d.ymd}>
            <rect x={x} y={y} width={barW} height={bh} rx={8} fill="rgba(0,0,0,0.75)" />
            <text x={x + barW / 2} y={baseY + 14} textAnchor="middle" fontSize="11" fill="rgba(0,0,0,0.65)">
              {d.label}
            </text>
            <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize="11" fill="rgba(0,0,0,0.75)">
              {d.pct}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function EstActBarChart({ data }: { data: DayStats[] }) {
  const w = 680;
  const h = 160;
  const padding = 18;
  const baseY = h - padding;
  const usableH = h - padding * 2;

  const maxVal = Math.max(1, ...data.flatMap(d => [d.estSum, d.actSum]));

  const groupCount = Math.max(1, data.length);
  const groupGap = 14;
  const groupW = (w - padding * 2 - groupGap * (groupCount - 1)) / groupCount;
  const barGap = 8;
  const barW = (groupW - barGap) / 2;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} style={{ display: "block" }}>
      <line x1={padding} y1={baseY} x2={w - padding} y2={baseY} stroke="rgba(0,0,0,0.15)" />

      {/* legend */}
      <g>
        <rect x={padding} y={8} width={12} height={12} rx={3} fill="rgba(0,0,0,0.75)" />
        <text x={padding + 18} y={18} fontSize="11" fill="rgba(0,0,0,0.65)">est</text>
        <rect x={padding + 60} y={8} width={12} height={12} rx={3} fill="rgba(0,0,0,0.35)" />
        <text x={padding + 78} y={18} fontSize="11" fill="rgba(0,0,0,0.65)">act</text>
      </g>

      {data.map((d, i) => {
        const gx = padding + i * (groupW + groupGap);
        const estH = Math.round((clamp(d.estSum, 0, maxVal) / maxVal) * usableH);
        const actH = Math.round((clamp(d.actSum, 0, maxVal) / maxVal) * usableH);
        const estY = baseY - estH;
        const actY = baseY - actH;

        return (
          <g key={d.ymd}>
            <rect x={gx} y={estY} width={barW} height={estH} rx={8} fill="rgba(0,0,0,0.75)" />
            <rect x={gx + barW + barGap} y={actY} width={barW} height={actH} rx={8} fill="rgba(0,0,0,0.35)" />
            <text x={gx + groupW / 2} y={baseY + 14} textAnchor="middle" fontSize="11" fill="rgba(0,0,0,0.65)">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export default function App() {
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [days, setDays] = useState<DayData[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newTaskByDay, setNewTaskByDay] = useState<Record<string, string>>({});
  const [metaDraftByTask, setMetaDraftByTask] = useState<Record<string, TaskMetaDraft>>({});
  const [todoDir, setTodoDir] = useState<string>(() => {
    return localStorage.getItem("todoDir") ?? "";
  });

  const [isEditing, setIsEditing] = useState(false);
  const lastHashesRef = useRef<Record<string, string>>({});
  const editTimerRef = useRef<number | null>(null);

  const weekStart = useMemo(() => startOfWeekMonday(anchor), [anchor]);
  const weekStats = useMemo(() => computeWeekStats(days), [days]);

  async function loadWeek() {
    setBusy(true);
    setError(null);
    if (!todoDir) {
      setDays([]);
      setMetaDraftByTask({});
      setBusy(false);
      return;
    }
    try {
      const list: DayData[] = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        const ymd = toYMD(date);
        const filePath = `${todoDir}/${ymd}.md`;

        const fileExists = await exists(filePath);
        if (!fileExists) {
          list.push({ date, ymd, filePath, tasks: [], missing: true });
          continue;
        }

        const md = await readTextFile(filePath);
        // record hash for change detection
        lastHashesRef.current[ymd] = hashString(md);
        const lines = md.split("\n");
        const tasks = parseTasks(md);

        // One-time migration: use canonical <!-- tid:<id> --> marker.
        let changed = false;
        for (const t of tasks) {
          if (t.hasId) continue;
          const original = lines[t.lineIndex] ?? "";
          // Only modify if it's still a task line
          if (/^\s*-\s*\[( |x|X)\]\s+/.test(original)) {
            lines[t.lineIndex] = ensureTaskIdOnLine(original, t.id);
            changed = true;
          }
        }
        if (changed) {
          const nextMd = lines.join("\n");
          await writeTextFile(filePath, nextMd);
          lastHashesRef.current[ymd] = hashString(nextMd);
        }

        // Re-parse after migration so UI text is consistent
        const tasks2 = changed ? parseTasks(lines.join("\n")) : tasks;
        list.push({ date, ymd, filePath, tasks: tasks2, missing: false });
      }
      setDays(list);
      const nextMetaDrafts: Record<string, TaskMetaDraft> = {};
      for (const day of list) {
        for (const task of day.tasks) {
          nextMetaDrafts[task.id] = {
            estMin: task.estMin === null ? "" : String(task.estMin),
            actMin: task.actMin === null ? "" : String(task.actMin),
            reason: task.reason,
          };
        }
      }
      setMetaDraftByTask(nextMetaDrafts);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function chooseTodoDir() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select your Todolist folder",
      });

    if (typeof selected === "string" && selected.trim().length > 0) {
      const normalized = selected.replace(/\/+$/, "");

      // macOS: allow only folders under /Users/*
      if (!normalized.startsWith("/Users/")) {
        setError(
          `Please choose a folder inside your Home directory.\nSelected: ${selected}\n\nTip: pick something like /Users/<you>/...`
        );
        return; // 저장/세팅 안 함 → 사용자가 다시 Choose Folder 눌러 재선택
      }

      localStorage.setItem("todoDir", normalized);
      setTodoDir(normalized);
    }
    
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }

  useEffect(() => {
    void loadWeek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart.getTime(), todoDir]);

  function markEditingStart() {
    if (editTimerRef.current) {
      window.clearTimeout(editTimerRef.current);
      editTimerRef.current = null;
    }
    setIsEditing(true);
  }

  function markEditingEnd() {
    if (editTimerRef.current) window.clearTimeout(editTimerRef.current);
    // small delay to avoid focus moving between inputs causing flicker
    editTimerRef.current = window.setTimeout(() => {
      setIsEditing(false);
      editTimerRef.current = null;
    }, 250);
  }

  useEffect(() => {
    const interval = window.setInterval(async () => {
      // Don’t interrupt while busy or while the user is typing
      if (busy || isEditing) return;

      try {
        for (const day of days) {
          if (day.missing) continue;
          const md = await readTextFile(day.filePath);
          const h = hashString(md);
          const prev = lastHashesRef.current[day.ymd];
          if (prev && h !== prev) {
            // External edit detected
            await loadWeek();
            return;
          }
        }
      } catch {
        // ignore transient errors
      }
    }, 3000);

    return () => window.clearInterval(interval);
    // days changes when week changes; busy/isEditing gate updates
  }, [days, busy, isEditing]);

  async function createEmptyDayFile(day: DayData) {
    const template = `## Todo\n\n`;
    await writeTextFile(day.filePath, template);
    await loadWeek();
  }

  async function toggleTask(day: DayData, task: Task) {
    try {
      setBusy(true);
      setError(null);

      const md = await readTextFile(day.filePath);
      const lines = md.split("\n");

      const idx = lines.findIndex(l => lineHasTaskId(l, task.id));
      if (idx < 0) {
        setError("Could not find this task in the file (it may have been edited in Obsidian). Reloading...");
        await loadWeek();
        return;
      }

      // Toggle only the checkbox on that line
      const line = lines[idx] ?? "";
      const m = line.match(/^(\s*-\s*\[)( |x|X)(\]\s+.*)$/);
      if (!m) {
        setError("Selected line is not a task anymore. Reloading...");
        await loadWeek();
        return;
      }

      const current = m[2].toLowerCase() === "x";
      const nextMark = current ? " " : "x";
      lines[idx] = `${m[1]}${nextMark}${m[3]}`;

      await writeTextFile(day.filePath, lines.join("\n"));
      await loadWeek();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function setDraft(ymd: string, value: string) {
    setNewTaskByDay(prev => ({ ...prev, [ymd]: value }));
  }

  function getDraft(ymd: string) {
    return newTaskByDay[ymd] ?? "";
  }

  function getTaskMetaDraft(task: Task): TaskMetaDraft {
    return metaDraftByTask[task.id] ?? {
      estMin: task.estMin === null ? "" : String(task.estMin),
      actMin: task.actMin === null ? "" : String(task.actMin),
      reason: task.reason,
    };
  }

  function setTaskMetaDraft(taskId: string, patch: Partial<TaskMetaDraft>) {
    setMetaDraftByTask(prev => {
      const current = prev[taskId] ?? { estMin: "", actMin: "", reason: "" };
      return {
        ...prev,
        [taskId]: {
          ...current,
          ...patch,
        },
      };
    });
  }

  function parseDraftMinutes(raw: string): number | null {
    const value = raw.trim();
    if (value === "") return null;
    if (!/^\d+$/.test(value)) return Number.NaN;
    return Number(value);
  }

  async function addTask(day: DayData) {
    const text = getDraft(day.ymd).trim();
    if (!text) return;

    try {
      setBusy(true);
      setError(null);

      // Ensure the file exists
      const fileExists = await exists(day.filePath);
      if (!fileExists) {
        const template = `## Todo\n\n`;
        await writeTextFile(day.filePath, template);
      }

      const md = await readTextFile(day.filePath);
      const lines = md.split("\n");

      // Prefer inserting right after the first "## Todo" header if present;
      // otherwise append to the end.
      let insertAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().toLowerCase() === "## todo") {
          insertAt = i + 1;
          // Skip any blank lines right after the header
          while (insertAt < lines.length && lines[insertAt].trim() === "") insertAt++;
          break;
        }
      }

      const id = genTaskId();
      const taskLine = `- [ ] ${text} ${taskIdToken(id)}`;
      lines.splice(insertAt, 0, taskLine);

      await writeTextFile(day.filePath, lines.join("\n"));

      // Clear draft
      setDraft(day.ymd, "");

      await loadWeek();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function saveTaskMeta(day: DayData, task: Task) {
    const draft = getTaskMetaDraft(task);
    const estMin = parseDraftMinutes(draft.estMin);
    const actMin = parseDraftMinutes(draft.actMin);
    const reason = draft.reason.trim();

    if (Number.isNaN(estMin)) {
      setError("est must be a non-negative integer.");
      return;
    }
    if (Number.isNaN(actMin)) {
      setError("act must be a non-negative integer.");
      return;
    }
    if (estMin !== null && actMin !== null && actMin > estMin && reason === "") {
      setError("reason is required when act is greater than est.");
      return;
    }

    try {
      setBusy(true);
      setError(null);

      const md = await readTextFile(day.filePath);
      const lines = md.split("\n");

      const idx = lines.findIndex(l => lineHasTaskId(l, task.id));
      if (idx < 0) {
        setError("Could not find this task in the file (it may have been edited in Obsidian). Reloading...");
        await loadWeek();
        return;
      }

      const line = lines[idx] ?? "";
      const m = line.match(/^\s*-\s*\[( |x|X)\]\s+(.*)$/);
      if (!m) {
        setError("Selected line is not a task anymore. Reloading...");
        await loadWeek();
        return;
      }

      const checked = m[1].toLowerCase() === "x";
      const parsed = parseMeta(m[2].trim());
      lines[idx] = buildTaskLine(
        checked,
        parsed.cleanedText,
        {
          estMin,
          actMin,
          reason,
        },
        task.id
      );

      await writeTextFile(day.filePath, lines.join("\n"));
      await loadWeek();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(day: DayData, task: Task) {
    try {
      setBusy(true);
      setError(null);

      const md = await readTextFile(day.filePath);
      const lines = md.split("\n");

      const idx = lines.findIndex(l => lineHasTaskId(l, task.id));
      if (idx < 0) {
        setError("Could not find this task in the file (it may have been edited in Obsidian). Reloading...");
        await loadWeek();
        return;
      }

      lines.splice(idx, 1);
      await writeTextFile(day.filePath, lines.join("\n"));

      // Remove drafts for this task id so state stays clean
      setMetaDraftByTask(prev => {
        const next = { ...prev };
        delete next[task.id];
        return next;
      });

      await loadWeek();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const containerStyle: React.CSSProperties = {
    minHeight: "100vh",
    padding: 16,
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  };
  const headerStyle: React.CSSProperties = {
    display: "flex",
    gap: 8,
    alignItems: "center",
    marginBottom: 12,
  };
  const btnStyle: React.CSSProperties = {
    borderRadius: 12,
    padding: "8px 12px",
    border: "1px solid rgba(0,0,0,0.15)",
    background: "white",
    cursor: "pointer",
  };
  const gridStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
    gap: 12,
    alignItems: "start",
  };
  const cardStyle: React.CSSProperties = {
    borderRadius: 16,
    padding: 12,
    border: "1px solid rgba(0,0,0,0.12)",
    background: "white",
    minWidth: 0,
    overflow: "hidden",
  };
  const smallInputStyle: React.CSSProperties = {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    borderRadius: 10,
    padding: "6px 8px",
    border: "1px solid rgba(0,0,0,0.15)",
    fontSize: 12,
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <button onClick={() => setAnchor(addDays(anchor, -7))} style={btnStyle} disabled={busy}>
          ← Prev week
        </button>
        <button onClick={() => setAnchor(new Date())} style={btnStyle} disabled={busy}>
          This week
        </button>
        <button onClick={() => setAnchor(addDays(anchor, 7))} style={btnStyle} disabled={busy}>
          Next week →
        </button>

        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            Week of {toYMD(weekStart)}
            {busy ? "  • working..." : ""}
          </div>
          <button onClick={() => void chooseTodoDir()} style={{ ...btnStyle, padding: "6px 10px", fontSize: 12 }} disabled={busy}>
            Change folder…
          </button>
        </div>
      </div>

      {!todoDir && (
        <div style={{ ...cardStyle, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 8 }}>Select Todolist Folder</div>
          <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 10 }}>
            Choose the folder that contains your daily files named <b>YYYY-MM-DD.md</b>.
          </div>
          <button onClick={() => void chooseTodoDir()} style={btnStyle} disabled={busy}>
            Choose Folder…
          </button>
        </div>
      )}

      {error && (
        <div style={{ ...cardStyle, marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Error</div>
          <div style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{error}</div>
        </div>
      )}

      {todoDir && (
        <div style={{ ...cardStyle, marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ width: 110, height: 110 }}>
              <CircularProgressbar value={weekStats.weekPct} text={`${weekStats.weekPct}%`} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 220 }}>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Weekly Summary</div>
              <div style={{ fontSize: 12, opacity: 0.75 }}>
                {toYMD(weekStart)} ~ {toYMD(addDays(weekStart, 6))}
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
                <div><b>{weekStats.doneTasks}</b> / {weekStats.totalTasks} done</div>
                <div><b>{formatMin(weekStats.estTotal)}</b> est</div>
                <div><b>{formatMin(weekStats.actTotal)}</b> act</div>
                <div><b>{weekStats.overrunsTotal}</b> overruns</div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 12 }}>
            <div style={{ ...cardStyle, margin: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Completion % (Mon–Sun)</div>
              <CompletionBarChart data={weekStats.perDay} />
            </div>
            <div style={{ ...cardStyle, margin: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Planned vs Actual minutes</div>
              <EstActBarChart data={weekStats.perDay} />
            </div>
          </div>
        </div>
      )}

      {todoDir && (
        <div style={gridStyle}>
          {days.map((d, i) => {
            const total = d.tasks.length;
            const done = d.tasks.filter(t => t.done).length;
            const pct = total === 0 ? 0 : Math.round((done / total) * 100);

            return (
              <div key={d.ymd} style={cardStyle}>
                <div
                  style={{
                    marginBottom: 12,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                  }}
                >
                  <div style={{ width: 96, height: 96 }}>
                    <CircularProgressbar value={pct} text={`${pct}%`} />
                  </div>

                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>{weekdayLabel(i)}</div>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{d.ymd}</div>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>
                      {done}/{total}
                    </div>
                  </div>
                </div>

                {d.missing ? (
                  <div style={{ fontSize: 12 }}>
                    <div style={{ opacity: 0.7, marginBottom: 8 }}>File not found</div>
                    <button onClick={() => void createEmptyDayFile(d)} style={btnStyle}>
                      Create {d.ymd}.md
                    </button>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {d.tasks.length === 0 ? (
                      <div style={{ fontSize: 12, opacity: 0.7 }}>No tasks</div>
                    ) : (
                      d.tasks.map((t) => {
                        const draft = getTaskMetaDraft(t);
                        const estDraft = parseDraftMinutes(draft.estMin);
                        const actDraft = parseDraftMinutes(draft.actMin);
                        const showReason =
                          draft.reason.trim() !== "" ||
                          (estDraft !== null &&
                            actDraft !== null &&
                            !Number.isNaN(estDraft) &&
                            !Number.isNaN(actDraft) &&
                            actDraft > estDraft);

                        return (
                          <div key={t.id} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                              <button
                                onClick={() => void toggleTask(d, t)}
                                disabled={busy}
                                style={{
                                  display: "flex",
                                  gap: 8,
                                  alignItems: "flex-start",
                                  textAlign: "left",
                                  border: "none",
                                  background: "transparent",
                                  padding: 0,
                                  cursor: "pointer",
                                  opacity: t.done ? 0.65 : 1,
                                  flex: 1,
                                  minWidth: 0,
                                }}
                                title="Click to toggle"
                              >
                                <span>{t.done ? "✅" : "⬜️"}</span>
                                <span
                                  style={{
                                    textDecoration: t.done ? "line-through" : "none",
                                    fontSize: 13,
                                    overflowWrap: "anywhere",
                                  }}
                                >
                                  {t.text}
                                </span>
                              </button>

                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void deleteTask(d, t);
                                }}
                                disabled={busy}
                                style={{
                                  borderRadius: 10,
                                  padding: "4px 8px",
                                  border: "1px solid rgba(0,0,0,0.12)",
                                  background: "white",
                                  cursor: "pointer",
                                  lineHeight: 1,
                                  flexShrink: 0,
                                }}
                                title="Delete task"
                              >
                                🗑
                              </button>
                            </div>

                            <div
                              style={{
                                display: "grid",
                                gap: 6,
                                width: "100%",
                                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto",
                                alignItems: "center",
                              }}
                            >
                              <input
                                type="number"
                                min={0}
                                step={1}
                                inputMode="numeric"
                                placeholder="est (min)"
                                value={draft.estMin}
                                onChange={(e) => setTaskMetaDraft(t.id, { estMin: e.target.value })}
                                disabled={busy}
                                style={smallInputStyle}
                                onFocus={markEditingStart}
                                onBlur={markEditingEnd}
                              />
                              <input
                                type="number"
                                min={0}
                                step={1}
                                inputMode="numeric"
                                placeholder="act (min)"
                                value={draft.actMin}
                                onChange={(e) => setTaskMetaDraft(t.id, { actMin: e.target.value })}
                                disabled={busy}
                                style={smallInputStyle}
                                onFocus={markEditingStart}
                                onBlur={markEditingEnd}
                              />
                              <button
                                onClick={() => void saveTaskMeta(d, t)}
                                disabled={busy}
                                style={{
                                  ...btnStyle,
                                  borderRadius: 10,
                                  padding: "6px 10px",
                                  fontSize: 12,
                                  whiteSpace: "nowrap",
                                  flexShrink: 0,
                                }}
                              >
                                Save
                              </button>
                            </div>

                            {showReason && (
                              <input
                                type="text"
                                placeholder="reason (required if act > est)"
                                value={draft.reason}
                                onChange={(e) => setTaskMetaDraft(t.id, { reason: e.target.value })}
                                disabled={busy}
                                style={smallInputStyle}
                                onFocus={markEditingStart}
                                onBlur={markEditingEnd}
                              />
                            )}
                          </div>
                        );
                      })
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 8, width: "100%" }}>
                      <input
                        value={getDraft(d.ymd)}
                        onChange={(e) => setDraft(d.ymd, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void addTask(d);
                        }}
                        placeholder="Add a task..."
                        disabled={busy}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          boxSizing: "border-box",
                          borderRadius: 12,
                          padding: "8px 10px",
                          border: "1px solid rgba(0,0,0,0.15)",
                          fontSize: 13,
                        }}
                        onFocus={markEditingStart}
                        onBlur={markEditingEnd}
                      />
                      <button
                        onClick={() => void addTask(d)}
                        disabled={busy}
                        style={{ ...btnStyle, whiteSpace: "nowrap", flexShrink: 0 }}
                      >
                        Add
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
