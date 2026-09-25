import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { BLOCKS, describeTemplates, INTENTS, instantiateTemplate, parsePipelineText, PipelineInvalidError, toDocument, toYaml, validatePipeline, type PipelineRecord } from "@nexus/pipelines";
import { authorize } from "@nexus/security";
import { NexusError } from "@nexus/shared";
import type { RouteModule } from "../server";
import { requirePermission } from "../auth";
import type { PipelineProposalService } from "../../services/pipeline-proposals";
import type { PipelineService } from "../../services/pipelines";

const runBody = z
  .object({
    params: z.record(z.string(), z.unknown()).optional(),
    /** Test run: sources read at most this many rows and destinations don't write for real. */
    testRows: z.number().int().min(1).max(1_000_000).optional(),
    /** Wait for the run to finish (up to the given seconds) before answering. */
    waitSeconds: z.number().int().min(1).max(300).optional(),
  })
  .strict();

/** A pipeline definition sent as JSON (designer) or as the text of a pipeline file (YAML/JSON). */
const definitionBody = z.union([z.object({ definition: z.record(z.string(), z.unknown()), note: z.string().max(500).optional() }), z.object({ file: z.string().min(1).max(1_000_000), note: z.string().max(500).optional() })]);

function readDefinition(body: z.infer<typeof definitionBody>): unknown {
  return "file" in body ? parsePipelineText(body.file) : body.definition;
}

/** Validation problems go back as a list the designer can pin to each step. */
function invalid(reply: FastifyReply, e: PipelineInvalidError) {
  return reply.code(400).send({ error: { code: "invalid_input", message: e.message, issues: e.issues, problem: null } });
}

function summary(s: PipelineService, p: PipelineRecord) {
  const last = s.engine.runs.list(p.id, 1)[0] ?? null;
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.definition.description ?? null,
    enabled: p.enabled,
    version: p.version,
    schedule: p.definition.schedule,
    steps: p.definition.steps.length,
    running: s.engine.isRunning(p.id),
    lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt, durationMs: last.durationMs, error: last.error } : null,
    updatedAt: p.updatedAt,
  };
}

/** Who may start runs: people with "pipelines.run", or applications holding a pipelines:run credential. */
function runCaller(req: FastifyRequest): { trigger: "manual" | "api"; by: string } {
  const p = req.principal;
  if (p?.kind === "app") {
    if (!p.app.scopes.includes("pipelines:run")) throw NexusError.forbidden("This credential isn't allowed to start pipelines.");
    return { trigger: "api", by: `app:${p.app.appId}` };
  }
  const user = requirePermission(req, "pipelines.run");
  return { trigger: "manual", by: user.id };
}

const proposalBody = z
  .object({
    definition: z.record(z.string(), z.unknown()),
    scripts: z.array(z.object({ stepId: z.string().min(1), language: z.enum(["python", "r"]), fileName: z.string().regex(/^[a-z][a-z0-9_]{0,47}.(py|R)$/), code: z.string().max(50_000) }).strict()).max(16).default([]),
  })
  .strict();

