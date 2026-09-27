import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Bell, LayoutGrid, Shuffle, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  autoLayout,
  runTone,
  type BlockCategory,
  type BlockInfo,
  type Definition,
  type Step,
  type StepStatus,
} from "../lib/pipelines";
import { flattenSchema, ObjectFields, type FormContext } from "./BlockForm";
import { Status } from "./ui";

const W = 196;
const H = 72;
const CATEGORY: Record<BlockCategory, { label: string; icon: typeof ArrowDownToLine }> = {
  source: { label: "Get data from", icon: ArrowDownToLine },
  transform: { label: "Change the data", icon: Shuffle },
  destination: { label: "Send data to", icon: ArrowUpFromLine },
  control: { label: "Other", icon: Bell },
};

export interface DesignerIssue {
  step: string | null;
  message: string;
}

const hasOutput = (b: BlockInfo | undefined) => !!b && b.category !== "destination" && b.kind !== "notify";
const acceptsInput = (b: BlockInfo | undefined) => !!b && b.inputs.max > 0;

/** Would connecting from → to create a loop? (to already leads to from) */
function makesLoop(steps: Step[], from: string, to: string): boolean {
  const downstream = new Map<string, string[]>();
  for (const s of steps) for (const n of s.needs) downstream.set(n, [...(downstream.get(n) ?? []), s.id]);
  const stack = [to];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (id === from) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(downstream.get(id) ?? []));
  }
  return false;
}

function uniqueId(steps: Step[], kind: string): string {
  const base = kind.replace(/\./g, "-").replace(/[^a-z0-9_-]/g, "") || "step";
  let id = base;
  for (let i = 2; steps.some((s) => s.id === id); i++) id = `${base}-${i}`;
  return id;
}

function edgePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const x1 = a.x + W;
  const y1 = a.y + H / 2;
  const x2 = b.x;
  const y2 = b.y + H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function PipelineDesigner({
  definition,
  blocks,
  issues,
  stepStatus,
  ctx,
  readOnly,
  onChange,
}: {
  definition: Definition;
  blocks: BlockInfo[];
  issues: DesignerIssue[];
  /** Status of each step in the latest run, shown on the blocks. */
  stepStatus: Record<string, StepStatus>;
  ctx: FormContext;
  readOnly: boolean;
  onChange: (d: Definition) => void;
}) {
  const byKind = useMemo(() => new Map(blocks.map((b) => [b.kind, b])), [blocks]);
  const steps = definition.steps;
  const [selected, setSelected] = useState<string | null>(steps[0]?.id ?? null);
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null);
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const fitted = useRef(false);

  const layout = useMemo(() => autoLayout(steps), [steps]);
  const pos = useCallback((s: Step) => s.position ?? layout[s.id] ?? { x: 40, y: 40 }, [layout]);
  const issuesFor = (id: string) => issues.filter((i) => i.step === id);

  const setSteps = (next: Step[]) => onChange({ ...definition, steps: next });
  const updateStep = (id: string, patch: Partial<Step>) =>
    setSteps(steps.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  /** Pointer position in pipeline coordinates (undoing scroll and zoom). */
  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return {
      x: (e.clientX - r.left + canvas.current!.scrollLeft) / zoom,
      y: (e.clientY - r.top + canvas.current!.scrollTop) / zoom,
    };
  };

  // Moving blocks and drawing connections follow the pointer anywhere on the page.
  useEffect(() => {
    if (!dragging && !linking) return;
    const move = (e: PointerEvent) => {
      const p = point(e);
      if (dragging)
        updateStep(dragging.id, {
          position: { x: Math.max(0, Math.round(p.x - dragging.dx)), y: Math.max(0, Math.round(p.y - dragging.dy)) },
        });
      if (linking) setLinking({ ...linking, x: p.x, y: p.y });
    };
    const up = (e: PointerEvent) => {
      if (linking) {
        const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>(
          "[data-step]",
        )?.dataset.step;
        if (target) connect(linking.from, target);
      }
      setDragging(null);
      setLinking(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  });

  function connect(from: string, to: string) {
    const target = steps.find((s) => s.id === to);
    const spec = target && byKind.get(target.uses);
    if (
      !target ||
      from === to ||
      !acceptsInput(spec) ||
      target.needs.includes(from) ||
      target.needs.length >= spec!.inputs.max ||
      makesLoop(steps, from, to)
    )
      return;
    updateStep(to, { needs: [...target.needs, from] });
  }

  function removeStep(id: string) {
    setSteps(steps.filter((s) => s.id !== id).map((s) => ({ ...s, needs: s.needs.filter((n) => n !== id) })));
    setSelected(null);
  }

  function removeEdge(e: { from: string; to: string }) {
    updateStep(e.to, { needs: steps.find((s) => s.id === e.to)!.needs.filter((n) => n !== e.from) });
    setSelectedEdge(null);
  }

  function addBlock(kind: string) {
    const spec = byKind.get(kind)!;
    const from = selected ? steps.find((s) => s.id === selected) : undefined;
    const link = from && hasOutput(byKind.get(from.uses)) && acceptsInput(spec) ? from : undefined;
    const lowest = steps.reduce((m, s) => Math.max(m, pos(s).y), -120);
    const position = link ? { x: pos(link).x + 250, y: pos(link).y } : { x: 40, y: lowest + 120 };
    const id = uniqueId(steps, kind);
    setSteps([...steps, { id, uses: kind, with: {}, needs: link ? [link.id] : [], position }]);
    setSelected(id);
  }

  function arrange() {
    const fresh = autoLayout(steps);
    setSteps(steps.map((s) => ({ ...s, position: fresh[s.id] })));
  }

  // Delete key removes the selected block or connection (not while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (readOnly || (e.key !== "Delete" && e.key !== "Backspace")) return;
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (selectedEdge) removeEdge(selectedEdge);
      else if (selected) removeStep(selected);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const width = Math.max(900, ...steps.map((s) => pos(s).x + W + 120));
  const height = Math.max(420, ...steps.map((s) => pos(s).y + H + 120));
  const clampZoom = (z: number) => Math.min(1.25, Math.max(0.4, Math.round(z * 20) / 20));
  const fit = () => {
    const c = canvas.current;
    if (c) setZoom(clampZoom(Math.min(1, (c.clientWidth - 16) / width, (Math.max(c.clientHeight, 420) - 16) / height)));
  };
  // Show the whole pipeline when it first opens, if it's wider than the view.
  useEffect(() => {
    if (fitted.current || !canvas.current || !steps.length) return;
    fitted.current = true;
    // …but never smaller than readable; the Fit button can still show everything.
    if (width > canvas.current.clientWidth) setZoom(clampZoom(Math.max(0.7, Math.min(1, (canvas.current.clientWidth - 16) / width))));
  });
  const current = steps.find((s) => s.id === selected);
  const currentSpec = current ? byKind.get(current.uses) : undefined;
  const general = issues.filter((i) => !i.step || !steps.some((s) => s.id === i.step));

  return (
    <div className={`designer ${readOnly ? "read-only" : ""}`}>
      {!readOnly && (
        <aside className="designer-palette" aria-label="Blocks">
          {(Object.keys(CATEGORY) as BlockCategory[]).map((cat) => {
            const Icon = CATEGORY[cat].icon;
            return (
              <section key={cat}>
                <h3>
                  <Icon size={14} /> {CATEGORY[cat].label}
                </h3>
                {blocks
                  .filter((b) => b.category === cat)
                  .map((b) => (
                    <button
                      key={b.kind}
                      className={`palette-block cat-${cat}`}
                      title={b.description}
                      onClick={() => addBlock(b.kind)}
                    >
                      {b.label}
                    </button>
                  ))}
              </section>
            );
          })}
        </aside>
      )}
      <div className="designer-main">
        <div className="designer-toolbar">
          <span className="small muted">
            {readOnly
              ? "View only"
              : "Click a block in the list to add it. Drag from a block's right-hand dot to another block to connect them."}
          </span>
          <span className="spacer" />
          <span className="zoom-controls" role="group" aria-label="Zoom">
            <button
              className="btn ghost small"
              aria-label="Zoom out"
              onClick={() => setZoom((z) => clampZoom(z - 0.1))}
            >
              −
            </button>
            <span className="small num" aria-live="polite">
              {Math.round(zoom * 100)}%
            </span>
            <button className="btn ghost small" aria-label="Zoom in" onClick={() => setZoom((z) => clampZoom(z + 0.1))}>
              +
            </button>
            <button className="btn ghost small" onClick={fit}>
              Fit
            </button>
          </span>
          {!readOnly && (
            <button className="btn small" onClick={arrange}>
              <LayoutGrid size={14} /> Tidy up
            </button>
          )}
        </div>
        {general.length > 0 && (
          <div className="designer-issues" role="alert">
            {general.map((i, n) => (
              <div key={n}>
                <AlertTriangle size={14} /> {i.message}
              </div>
            ))}
          </div>
        )}
        <div
          className="designer-canvas"
          ref={canvas}
          onPointerDown={(e) =>
            !(e.target as HTMLElement).closest(".node, .edge") && (setSelected(null), setSelectedEdge(null))
          }
        >
          <div className="designer-stage" style={{ width: width * zoom, height: height * zoom }}>
            <div className="designer-layer" style={{ width, height, transform: `scale(${zoom})` }}>
              <svg className="designer-edges" width={width} height={height} aria-hidden={false}>
                {steps.flatMap((s) =>
                  s.needs.map((n) => {
                    const from = steps.find((x) => x.id === n);
                    if (!from) return null;
                    const active = selectedEdge?.from === n && selectedEdge.to === s.id;
                    const d = edgePath(pos(from), pos(s));
                    return (
                      <g
                        key={`${n}->${s.id}`}
                        className={`edge ${active ? "active" : ""}`}
                        onPointerDown={(e) => (
                          e.stopPropagation(),
                          setSelectedEdge({ from: n, to: s.id }),
                          setSelected(null)
                        )}
                      >
                        <path d={d} className="edge-hit" />
                        <path d={d} className="edge-line" />
                      </g>
                    );
                  }),
                )}
                {linking &&
                  (() => {
                    const from = steps.find((x) => x.id === linking.from);
                    return from ? (
                      <path
                        className="edge-line linking"
                        d={edgePath(pos(from), { x: linking.x, y: linking.y - H / 2 })}
                      />
                    ) : null;
                  })()}
              </svg>
              <div style={{ width, height, position: "relative" }}>
                {steps.map((s) => {
                  const spec = byKind.get(s.uses);
                  const p = pos(s);
                  const problems = issuesFor(s.id);
                  const status = stepStatus[s.id];
                  return (
                    <div
                      key={s.id}
                      data-step={s.id}
                      className={`node cat-${spec?.category ?? "control"} ${selected === s.id ? "selected" : ""} ${problems.length ? "has-issue" : ""}`}
                      style={{ left: p.x, top: p.y, width: W, height: H }}
                      onPointerDown={(e: ReactPointerEvent) => {
                        e.stopPropagation();
                        setSelected(s.id);
                        setSelectedEdge(null);
                        if (readOnly || (e.target as HTMLElement).closest(".port")) return;
                        const q = point(e);
                        setDragging({ id: s.id, dx: q.x - p.x, dy: q.y - p.y });
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`${s.name ?? s.id}, ${spec?.label ?? s.uses}${problems.length ? `, ${problems.length} problem(s)` : ""}`}
                      onKeyDown={(e) => e.key === "Enter" && setSelected(s.id)}
                    >
                      {acceptsInput(spec) && <span className="port in" data-step={s.id} aria-hidden />}
                      <span className="node-kind">{spec?.label ?? s.uses}</span>
                      <strong className="node-name">{s.name ?? s.id}</strong>
                      <span className="node-foot">
                        {problems.length > 0 && (
                          <span className="node-issue">
                            <AlertTriangle size={12} /> {problems.length}
                          </span>
                        )}
                        {status && (
                          <Status tone={runTone(status).tone} spinning={runTone(status).spinning}>
                            {runTone(status).label}
                          </Status>
                        )}
                      </span>
                      {hasOutput(spec) && !readOnly && (
                        <span
                          className="port out"
                          title="Drag to connect"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            const q = point(e);
                            setLinking({ from: s.id, x: q.x, y: q.y });
                          }}
                        />
                      )}
                      {hasOutput(spec) && readOnly && <span className="port out" aria-hidden />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {steps.length === 0 && (
            <div className="designer-empty">Start by adding a block that gets data — a file, a database or an API.</div>
          )}
        </div>
        {selectedEdge && !readOnly && (
          <div className="edge-actions">
            <span className="small">
              Connection from <strong>{selectedEdge.from}</strong> to <strong>{selectedEdge.to}</strong>
            </span>
            <button className="btn small danger" onClick={() => removeEdge(selectedEdge)}>
              <X size={14} /> Remove connection
            </button>
          </div>
        )}
      </div>
      <aside className="designer-inspector" aria-label="Block settings">
        {!current ? (
          <div className="muted small inspector-empty">Select a block to change its settings.</div>
        ) : (
          <fieldset disabled={readOnly} className="inspector-body">
            <div className="inspector-head">
              <span className={`cat-dot cat-${currentSpec?.category ?? "control"}`} />
              <div>
                <strong>{currentSpec?.label ?? current.uses}</strong>
                <p className="small muted">{currentSpec?.description}</p>
              </div>
            </div>
            {issuesFor(current.id).map((i, n) => (
              <div key={n} className="inspector-issue">
                <AlertTriangle size={14} /> {i.message}
              </div>
            ))}
            <label className="block-field">
              <span className="block-label">Step name</span>
              <input
                className="input"
                value={current.name ?? ""}
                placeholder={current.id}
                maxLength={80}
                onChange={(e) => updateStep(current.id, { name: e.target.value || undefined })}
              />
            </label>
            {current.needs.length > 0 && (
              <div className="block-field">
                <span className="block-label">Reads from</span>
                <div className="chips">
                  {current.needs.map((n) => (
                    <button
                      key={n}
                      className="chip"
                      onClick={() => removeEdge({ from: n, to: current.id })}
                      disabled={readOnly}
                      title="Remove this connection"
                    >
                      {n} {!readOnly && <X size={12} />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {currentSpec && (
              <ObjectFields
                schema={flattenSchema(currentSpec.schema)}
                value={current.with}
                ctx={{
                  ...ctx,
                  connectionKind: current.uses === "mongodb.read" ? "mongodb" : "postgresql",
                  connectionDatabase: (current.with.connection as { database?: string } | undefined)?.database || undefined,
                  // Reading works for both families, so picking the other kind of database swaps the source block.
                  onSwitchEngine:
                    !readOnly && (current.uses === "postgres.read" || current.uses === "mongodb.read")
                      ? (engine, database) => updateStep(current.id, { uses: engine === "mongodb" ? "mongodb.read" : "postgres.read", with: { connection: { database } } })
                      : undefined,
                }}
                onChange={(w) => updateStep(current.id, { with: w })}
              />
            )}
            <label className="block-field check-field">
              <input
                type="checkbox"
                checked={!!current.continueOnError}
                onChange={(e) => updateStep(current.id, { continueOnError: e.target.checked || undefined })}
              />
              <span>Keep going if this step fails</span>
            </label>
            {!readOnly && (
              <button className="btn small danger" onClick={() => removeStep(current.id)}>
                <Trash2 size={14} /> Remove block
              </button>
            )}
          </fieldset>
        )}
      </aside>
    </div>
  );
}