export function pipelineRoutes(s: PipelineService, proposals?: PipelineProposalService): RouteModule {
  return (app, ctx) => {
    const need = () => {
      if (!s.available) throw NexusError.conflict("Pipelines are available once setup is complete.");
      return s;
    };
    const audit = (by: { id: string; displayName: string }, action: string, id: string, details?: Record<string, unknown>) =>
      ctx.audit.record({ actor: { type: "user", id: by.id, name: by.displayName }, action, target: { type: "pipeline", id }, ...(details ? { details } : {}) });

    // -------------------------------------------------------------- catalogue & validation

    /** The blocks the designer can offer, with a JSON Schema for each block's settings form. */
    app.get("/api/v1/pipelines/blocks", async (req) => {
      requirePermission(req, "pipelines.view");
      return BLOCKS.map((b) => ({ kind: b.kind, category: b.category, label: b.label, description: b.description, inputs: b.inputs, schema: z.toJSONSchema(b.config, { io: "input", unrepresentable: "any" }) }));
    });

    app.post("/api/v1/pipelines/validate", async (req) => {
      requirePermission(req, "pipelines.view");
      const body = definitionBody.parse(req.body);
      let raw: unknown;
      try {
        raw = readDefinition(body);
      } catch (e) {
        return { ok: false, issues: e instanceof PipelineInvalidError ? e.issues : [{ path: "", message: (e as Error).message }] };
      }
      const r = validatePipeline(raw);
      return r.ok ? { ok: true, order: r.pipeline.order, issues: [] } : { ok: false, issues: r.issues };
    });

    // -------------------------------------------------------------- templates

    app.get("/api/v1/pipelines/templates", async (req) => {
      requirePermission(req, "pipelines.view");
      return { intents: INTENTS, templates: describeTemplates() };
    });

    /** Answers to a template's questions → a new pipeline (switched off until it has been tested). */
    app.post("/api/v1/pipelines/from-template", async (req, reply) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const body = z.object({ template: z.string().min(1), answers: z.record(z.string(), z.string()) }).parse(req.body);
      try {
        const p = svc.store.create(toDocument(instantiateTemplate(body.template, body.answers)), user.id);
        audit(user, "pipeline.create", p.id, { template: body.template });
        return { ...summary(svc, p), definition: p.definition };
      } catch (e) {
        if (e instanceof PipelineInvalidError) return invalid(reply, e);
        throw e;
      }
    });

    // -------------------------------------------------------------- described in plain English

    /** A sentence → a proposed pipeline to review. Nothing is saved. */
    app.post("/api/v1/pipelines/propose", async (req) => {
      requirePermission(req, "pipelines.edit");
      need();
      if (!proposals) throw NexusError.conflict("Describing pipelines isn't available.");
      const body = z.object({ request: z.string().max(4000) }).parse(req.body);
      return proposals.propose(body.request);
    });

    /** The reviewed proposal → a new pipeline, switched off, with its scripts saved next to the other pipeline files. */
    app.post("/api/v1/pipelines/from-proposal", async (req, reply) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      if (!proposals) throw NexusError.conflict("Describing pipelines isn't available.");
      const body = proposalBody.parse(req.body);
      try {
        const { pipeline: p, scripts } = proposals.create(body, user.id);
        audit(user, "pipeline.create", p.id, { from: "ai-proposal", scripts: scripts.length });
        return { ...summary(svc, p), definition: p.definition, scripts };
      } catch (e) {
        if (e instanceof PipelineInvalidError) return invalid(reply, e);
        throw e;
      }
    });

    // -------------------------------------------------------------- pipelines

    app.get("/api/v1/pipelines", async (req) => {
      requirePermission(req, "pipelines.view");
      const svc = need();
      return svc.store.list().map((p) => summary(svc, p));
    });

    app.post("/api/v1/pipelines", async (req, reply) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      try {
        const body = definitionBody.parse(req.body);
        const p = svc.store.create(readDefinition(body), user.id);
        audit(user, "pipeline.create", p.id);
        return { ...summary(svc, p), definition: p.definition };
      } catch (e) {
        if (e instanceof PipelineInvalidError) return invalid(reply, e);
        throw e;
      }
    });

    app.get("/api/v1/pipelines/:id", async (req) => {
      requirePermission(req, "pipelines.view");
      const svc = need();
      const p = svc.store.require((req.params as { id: string }).id);
      return { ...summary(svc, p), definition: p.definition, dependencies: svc.scheduler?.dependencyStatus(p.id) ?? null, webhook: svc.webhookInfo(p.id) };
    });

    app.put("/api/v1/pipelines/:id", async (req, reply) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const id = (req.params as { id: string }).id;
      try {
        const body = definitionBody.parse(req.body);
        const { pipeline, changed } = svc.store.update(id, readDefinition(body), user.id, body.note ?? null);
        if (changed) audit(user, "pipeline.update", pipeline.id, { version: pipeline.version });
        return { ...summary(svc, pipeline), definition: pipeline.definition, changed };
      } catch (e) {
        if (e instanceof PipelineInvalidError) return invalid(reply, e);
        throw e;
      }
    });

    /** Switching a pipeline on activates its schedule and lets applications and webhooks start it. */
    app.post("/api/v1/pipelines/:id/enabled", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      const p = svc.store.setEnabled((req.params as { id: string }).id, enabled);
      audit(user, enabled ? "pipeline.enable" : "pipeline.disable", p.id);
      return summary(svc, p);
    });

    app.delete("/api/v1/pipelines/:id", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const p = svc.store.require((req.params as { id: string }).id);
      const { confirmation } = z.object({ confirmation: z.string() }).parse(req.body);
      if (confirmation !== p.name) throw NexusError.invalid(`Type "${p.name}" to confirm deleting this pipeline.`);
      if (svc.engine.isRunning(p.id)) throw NexusError.conflict("This pipeline is running. Stop the run first.");
      svc.revokeWebhook(p.id);
      svc.store.remove(p.id);
      audit(user, "pipeline.delete", p.id);
      return { ok: true };
    });

    app.get("/api/v1/pipelines/:id/export.yaml", async (req, reply) => {
      requirePermission(req, "pipelines.view");
      const p = need().store.require((req.params as { id: string }).id);
      reply.header("Content-Type", "application/yaml; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${p.slug}.nexus-pipeline.yaml"`);
      return toYaml(p.definition);
    });

    // -------------------------------------------------------------- versions

    app.get("/api/v1/pipelines/:id/versions", async (req) => {
      requirePermission(req, "pipelines.view");
      return need()
        .store.versions((req.params as { id: string }).id)
        .map((v) => ({ version: v.version, author: v.author, note: v.note, createdAt: v.createdAt }));
    });

    app.get("/api/v1/pipelines/:id/diff", async (req) => {
      requirePermission(req, "pipelines.view");
      const q = z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1).optional() }).parse(req.query);
      return need().store.diff((req.params as { id: string }).id, q.from, q.to);
    });

    app.post("/api/v1/pipelines/:id/rollback", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const { version } = z.object({ version: z.number().int().min(1) }).parse(req.body);
      const p = svc.store.rollback((req.params as { id: string }).id, version, user.id);
      audit(user, "pipeline.rollback", p.id, { to: version, version: p.version });
      return { ...summary(svc, p), definition: p.definition };
    });

    // -------------------------------------------------------------- runs

    app.post("/api/v1/pipelines/:id/run", async (req) => {
      const caller = runCaller(req);
      const svc = need();
      const body = runBody.parse(req.body ?? {});
      if (caller.trigger === "api" && body.testRows) throw NexusError.invalid("Applications start real runs; test runs are started from the control center.");
      const { runId, pipeline } = svc.run((req.params as { id: string }).id, { params: body.params, testRows: body.testRows ?? null, trigger: caller.trigger, requestedBy: caller.by });
      ctx.audit.record({ actor: caller.trigger === "api" ? { type: "app", id: caller.by.slice(4), name: caller.by } : { type: "user", id: caller.by, name: caller.by }, action: "pipeline.run", target: { type: "pipeline", id: pipeline.id }, details: { runId, test: !!body.testRows } });
      if (body.waitSeconds) {
        const finished = await Promise.race([svc.wait(runId), new Promise<null>((r) => setTimeout(() => r(null), body.waitSeconds! * 1000))]);
        if (finished) return { runId, status: finished.status, error: finished.error };
      }
      return { runId, status: "running" };
    });

    app.get("/api/v1/pipelines/:id/runs", async (req) => {
      requirePermission(req, "pipelines.view");
      const svc = need();
      const p = svc.store.require((req.params as { id: string }).id);
      const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }).parse(req.query);
      return svc.history().list(p.id, limit);
    });

    app.get("/api/v1/pipeline-runs/:runId", async (req) => {
      const p = req.principal;
      if (p?.kind !== "app" || !p.app.scopes.includes("pipelines:run")) requirePermission(req, "pipelines.view");
      return need().engine.runs.require((req.params as { runId: string }).runId);
    });

    app.get("/api/v1/pipeline-runs/:runId/logs", async (req) => {
      requirePermission(req, "pipelines.view");
      const { step } = z.object({ step: z.string().optional() }).parse(req.query);
      return need().engine.logs((req.params as { runId: string }).runId, step);
    });

    app.get("/api/v1/pipeline-runs/:runId/steps/:stepId/preview", async (req) => {
      const user = requirePermission(req, "pipelines.view");
      if (!authorize(user, "app.data.read")) throw NexusError.forbidden("Previewing data needs permission to read data.");
      const { runId, stepId } = req.params as { runId: string; stepId: string };
      const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
      return need().engine.preview(runId, stepId, q);
    });

    app.get("/api/v1/pipeline-runs/:runId/reproducibility", async (req) => {
      requirePermission(req, "pipelines.view");
      return need().engine.reproducibility((req.params as { runId: string }).runId);
    });

    app.post("/api/v1/pipeline-runs/:runId/cancel", async (req) => {
      const user = requirePermission(req, "pipelines.run");
      const runId = (req.params as { runId: string }).runId;
      if (!need().engine.cancel(runId)) throw NexusError.conflict("This run isn't running.");
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "pipeline.cancel", target: { type: "pipeline_run", id: runId } });
      return { ok: true };
    });

    app.post("/api/v1/pipeline-runs/:runId/resume", async (req) => {
      const user = requirePermission(req, "pipelines.run");
      const svc = need();
      const prev = svc.engine.runs.require((req.params as { runId: string }).runId);
      const p = svc.store.require(prev.pipelineId);
      const { runId } = svc.engine.start(p, { resumeFrom: prev.id, requestedBy: user.id });
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "pipeline.resume", target: { type: "pipeline", id: p.id }, details: { runId, from: prev.id } });
      return { runId, status: "running" };
    });

    // -------------------------------------------------------------- secrets

    app.get("/api/v1/pipelines/secrets", async (req) => {
      requirePermission(req, "pipelines.edit");
      return need().secretNames();
    });

    app.put("/api/v1/pipelines/secrets/:name", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const name = (req.params as { name: string }).name;
      const { value } = z.object({ value: z.string().min(1).max(20_000) }).parse(req.body);
      need().setSecret(name, value);
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "pipeline.secret.set", target: { type: "pipeline_secret", id: name } });
      return { ok: true };
    });

    app.delete("/api/v1/pipelines/secrets/:name", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const name = (req.params as { name: string }).name;
      if (!need().deleteSecret(name)) throw NexusError.notFound("Secret");
      ctx.audit.record({ actor: { type: "user", id: user.id, name: user.displayName }, action: "pipeline.secret.delete", target: { type: "pipeline_secret", id: name } });
      return { ok: true };
    });

    // -------------------------------------------------------------- webhooks

    app.post("/api/v1/pipelines/:id/webhook", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const hook = svc.issueWebhook((req.params as { id: string }).id);
      audit(user, "pipeline.webhook.issue", svc.store.require((req.params as { id: string }).id).id);
      return hook;
    });

    app.delete("/api/v1/pipelines/:id/webhook", async (req) => {
      const user = requirePermission(req, "pipelines.edit");
      const svc = need();
      const p = svc.store.require((req.params as { id: string }).id);
      svc.revokeWebhook(p.id);
      audit(user, "pipeline.webhook.revoke", p.id);
      return { ok: true };
    });

    /**
     * Webhook trigger for other systems. Authenticated by the pipeline's own webhook secret
     * (X-Nexus-Webhook-Token header, or ?token= for services that can only call a URL).
     * Parameters come from a "params" object in the JSON body, or from matching top-level fields.
     */
    app.post("/api/v1/hooks/pipelines/:slug", async (req, reply) => {
      const svc = need();
      const p = svc.store.get((req.params as { slug: string }).slug);
      const token = String(req.headers["x-nexus-webhook-token"] ?? (req.query as { token?: string }).token ?? "");
      // Same answer for an unknown pipeline and a wrong secret: nothing to probe.
      if (!p || !svc.verifyWebhook(p, token)) return reply.code(401).send({ error: { code: "unauthorized", message: "Unknown pipeline or wrong webhook secret.", problem: null } });
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const declared = new Set(p.definition.params.map((d) => d.name));
      const params =
        body.params && typeof body.params === "object" && !Array.isArray(body.params)
          ? (body.params as Record<string, unknown>)
          : Object.fromEntries(Object.entries(body).filter(([k]) => declared.has(k)));
      const { runId } = svc.run(p.id, { params, trigger: "api", requestedBy: "webhook" });
      ctx.audit.record({ actor: { type: "system", id: "webhook", name: "Webhook" }, action: "pipeline.run", target: { type: "pipeline", id: p.id }, details: { runId, via: "webhook", ip: req.clientIp } });
      return reply.code(202).send({ runId, status: "running" });
    });
  };
}
